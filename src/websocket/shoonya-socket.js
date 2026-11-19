import WebSocket from 'ws';
import { fileURLToPath } from 'url';
import { connectToDatabase } from '../../db/mongodb.js';
import { getActiveShoonyaToken } from '../../services/shoonya-api-login-service.js';
import { getShoonyaCredentialsOrEnv } from '../../utilities/config-cache.js';
import { getTodayDate } from '../../workers/worker-helpers.js';
import { getBrokerAdapter } from '../brokers/broker-factory.js';
import { OMS_CONFIG } from '../config/oms-config.js';
import { logger } from '../../utilities/logger.js';
import { accountTradeFilter } from '../config/accounts.js';

/**
 * Shoonya (Noren) WebSocket — Order Updates + Price Feed + Exit Engine
 *
 * Noren only allows ONE websocket connection per session — order updates
 * and the touchline price feed both arrive on it, so this file replaces
 * fyers-socket.js / angel-socket.js as the price source AND keeps the
 * existing order-update handling, instead of opening a second connection.
 *
 * Price feed  = Shoonya Noren WS touchline ('t':'t' subscribe)
 * Order exec  = Shoonya (via ShoonyaAdapter)
 *
 * Noren touchline quirk: the FIRST message per token ('t':'tk') is a full
 * snapshot; every message AFTER that ('t':'tf') is a DELTA — 'lp' (last
 * price) is only included when it actually changed. We only act on ticks
 * that carry a fresh 'lp'.
 */

const COLLECTION_TRADES = 'trades';

let ws = null;
let heartbeatInterval = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;

// BUG THIS FIXES: a plain dropped websocket (network blip, Shoonya
// restarting the socket server) should retry fast — that's what
// reconnectDelay/MAX_RECONNECT_DELAY above are for. But when the
// connection attempt fails because getActiveShoonyaToken() itself
// couldn't log in, that already means a full ~7-8 minute, 10-attempt
// retry marathon (see shoonya-api-login-service.js) just ran and failed.
// Retrying THAT again after only 1-30 seconds just starts another full
// 7-8 minute marathon immediately — so during any Shoonya outage longer
// than a few minutes (common during their pre-open maintenance window),
// the bot ends up running back-to-back full marathons and emailing a
// fresh "Login Failed" alert every time one exhausts, instead of one
// alert for the whole outage. A login failure gets a much longer,
// fixed cooldown before the next attempt — the outage isn't going to
// resolve itself in the next few seconds, and we already have an email
// on record for it.
const LOGIN_FAILURE_RECONNECT_DELAY_MS = 5 * 60 * 1000; // 5 minutes

/** "EXCHANGE|token" (string) -> trade document (mutable in-memory copy) */
const watchedTrades = new Map();

/** Prevent double-exit races */
const exitedTradeIds = new Set();

/** Debounce trailing SL broker+DB writes (tradeId -> timestamp) */
const lastTrailUpdate = new Map();
const TRAIL_DEBOUNCE_MS = 2000;

// --- Order update handling (unchanged) -----------------------------------

export async function handleOrderUpdate(data) {
    const db = await connectToDatabase();
    const orderId = data.norenordno;
    const status = data.status;

    logger.info(`[Shoonya WS] Processing order ${orderId} status: ${status}`);

    if (status === 'COMPLETE') {
        const updateResult = await db.collection('trades')
            .updateOne(
                { entryOrderId: orderId },
                {
                    $set: {
                        status: 'OPEN',
                        filledPrice: Number(data.avgprc || data.flprc || 0),
                        filledQty: Number(data.fillshares || data.flqty || 0),
                        openedAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString()
                    }
                }
            );

        if (updateResult.modifiedCount > 0) {
            logger.info(`[Shoonya WS] Trade status updated to OPEN for order ${orderId}`);
        } else {
            logger.debug(`[Shoonya WS] Order ${orderId} not found in trades or already updated.`);
        }
    }

    if (status === 'REJECTED') {
        const updateResult = await db.collection('trades')
            .updateOne(
                { entryOrderId: orderId },
                {
                    $set: {
                        status: 'FAILED',
                        rejectionReason: data.rejreason || 'Order rejected by broker',
                        updatedAt: new Date().toISOString()
                    }
                }
            );

        if (updateResult.modifiedCount > 0) {
            logger.info(`[Shoonya WS] Trade status updated to FAILED (REJECTED) for order ${orderId}`);
        }
    }

    if (status === 'CANCELED' || status === 'CANCELLED') {
        const updateResult = await db.collection('trades')
            .updateOne(
                { entryOrderId: orderId },
                {
                    $set: {
                        status: 'FAILED',
                        rejectionReason: 'Order was canceled by user or broker',
                        updatedAt: new Date().toISOString()
                    }
                }
            );

        if (updateResult.modifiedCount > 0) {
            logger.info(`[Shoonya WS] Trade status updated to FAILED (CANCELED) for order ${orderId}`);
        }
    }
}

// --- Load ORDER_PLACED trades to watch for exit ---------------------------

function buildScripKey(trade) {
    // Noren wants "EXCHANGE|token", e.g. "NSE|22"
    const exchange = trade.exchange ?? 'NSE';
    return `${exchange}|${trade.token}`;
}

async function loadOpenTrades(db) {
    const today = getTodayDate();

    const trades = await db.collection(COLLECTION_TRADES).find({
        status: 'ORDER_PLACED',
        createdAt: { $gte: `${today}T00:00:00` },
        // This socket is logged in as ACC1 only, so it must never exit ACC2/ACC3's trades (that would
        // open an opposite position on ACC1). Those are monitored/exited by fyers-socket.js.
        ...accountTradeFilter('ACC1')
    }).sort({ createdAt: -1 }).toArray();

    watchedTrades.clear();

    for (const trade of trades) {
        if (!trade.token) {
            logger.warn(`[Shoonya WS] Trade ${trade._id} missing token - skipped (touchline needs the numeric scrip token, not the symbol name)`);
            continue;
        }

        trade.currentSL = trade.currentSL ?? trade.stopLossPrice;
        trade.highestPrice = trade.highestPrice ?? trade.entryPrice;
        trade.lowestPrice = trade.lowestPrice ?? trade.entryPrice;
        trade.trailingPercent = trade.trailingPercent ?? OMS_CONFIG.TRAILING_PERCENT;

        const scripKey = buildScripKey(trade);
        trade._scripKey = scripKey;

        watchedTrades.set(scripKey, trade);
        logger.info(
            `[Shoonya WS] Watching ${trade.symbol}` +
            ` | key:${scripKey} | side:${trade.side}` +
            ` | entry:${trade.entryPrice} | target:${trade.targetPrice}` +
            ` | currentSL:${trade.currentSL} | trail:${trade.trailingPercent}%`
        );
    }

    logger.info(`[Shoonya WS] Loaded ${watchedTrades.size} ORDER_PLACED trade(s) for touchline watch`);
    return [...watchedTrades.keys()];
}

function getBroker() {
    return getBrokerAdapter(OMS_CONFIG.BROKER);
}

// --- Place exit order on Shoonya ------------------------------------------

async function placeExitOrder(trade, reason, ltp) {
    const tradeId = trade._id.toString();
    if (exitedTradeIds.has(tradeId)) return;
    exitedTradeIds.add(tradeId);

    logger.info(`[Shoonya WS] ${reason} — ${trade.symbol} LTP:${ltp} | placing exit`);

    try {
        const broker = getBroker();
        const exitSide = trade.side === 'BUY' ? 'SELL' : 'BUY';

        const order = await broker.placeExitMarketOrder({
            symbol: trade.symbol,
            side: exitSide,
            quantity: trade.quantity,
            price: ltp,
            exchange: trade.exchange ?? 'NSE',
            productType: trade.productType ?? 'I',
        });

        if (!order.success) {
            logger.error(`[Shoonya WS] Exit order failed for ${trade.symbol}: ${order.error}`);
            exitedTradeIds.delete(tradeId);
            return;
        }

        logger.info(`[Shoonya WS] Exit placed for ${trade.symbol} — orderId:${order.brokerOrderId}`);

        const pnl = trade.side === 'BUY'
            ? (ltp - trade.entryPrice) * trade.quantity
            : (trade.entryPrice - ltp) * trade.quantity;

        const db = await connectToDatabase();
        await db.collection(COLLECTION_TRADES).updateOne(
            { _id: trade._id },
            {
                $set: {
                    status: 'CLOSED',
                    exitOrderId: order.brokerOrderId,
                    exitPrice: ltp,
                    exitReason: reason,
                    pnl: parseFloat(pnl.toFixed(2)),
                    closedAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                }
            }
        );

        logger.info(`[Shoonya WS] DB closed ${trade.symbol} | reason:${reason} | PnL:${pnl.toFixed(2)}`);

        watchedTrades.delete(trade._scripKey);
        unsubscribeKey(trade._scripKey);

    } catch (err) {
        logger.error(`[Shoonya WS] placeExitOrder exception for ${trade.symbol}:`, err.message);
        exitedTradeIds.delete(tradeId);
    }
}

// --- Trailing Stop Loss -----------------------------------------------------

async function handleTrailingSL(trade, ltp) {
    const tradeId = trade._id.toString();
    const trailPct = (trade.trailingPercent ?? OMS_CONFIG.TRAILING_PERCENT) / 100;

    if (trade.side === 'BUY') {
        if (ltp > trade.highestPrice) trade.highestPrice = ltp;
    } else {
        if (ltp < trade.lowestPrice) trade.lowestPrice = ltp;
    }

    const extreme = trade.side === 'BUY' ? trade.highestPrice : trade.lowestPrice;
    const candidate = trade.side === 'BUY'
        ? parseFloat((extreme * (1 - trailPct)).toFixed(2))
        : parseFloat((extreme * (1 + trailPct)).toFixed(2));

    const improves = trade.side === 'BUY'
        ? candidate > trade.currentSL
        : candidate < trade.currentSL;

    if (!improves) return;

    const lastUpdate = lastTrailUpdate.get(tradeId) ?? 0;
    if (Date.now() - lastUpdate < TRAIL_DEBOUNCE_MS) return;

    const newSL = candidate;
    logger.info(`[Shoonya WS] TRAILING SL — ${trade.symbol} | extreme:${extreme} | oldSL:${trade.currentSL} | newSL:${newSL}`);

    trade.currentSL = newSL;
    lastTrailUpdate.set(tradeId, Date.now());

    if (trade.slBrokerOrderId) {
        try {
            const broker = getBroker();
            const slLimitBuffer = parseFloat(
                (newSL * (trade.side === 'BUY' ? 0.995 : 1.005)).toFixed(2)
            );
            const result = await broker.modifySLOrder({
                brokerOrderId: trade.slBrokerOrderId,
                symbol: trade.symbol,
                triggerPrice: newSL,
                price: slLimitBuffer,
                quantity: trade.quantity,
            });
            if (!result.success) {
                logger.warn(`[Shoonya WS] modifySLOrder failed for ${trade.symbol}: ${result.error}`);
            } else {
                logger.info(`[Shoonya WS] Broker SL modified — ${trade.symbol} newSL:${newSL}`);
            }
        } catch (err) {
            logger.warn(`[Shoonya WS] modifySLOrder exception for ${trade.symbol}:`, err.message);
        }
    }

    try {
        const db = await connectToDatabase();
        const dbUpdate = { currentSL: newSL, updatedAt: new Date().toISOString() };
        if (trade.side === 'BUY') dbUpdate.highestPrice = trade.highestPrice;
        else dbUpdate.lowestPrice = trade.lowestPrice;
        await db.collection(COLLECTION_TRADES).updateOne({ _id: trade._id }, { $set: dbUpdate });
        logger.info(`[Shoonya WS] DB updated — ${trade.symbol} currentSL:${newSL}`);
    } catch (err) {
        logger.warn(`[Shoonya WS] DB trail update failed for ${trade.symbol}:`, err.message);
    }
}

// --- Handle incoming touchline tick ----------------------------------------

async function handleTouchlineTick(message) {
    try {
        const scripKey = `${message.e}|${message.tk}`;
        const trade = watchedTrades.get(scripKey);
        if (!trade) return;

        // 'lp' is absent on 'tf' deltas that didn't change price — nothing to act on.
        if (message.lp === undefined) return;
        const ltp = parseFloat(message.lp);
        if (!ltp || ltp <= 0) return;

        const targetHit = trade.side === 'BUY'
            ? (trade.targetPrice > trade.entryPrice && ltp >= trade.targetPrice)
            : (trade.targetPrice < trade.entryPrice && ltp <= trade.targetPrice);

        if (targetHit) {
            logger.info(`[Shoonya WS] TARGET HIT — ${trade.symbol} LTP:${ltp} target:${trade.targetPrice}`);
            await placeExitOrder(trade, 'TARGET_HIT', ltp);
            return;
        }

        const slHit = trade.side === 'BUY'
            ? (trade.currentSL < trade.entryPrice && ltp <= trade.currentSL)
            : (trade.currentSL > trade.entryPrice && ltp >= trade.currentSL);

        if (slHit) {
            logger.info(`[Shoonya WS] SL HIT — ${trade.symbol} LTP:${ltp} currentSL:${trade.currentSL}`);
            await placeExitOrder(trade, 'SL_HIT', ltp);
            return;
        }

        await handleTrailingSL(trade, ltp);

    } catch (err) {
        logger.error('[Shoonya WS] Touchline tick handler error:', err.message);
    }
}

// --- Subscribe / Unsubscribe (Noren touchline) ------------------------------

function subscribeKeys(keys) {
    if (!ws || ws.readyState !== WebSocket.OPEN || !keys.length) return;
    // Noren wants tokens joined by '#': {"t":"t","k":"NSE|22#NSE|3045"}
    ws.send(JSON.stringify({ t: 't', k: keys.join('#') }));
    logger.info(`[Shoonya WS] Subscribed touchline: ${keys.join(', ')}`);
}

function unsubscribeKey(key) {
    if (!ws || ws.readyState !== WebSocket.OPEN || !key) return;
    ws.send(JSON.stringify({ t: 'u', k: key }));
    logger.info(`[Shoonya WS] Unsubscribed: ${key}`);
}

/**
 * Reload ORDER_PLACED trades and (re)subscribe any new ones. Called on
 * auth success, and safe to call again periodically if you want newly
 * placed trades picked up without a full reconnect.
 */
export async function refreshWatchedTrades() {
    const db = await connectToDatabase();
    const keys = await loadOpenTrades(db);
    subscribeKeys(keys);
    return keys;
}

/**
 * Connects to the Shoonya WebSocket endpoint
 */
export async function connectShoonyaWebSocket() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    try {
        const creds = getShoonyaCredentialsOrEnv();
        let token;
        try {
            token = await getActiveShoonyaToken();
        } catch (loginErr) {
            // The full login retry marathon already ran and failed (and
            // already sent its own alert email) — don't hammer it again
            // in a few seconds. Wait the longer, fixed cooldown instead.
            logger.error('[Shoonya WS] Login failed after full retry marathon:', loginErr.message);
            reconnectDelay = LOGIN_FAILURE_RECONNECT_DELAY_MS;
            scheduleReconnect();
            return;
        }

        if (!creds || !creds.uid || !token) {
            logger.error('[Shoonya WS] Credentials or token missing. Aborting WebSocket connection.');
            scheduleReconnect();
            return;
        }

        logger.info('[Shoonya WS] Connecting to Shoonya WebSocket (wss://api.shoonya.com/NorenWSAPI/)...');
        ws = new WebSocket('wss://api.shoonya.com/NorenWSAPI/');

        ws.on('open', () => {
            logger.info('[Shoonya WS] WebSocket channel opened. Sending connection payload...');
            reconnectDelay = 1000;

            const connectMsg = {
                t: 'a',
                uid: creds.uid,
                actid: creds.uid,
                susertoken: token,
                source: 'API'
            };

            ws.send(JSON.stringify(connectMsg));

            heartbeatInterval = setInterval(() => {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ t: 'h' }));
                }
            }, 30000);
        });

        ws.on('message', async (messageStr) => {
            try {
                const message = JSON.parse(messageStr.toString());

                if (message.t === 'h') return; // heartbeat ack

                // Auth ack — subscribe touchline for any trades we need to watch
                if (message.t === 'a' || (message.t === 'ak' && message.stat === 'Ok')) {
                    logger.info('[Shoonya WS] WebSocket authentication verified successfully.');
                    const keys = await refreshWatchedTrades();
                    if (!keys.length) {
                        logger.info('[Shoonya WS] No ORDER_PLACED trades with a token to watch yet.');
                    }
                    return;
                }

                // Order update message
                if (message.t === 'om') {
                    await handleOrderUpdate(message);
                    return;
                }

                // Touchline: 'tk' = snapshot ack on subscribe, 'tf' = delta update
                if (message.t === 'tk' || message.t === 'tf') {
                    await handleTouchlineTick(message);
                    return;
                }
            } catch (err) {
                logger.error('[Shoonya WS] Error processing message payload:', err.message);
            }
        });

        ws.on('close', (code, reason) => {
            logger.warn(`[Shoonya WS] WebSocket closed (Code: ${code}, Reason: ${reason || 'None'})`);
            cleanup();
            scheduleReconnect();
        });

        ws.on('error', (err) => {
            logger.error('[Shoonya WS] WebSocket experienced an error:', err.message);
            cleanup();
            scheduleReconnect();
        });

    } catch (error) {
        logger.error('[Shoonya WS] WebSocket connection setup failed:', error.message);
        cleanup();
        scheduleReconnect();
    }
}

function cleanup() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
    if (ws) {
        ws.removeAllListeners();
        try {
            ws.close();
        } catch (e) {
            // Ignore close exceptions
        }
        ws = null;
    }
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    logger.info(`[Shoonya WS] Scheduling connection retry in ${reconnectDelay}ms...`);

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
        connectShoonyaWebSocket();
    }, reconnectDelay);
}

// Self-run when executed directly (node src/websocket/shoonya-socket.js)
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
    logger.info('[Shoonya WS] Executing Shoonya WebSocket client directly...');
    connectShoonyaWebSocket();
}