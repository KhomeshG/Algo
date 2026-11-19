/**
 * MW Volume Surge Worker — WebSocket edition
 * ============================================================================
 * Same signal logic as volume-surge-worker.js (EMA(21) volume surge on the
 * 09:15-09:18 3-min candle), but gets TODAY's candle from a single Fyers
 * WebSocket subscription instead of one REST History call per symbol.
 *
 * WHY: the REST version needs 204 separate /history calls. Fyers caps
 * requests at 10/sec and 200/min, so 204 symbols can never complete in
 * under ~61s no matter how the calls are paced (204 > 200/min ceiling).
 * A single WebSocket connection has no such per-symbol request cost —
 * one subscribe() call streams live ticks for all 204 symbols on one
 * pipe, and the candle is built in memory as ticks arrive.
 *
 * HOW THE 3-MIN CANDLE IS BUILT FROM TICKS:
 *   - OHLC: track first/last/min/max of `ltp` across ticks received
 *     between 09:15:00 and 09:18:00 IST for each symbol.
 *   - Volume: Fyers ticks carry `vol_traded_today`, a CUMULATIVE total
 *     for the day — not a per-tick trade size. So candle volume is:
 *         volAtWindowEnd - volAtWindowStart
 *     Both snapshots are taken by scheduled timers (not per-tick logic),
 *     so they don't depend on a tick landing exactly on the boundary —
 *     each timer just records the latest known cumulative volume for
 *     every symbol at that instant.
 *
 * IMPORTANT LIMITATION: unlike the REST worker, this can only produce
 * TODAY's candle — it has no --date backfill option, since it depends on
 * being connected and listening while the market actually prints ticks.
 * It must be started before 09:15 IST to catch the full window. Use
 * volume-surge-worker.js for backfilling a past date.
 * ============================================================================
 */

import { connectToDatabase } from "../../db/mongodb.js";
import fnoMasterLoader from '../../utilities/fno-master-loader.js';
import { getFyersSymbol } from '../../utilities/symbol-mapper.js';
import { isTradingDay } from '../../utilities/trading-days-loader.js';
import { fyersDataSocket } from 'fyers-api-v3';

const COLLECTION_CANDLES = 'fno_candles';            // read-only here — previous day's 20 candles
const COLLECTION_SURGE = 'mw_volume_surge_patterns';  // where matches get stored

const PREVIOUS_DAY_CANDLE_COUNT = 20;  // last 20 candles from previous day
const EMA_LENGTH = 21;                 // 20 previous-day + 1 today's = 21
const BUY_MULTIPLIER = 5;
const SELL_MULTIPLIER = 3;

const WINDOW_START_TIME = '09:15';
const WINDOW_END_TIME = '09:18';

// Extra time after the window closes before we evaluate/write, so any
// slightly-delayed ticks for the last second of the window still land
// before we snapshot volume and read the candle out of memory.
const SETTLE_BUFFER_MS = 3_000;

function toEpoch(timeStr) {
    return new Date(timeStr).getTime();
}

function getTodayDateIST() {
    const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    return ist.toISOString().split('T')[0];
}

const TARGET_DATE = getTodayDateIST();

function getISTTimestamp(dateStr, timeStr) {
    return new Date(`${dateStr}T${timeStr}:00+05:30`).getTime();
}

// ─── Token (same pattern as src/websocket/fyers-socket.js) ────────────────
function buildFyersTokenString() {

    const appId = process.env.FYERS_APP_ID;
    const accessToken = process.env.FYERS_ACCESS_TOKEN;

    if (!appId) throw new Error('Missing FYERS_APP_ID in .env');
    if (!accessToken) throw new Error('Missing FYERS_ACCESS_TOKEN in .env');

    if (accessToken.split('.').length !== 3) {
        throw new Error('FYERS_ACCESS_TOKEN is not a valid JWT — should have 3 dot-separated parts');
    }

    try {
        const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64').toString());
        const nowSec = Math.floor(Date.now() / 1000);
        if (payload.exp && payload.exp < nowSec) {
            const expiredAt = new Date(payload.exp * 1000)
                .toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
            throw new Error(`FYERS_ACCESS_TOKEN expired at ${expiredAt} IST. Re-run generate-fyers-token.js`);
        }
    } catch (e) {
        if (e.message.includes('expired')) throw e;
        console.warn('[MW Volume Surge WS] Could not decode token payload to check expiry:', e.message);
    }

    return `${appId}:${accessToken}`;
}

// Direct port of ta.ema(volume, 21) — identical to the REST worker.
function computeEma(values, length) {

    if (values.length < length) return null;

    const k = 2 / (length + 1);

    let ema =
        values.slice(0, length).reduce((a, b) => a + b, 0) / length;

    for (let i = length; i < values.length; i++) {
        ema = values[i] * k + ema * (1 - k);
    }

    return ema;
}

// isBuy  = close > open  and volume >= 5 * ema_vol
// isSell = close < open  and volume >= 3 * ema_vol
function evaluateCandle(candles) {

    const volumes = candles.map(c => c.volume);
    const emaVol = computeEma(volumes, EMA_LENGTH);

    if (emaVol == null) return null;

    const last = candles[candles.length - 1];

    const isGreen = last.close > last.open;
    const isRed = last.close < last.open;

    const ratio = emaVol > 0 ? last.volume / emaVol : 0;

    const isBuy = isGreen && last.volume >= BUY_MULTIPLIER * emaVol;
    const isSell = isRed && last.volume >= SELL_MULTIPLIER * emaVol;

    if (!isBuy && !isSell) return null;

    return {
        signal: isBuy ? 'BUY' : 'SELL',
        candleTime: last.time,
        open: last.open,
        high: last.high,
        low: last.low,
        close: last.close,
        volume: last.volume,
        emaVolume: emaVol,
        ratio
    };
}

// Same bulk previous-day-history query as the REST worker.
async function getPreviousDayCandlesBulk(db, symbols, beforeDateStr) {

    const idRows = await db.collection(COLLECTION_CANDLES).aggregate([
        { $match: { symbol: { $in: symbols }, date: { $lt: beforeDateStr } } },
        { $project: { _id: 1, symbol: 1, date: 1 } },
        { $sort: { date: -1 } },
        { $group: { _id: '$symbol', docId: { $first: '$_id' } } }
    ]).toArray();

    const map = new Map();

    if (idRows.length === 0) return map;

    const winningIds = idRows.map(r => r.docId);

    const fullDocs = await db.collection(COLLECTION_CANDLES)
        .find({ _id: { $in: winningIds } })
        .toArray();

    const docsById = new Map(fullDocs.map(d => [String(d._id), d]));

    for (const row of idRows) {

        const doc = docsById.get(String(row.docId));
        const candles = doc?.candles;

        if (!Array.isArray(candles) || candles.length === 0) continue;

        const sorted = [...candles].sort(
            (a, b) => toEpoch(a.time) - toEpoch(b.time)
        );

        map.set(row._id, sorted.slice(-PREVIOUS_DAY_CANDLE_COUNT));
    }

    return map;
}

function buildSurgeDoc(stock, dateStr, result) {

    const { symbol, token } = stock;

    return {
        symbol,
        token,
        exchange: 'NSE',
        date: dateStr,
        candleTime: result.candleTime,
        open: result.open,
        high: result.high,
        low: result.low,
        close: result.close,
        volume: result.volume,
        emaVolume: result.emaVolume,
        ratio: result.ratio,
        signal: result.signal,
        priceAtSignal: result.close,
        createdAt: new Date().toISOString()
    };
}

// ─── Live tick state ────────────────────────────────────────────────────
// fyersSymbol -> latest known cumulative vol_traded_today (updated on
// EVERY tick regardless of window, so boundary snapshots are accurate)
const runningVolume = new Map();

// fyersSymbol -> { open, high, low, close } — only touched by ticks whose
// receipt time falls inside [WINDOW_START_MS, WINDOW_END_MS)
const liveCandle = new Map();

// fyersSymbol -> cumulative volume value snapshotted exactly at window
// start / end. Volume for the candle = volAtEnd - volAtStart.
let volAtWindowStart = new Map();
let volAtWindowEnd = new Map();

function handleTick(message) {

    if (!message || typeof message !== 'object') return;

    const msgType = message.type;
    if (msgType === 'cn' || msgType === 'sub') return;
    if (msgType !== 'sf' && msgType !== 'if') return;

    const symbol = message.symbol;
    const ltp = message.ltp;
    const cumulativeVol = message.vol_traded_today;

    if (!symbol || typeof ltp !== 'number' || ltp <= 0) return;

    if (typeof cumulativeVol === 'number') {
        runningVolume.set(symbol, cumulativeVol);
    }

    const now = Date.now();

    if (now >= global.__WINDOW_START_MS && now < global.__WINDOW_END_MS) {

        const existing = liveCandle.get(symbol);

        if (!existing) {
            liveCandle.set(symbol, { open: ltp, high: ltp, low: ltp, close: ltp });
        } else {
            existing.high = Math.max(existing.high, ltp);
            existing.low = Math.min(existing.low, ltp);
            existing.close = ltp;
        }
    }
}

function snapshotVolume(targetMap, label) {

    for (const [symbol, vol] of runningVolume.entries()) {
        targetMap.set(symbol, vol);
    }

    console.log(
        `[MW Volume Surge WS] Volume snapshot taken (${label}) — ${targetMap.size} symbols known`
    );
}

async function evaluateAndWrite(db, stocks, previousDayMap) {

    const surgeDocs = [];

    for (const stock of stocks) {

        const fyersSymbol = getFyersSymbol(stock);

        const previousDayCandles = previousDayMap.get(stock.symbol);

        if (!previousDayCandles || previousDayCandles.length < PREVIOUS_DAY_CANDLE_COUNT) {
            console.log(
                `[MW Volume Surge WS] ${stock.symbol} - not enough previous day candles, skipping`
            );
            continue;
        }

        const candle = liveCandle.get(fyersSymbol);

        if (!candle) {
            console.log(
                `[MW Volume Surge WS] ${stock.symbol} - no ticks received in the ${WINDOW_START_TIME} window, skipping`
            );
            continue;
        }

        const volStart = volAtWindowStart.get(fyersSymbol);
        const volEnd = volAtWindowEnd.get(fyersSymbol);

        if (typeof volStart !== 'number' || typeof volEnd !== 'number') {
            console.log(
                `[MW Volume Surge WS] ${stock.symbol} - missing volume snapshot, skipping`
            );
            continue;
        }

        const candleVolume = Math.max(0, volEnd - volStart);

        const todayCandle = {
            time: new Date(global.__WINDOW_START_MS).toISOString(),
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candleVolume
        };

        const combinedCandles = [...previousDayCandles, todayCandle];

        const result = evaluateCandle(combinedCandles);

        if (!result) continue;

        surgeDocs.push({ stock, result });

        console.log(
            `[MW Volume Surge WS] ${stock.symbol} ${result.signal} @ ${result.candleTime} (ratio ${result.ratio.toFixed(2)}x)`
        );
    }

    if (surgeDocs.length > 0) {

        const ops = surgeDocs.map(({ stock, result }) => ({
            updateOne: {
                filter: { symbol: stock.symbol, candleTime: result.candleTime },
                update: { $setOnInsert: buildSurgeDoc(stock, TARGET_DATE, result) },
                upsert: true
            }
        }));

        await db.collection(COLLECTION_SURGE).bulkWrite(ops);
    }

    console.log(
        `[MW Volume Surge WS] Completed — ${surgeDocs.length} signal(s) found`
    );
}

async function main() {

    const startTime = Date.now();

    console.log('[MW Volume Surge WS] Starting...');

    const windowStartMs = getISTTimestamp(TARGET_DATE, WINDOW_START_TIME);
    const windowEndMs = getISTTimestamp(TARGET_DATE, WINDOW_END_TIME);

    // Stashed on `global` so handleTick (a plain function, not a closure
    // over main()) can read them without extra plumbing.
    global.__WINDOW_START_MS = windowStartMs;
    global.__WINDOW_END_MS = windowEndMs;

    const now = Date.now();

    if (now >= windowEndMs) {
        console.error(
            `[MW Volume Surge WS] Too late — the ${WINDOW_START_TIME}-${WINDOW_END_TIME} window` +
            ` already closed. This worker only captures TODAY's window live;` +
            ` use volume-surge-worker.js --date=${TARGET_DATE} to backfill instead.`
        );
        process.exit(1);
    }

    const db = await connectToDatabase();

    const stocks = fnoMasterLoader.getFNOStocks();

    console.log(`[MW Volume Surge WS] Checking ${stocks.length} stocks`);

    const symbols = stocks.map(s => s.symbol);
    const fyersSymbols = stocks.map(s => getFyersSymbol(s));

    // Previous-day history can be fetched immediately — doesn't depend on
    // the live window at all.
    const previousDayMap = await getPreviousDayCandlesBulk(db, symbols, TARGET_DATE);

    const tokenString = buildFyersTokenString();

    console.log('[MW Volume Surge WS] Connecting to Fyers data socket...');

    const socket = new fyersDataSocket(tokenString);

    socket.on('connect', () => {

        console.log('[MW Volume Surge WS] Connected — subscribing to all symbols');

        // mode 1 (lite) already includes ltp + vol_traded_today, which is
        // all we need — no reason to pay for full-depth mode.
        socket.subscribe(fyersSymbols, false, 1);

        const msUntilStart = windowStartMs - Date.now();
        const msUntilEnd = windowEndMs - Date.now();

        if (msUntilStart > 0) {
            setTimeout(() => snapshotVolume(volAtWindowStart, 'window start'), msUntilStart);
        } else {
            // Already inside (or just before) the window — best available
            // baseline is "whatever we know right now".
            snapshotVolume(volAtWindowStart, 'window start (late)');
        }

        setTimeout(async () => {

            snapshotVolume(volAtWindowEnd, 'window end');

            // Let a few straggling ticks land before reading the candle out.
            await new Promise(r => setTimeout(r, SETTLE_BUFFER_MS));

            try {
                await evaluateAndWrite(db, stocks, previousDayMap);
            } catch (err) {
                console.error('[MW Volume Surge WS] Evaluate/write error:', err);
            } finally {

                try { socket.unsubscribe(fyersSymbols, false, 1); } catch { /* ignore */ }
                try { socket.close(); } catch { /* ignore */ }

                const elapsedMs = Date.now() - startTime;
                console.log(
                    `[MW Volume Surge WS] Finished in ${(elapsedMs / 1000).toFixed(2)}s`
                );

                process.exit(0);
            }

        }, Math.max(0, msUntilEnd));
    });

    const onMessage = (msg) => handleTick(msg);
    socket.on('message', onMessage);
    socket.on('data', onMessage);

    socket.on('error', (err) => {
        const raw = typeof err === 'string' ? err : (err?.message ?? String(err));
        console.error(`[MW Volume Surge WS] Socket error: ${raw}`);
    });

    socket.on('close', (closeInfo) => {
        const code = typeof closeInfo === 'number' ? closeInfo : closeInfo?.code;
        console.warn(`[MW Volume Surge WS] Socket closed (${code})`);
    });

    socket.autoreconnect(10);
    socket.connect();
}

main();