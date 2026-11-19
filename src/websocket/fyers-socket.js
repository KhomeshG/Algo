/**
 * Fyers WebSocket — Price Feed + Exit Engine
 *
 * Price feed  = Fyers Data Socket (fyersDataSocket)
 * Order exec  = OMS_CONFIG.BROKER for Nine-Fifteen/MW (Shoonya by default),
 *               OMS_CONFIG.FIRST15.BROKER for FIRST15_ORB trades — see
 *               getBroker(trade) below.
 *
 * Nine-Fifteen / MW pattern (single fixed target + fixed SL):
 *   1. TARGET_HIT → place LMT exit
 *   2. SL_HIT     → place LMT exit (uses trade.currentSL / stopLossPrice)
 *   No trailing SL — target and stop-loss are fixed at trade creation.
 *
 * FIRST15_ORB (single entry order, dual target — see handleFirst15Tick()):
 *   1. target1 hit → exit FIRST15.TARGET1_EXIT_PERCENT % of quantity (dynamic,
 *      default 70%), walk currentSL up to entryPrice (breakeven), keep
 *      watching the rest (the "runner").
 *   2. After target1: the runner's SL is step-trailed up — for every
 *      FIRST15.TRAIL_STEP_PERCENT the price climbs, currentSL moves up by
 *      FIRST15.TRAIL_LOCK_PERCENT (both dynamic, see updateFirst15TrailingSL()).
 *   3. target2 hit (after target1) → exit the remaining (runner) quantity.
 *   4. SL hit at any point (original stopLossPrice before target1, or the
 *      breakeven/trailed SL after) → exit whatever quantity is still open.
 *   This is the ONLY place FIRST15 exits are managed — wisdom-socket.js
 *   explicitly excludes patternSource === 'FIRST15_ORB' so the two sockets
 *   never race the same trade.
 *
 * Watches trades with status in ['ORDER_PLACED', 'PARTIALLY_CLOSED'] for
 * today's date, and runs continuously until NSE market close (15:30 IST).
 */

import { fyersDataSocket } from 'fyers-api-v3';
import fs from 'fs';
import http from 'http';
import { connectToDatabase } from '../../db/mongodb.js';
import { getTodayDate } from '../../workers/worker-helpers.js';
import { OMS_CONFIG } from '../config/oms-config.js';
import { getBrokerAdapter, assertBrokerMatches, assertAccountMatches } from '../brokers/broker-factory.js';
import { tradeAccountId, enabledAccountIds, PRIMARY_ACCOUNT_ID } from '../config/accounts.js';
import { alertExitDbSyncFailed, alertPositionMismatch, alertExitOrderRejected } from '../../services/alert-service.js';
import { LIVE_PRICE_PORT } from '../../utilities/live-price-bridge.js';

const COLLECTION_TRADES = 'trades';

// Step-trailing SL params for the FIRST15 runner (the quantity left after
// target1). Dynamic via oms-config.js FIRST15.TRAIL_STEP_PERCENT /
// TRAIL_LOCK_PERCENT — see the comment there for the full explanation.
// TRAIL_STEP_PERCENT/TRAIL_LOCK_PERCENT (oms-config.js) are no longer read
// here — the old 2-parameter step trail was replaced by the fixed 4-step
// TARGET_LADDER (see trade.orbLadder / handleFirst15Tick() below).

// How often we ask the broker whether a FIRST15 trigger entry has actually
// filled yet (see verifyFirst15EntryFills() below). Declared here (not
// next to that function) because it's needed by the setInterval(...) call
// near the top of the file, and `const` isn't hoisted the way function
// declarations are — using it before this line would throw a
// ReferenceError ("Cannot access ... before initialization").
const FIRST15_ENTRY_POLL_INTERVAL_MS = 5_000;

// ─── Symbol canonicalization for the live-price map ────────────────────────
//
// BUG THIS FIXES: "Open Position P&L not working for First15/WISDOM".
// livePrices was being keyed by `trade.symbol` exactly as stored in the
// `trades` document — whatever casing/format the signal that created it
// happened to use. The dashboard's overlay lookup (applyLiveOverlay in
// controller/broker-dashboard.controller.js), on the other hand, always
// UPPERCASES and strips the NSE series suffix off the BROKER's reported
// symbol before looking it up (its own `canonicalSymbol()` helper). Those
// two sides only ever matched by coincidence — if a Wisdom (XTS) signal's
// symbol was saved in a different case or with/without a suffix than what
// Shoonya's signals happen to use, the dashboard's canonicalized lookup key
// and this map's raw, non-canonicalized key would never be equal, so the
// live overlay silently never applied to that trade — the exact "LTP frozen
// at entry price, P&L stuck" symptom seen on the First15/WISDOM dashboard.
//
// Fix: canonicalize (uppercase, strip -EQ/-BE/-BZ/-BL/-SM) on THIS side too,
// so the map's key format matches the dashboard's lookup format regardless
// of how any particular strategy/broker happened to save the symbol.
const NSE_SERIES_SUFFIXES = ['-EQ', '-BE', '-BZ', '-BL', '-SM'];
function canonicalSymbol(raw) {
    if (!raw) return '';
    let s = String(raw).trim().toUpperCase();
    for (const suffix of NSE_SERIES_SUFFIXES) {
        if (s.endsWith(suffix)) {
            s = s.slice(0, -suffix.length);
            break;
        }
    }
    return s;
}

// ─── Module-level state ───────────────────────────────────────────────────────

/** fyersSymbol (string, e.g. "NSE:RELIANCE-EQ") → trade doc (mutable) */
const watchedTrades = new Map();

// Multi-account: the SAME symbol can now have several open trades at once (one per account),
// so trades are keyed by symbol + trade id instead of symbol alone (which would make each new
// account's trade overwrite the previous one and leave it unmonitored).
const tradeKey = (t) => `${t._fyersSymbol}#${t._id}`;

/** Stop watching a trade; only unsubscribe the symbol once NO trade on it remains. */
function releaseTrade(trade) {
    watchedTrades.delete(tradeKey(trade));
    const stillWatched = [...watchedTrades.values()].some((t) => t._fyersSymbol === trade._fyersSymbol);
    if (!stillWatched) {
        livePrices.delete(canonicalSymbol(trade.symbol));
        unsubscribeSymbol(trade._fyersSymbol);
    }
}

/**
 * Plain trading symbol (e.g. "PWL", NOT the Fyers-format key) → { ltp, ts }.
 * Updated on every single tick in handleTick() below — this is the same
 * real-time price this file already uses for its own SL/target decisions,
 * just also kept here so the dashboard's live-price bridge (see
 * utilities/live-price-bridge.js) can read it. Read-only from the outside;
 * nothing external can write into this or influence trading decisions.
 */
const livePrices = new Map();

/** tradeId → true  — prevents double-exit races */
const exitedTradeIds = new Set();

/** tradeId → retryCount */
const exitRetryCount = new Map();

/** tradeId → timestamp (ms) — cooldown before next retry */
const exitRetryAfter = new Map();

const MAX_EXIT_RETRIES = 3;
const EXIT_RETRY_DELAY_MS = 10_000;

/**
 * tradeId → { trade, order, exitQuantity, reason, partial }
 * BUG THIS FIXES: placeExitOrder() marked the DB as CLOSED/PARTIALLY_CLOSED
 * the moment the broker ACCEPTED the exit order (stat==='Ok'), not the
 * moment it actually FILLED. Shoonya's PlaceOrder response only means "your
 * order was queued for processing" — the order can still get REJECTED
 * moments later (e.g. price moved out of range, RMS/margin check). When
 * that happens the DB says the trade is closed while the broker still
 * holds the real position, and positionSafetyCheck() fires a POSITION
 * MISMATCH alert. Every exit order goes in here right after DB write, and
 * verifyExitFills() (below) confirms with the broker that it really
 * filled — the same pattern already used for FIRST15 entries via
 * verifyFirst15EntryFills().
 */
const unconfirmedExits = new Map();
const EXIT_FILL_POLL_INTERVAL_MS = 10_000;

/**
 * tradeId → { trade, order, ltp, reason, exitQuantity, partial, pnl }
 * A broker exit order was CONFIRMED, but the DB write that should record
 * it failed (e.g. Mongo connection timeout). We must never place another
 * broker order for this tradeId — only keep retrying the DB write in the
 * background until it succeeds. See reconcilePendingDbSync().
 */
const pendingDbSync = new Map();

// Safety-net watchdog: compares broker's real net position against what
// the DB thinks it should be, every POSITION_CHECK_INTERVAL_MS. Start with
// this set to true (alert-only) until you've watched it run cleanly for a
// few days, then flip to false to let it auto-correct mismatches.
const POSITION_ALERT_ONLY = true;
const POSITION_CHECK_INTERVAL_MS = 60_000;

let fyersSocket = null;
let reconnectTimer = null;
let pingTimer = null;
let reloadTimer = null;
let marketCloseTimer = null;
let eodSquareoffTimer = null;
const EOD_SQUAREOFF_MINUTES_BEFORE_CLOSE = OMS_CONFIG.FIRST15?.EOD_SQUAREOFF_MINUTES_BEFORE_CLOSE ?? 10;
let reconnectDelay = 1_000;
// Shared with the 'connect' handler below — since that handler is now
// registered only ONCE (see isFirstConnect guard), it can't rely on a
// per-call closure variable for the symbol list anymore. Each connect()
// call refreshes this before the handler fires.
let latestSymbols = [];
// Tracks whether .on(...) listeners have EVER been registered on the
// singleton fyersDataSocket instance. NOT the same as checking
// `!fyersSocket` — cleanup() nulls that local reference on every
// reconnect, but the underlying singleton (and its already-attached
// listeners) survives inside the SDK. This flag is what actually decides
// whether registering listeners again would create duplicates.
let listenersRegistered = false;
const MAX_RECONNECT = 30_000;

// ─── Custom Error classes ─────────────────────────────────────────────────────

class FyersConfigError extends Error {
    constructor(field, message) {
        super(message);
        this.name = 'FyersConfigError';
        this.field = field;
    }
}

class FyersTokenExpiredError extends Error {
    constructor(message) { super(message); this.name = 'FyersTokenExpiredError'; }
}

class FyersTokenFormatError extends Error {
    constructor(message) { super(message); this.name = 'FyersTokenFormatError'; }
}

// ─── Token helpers ────────────────────────────────────────────────────────────

/**
 * Build the "APPID:accessToken" string that fyersDataSocket expects.
 * Throws typed errors for missing/expired/malformed tokens so the
 * caller can decide whether to exit or retry.
 */
function buildFyersTokenString() {
    const appId = process.env.FYERS_APP_ID;
    const accessToken = process.env.FYERS_ACCESS_TOKEN;

    if (!appId) throw new FyersConfigError('FYERS_APP_ID', 'Missing FYERS_APP_ID in .env');
    if (!accessToken) throw new FyersConfigError('FYERS_ACCESS_TOKEN', 'Missing FYERS_ACCESS_TOKEN in .env');

    if (accessToken.split('.').length !== 3) {
        throw new FyersTokenFormatError('FYERS_ACCESS_TOKEN is not a valid JWT — should have 3 dot-separated parts');
    }

    // Decode payload to check expiry (best-effort — don't crash if it fails)
    try {
        const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64').toString());
        const nowSec = Math.floor(Date.now() / 1000);
        if (payload.exp && payload.exp < nowSec) {
            const expiredAt = new Date(payload.exp * 1000)
                .toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
            throw new FyersTokenExpiredError(
                `FYERS_ACCESS_TOKEN expired at ${expiredAt} IST. Re-run generate-fyers-token.js`
            );
        }
    } catch (e) {
        if (e instanceof FyersTokenExpiredError) throw e;
        console.warn('[FyersSocket] Could not decode token payload to check expiry:', e.message);
    }

    return `${appId}:${accessToken}`;
}

function describeCloseCode(code) {
    const map = {
        1000: 'Normal closure',
        1006: 'Abnormal / connection dropped — check network',
        1008: 'Policy violation — likely expired token, regenerate',
        4000: 'Duplicate connection — close other running instances',
        4001: 'Subscription limit exceeded (max 5000 symbols)',
        4003: 'Invalid or expired token — re-run generate-fyers-token.js',
        4401: 'Unauthorized — wrong token format, expected APPID:accesstoken',
    };
    return map[code] ?? `Unknown close code ${code}`;
}

// ─── Market hours (NSE, IST) ──────────────────────────────────────────────────
// NEW SECTION — nothing in the original file bounded the process to trading
// hours, so it would reconnect/retry forever, including after close.

const MARKET_OPEN_HOUR_IST = 9;
const MARKET_OPEN_MIN_IST = 15;
const MARKET_CLOSE_HOUR_IST = 15;
const MARKET_CLOSE_MIN_IST = 30;

/** Returns { hour, min, day } for "now" expressed in IST, regardless of server TZ. */
function getISTParts() {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
    }).formatToParts(new Date());

    const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
    const weekdayIndex = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[map.weekday];

    return { hour: parseInt(map.hour, 10), min: parseInt(map.minute, 10), day: weekdayIndex };
}

/** True during NSE trading hours on a weekday. Does NOT account for exchange holidays. */
function isMarketOpen() {
    const { hour, min, day } = getISTParts();
    if (day === 0 || day === 6) return false; // Sun / Sat

    const minutesNow = hour * 60 + min;
    const openMinutes = MARKET_OPEN_HOUR_IST * 60 + MARKET_OPEN_MIN_IST;
    const closeMinutes = MARKET_CLOSE_HOUR_IST * 60 + MARKET_CLOSE_MIN_IST;

    return minutesNow >= openMinutes && minutesNow < closeMinutes;
}

/** Milliseconds from now until today's 15:30 IST close (negative if already past). */
function msUntilMarketClose() {
    const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const close = new Date(nowIST);
    close.setHours(MARKET_CLOSE_HOUR_IST, MARKET_CLOSE_MIN_IST, 0, 0);
    return close.getTime() - nowIST.getTime();
}

/** Milliseconds from now until the FIRST15 EOD square-off time (close minus
 * EOD_SQUAREOFF_MINUTES_BEFORE_CLOSE), negative if already past. */
function msUntilFirst15Squareoff() {
    const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const squareoff = new Date(nowIST);
    squareoff.setHours(MARKET_CLOSE_HOUR_IST, MARKET_CLOSE_MIN_IST - EOD_SQUAREOFF_MINUTES_BEFORE_CLOSE, 0, 0);
    return squareoff.getTime() - nowIST.getTime();
}

function scheduleFirst15Squareoff() {
    if (eodSquareoffTimer) clearTimeout(eodSquareoffTimer);
    const ms = msUntilFirst15Squareoff();
    if (ms <= 0) return; // already past that time today, caller handles that separately

    eodSquareoffTimer = setTimeout(() => {
        console.log(`[FyersSocket] FIRST15 EOD square-off time reached (${EOD_SQUAREOFF_MINUTES_BEFORE_CLOSE} min before close) — force-exiting any remaining ladder quantity.`);
        squareOffFirst15AtClose().catch(err =>
            console.error('[FyersSocket] squareOffFirst15AtClose failed:', err.message)
        );
    }, ms);
}

function scheduleMarketCloseShutdown() {
    if (marketCloseTimer) clearTimeout(marketCloseTimer);
    const ms = msUntilMarketClose();
    if (ms <= 0) return; // already past close, caller handles that separately

    marketCloseTimer = setTimeout(() => {
        console.log('[FyersSocket] Market close (15:30 IST) reached — shutting down.');
        cleanup();
        process.exit(0);
    }, ms);
}

// ─── Keep-alive ping ──────────────────────────────────────────────────────────

function startPing() {
    // FIX: fyersSocket.emit('ping') is not part of the documented Fyers
    // API — fyersDataSocket doesn't expose a public emit() method, hence
    // "fyersSocket.emit is not a function". The SDK already runs its own
    // internal heartbeat/ping to keep the connection alive (confirmed in
    // the SDK's own internals) — no manual ping is needed or supported.
    // This function is now a no-op; kept as a stub so cleanup()/stopPing()
    // calls elsewhere don't need to change.
}

function stopPing() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
}

// ─── Load ORDER_PLACED trades from DB ────────────────────────────────────────

async function loadOpenTrades(db) {
    const today = getTodayDate();

    const trades = await db.collection(COLLECTION_TRADES).find({
        // FIXED — was 'ENTRY_PENDING', which doesn't match your OMS's status
        // values. PARTIALLY_CLOSED is included so a FIRST15 trade whose
        // target1 leg already filled (SL walked up, remainder still open)
        // survives the periodic reload below instead of being dropped.
        status: { $in: ['ORDER_PLACED', 'PARTIALLY_CLOSED'] },
        createdAt: { $gte: `${today}T00:00:00` }
    }).sort({ createdAt: -1 }).toArray();

    watchedTrades.clear();

    for (const trade of trades) {
        if (!trade.symbol) {
            console.warn(`[FyersSocket] Trade ${trade._id} has no symbol — skipped`);
            continue;
        }

        // Build the Fyers symbol format: "NSE:RELIANCE-EQ"
        // Trade docs may already store fyersSymbol, fall back to constructing it
        const fyersSymbol = trade.fyersSymbol ?? `NSE:${trade.symbol}-EQ`;

        // Initialise mutable fields with safe defaults
        trade.currentSL = trade.currentSL ?? trade.stopLossPrice;

        // FIRST15_ORB entries are TRIGGER (stop-limit) orders — the broker
        // accepts them instantly and oms-worker.js writes status:
        // 'ORDER_PLACED' to the DB the moment that ACCEPTANCE happens, not
        // when the order actually FILLS. Until it fills, the order just
        // sits TRIGGER_PENDING at the broker with no real position behind
        // it. Nine-Fifteen/MW use plain Limit/Market entries that fill
        // essentially immediately, so they're left as always-confirmed;
        // FIRST15_ORB starts unconfirmed and is only flipped to true by
        // verifyFirst15EntryFills() below once the broker actually
        // reports a fill. See handleFirst15Tick()'s guard on this flag —
        // that's what stops an SL check from firing a SELL order against
        // a position that was never actually opened.
        // FIX: ALL strategies (9:15, MW, FIRST15) start unconfirmed. A trade is only
        // 'live' for SL/target once the broker reports the entry order COMPLETE.
        trade.entryConfirmed = trade.entryConfirmed ?? false;

        trade._fyersSymbol = fyersSymbol;          // store so cleanup can use it

        watchedTrades.set(tradeKey(trade), trade);

        console.log(
            `[FyersSocket] Watching ${fyersSymbol}` +
            ` | side:${trade.side}` +
            ` | entry:${trade.entryPrice}` +
            ` | target:${trade.targetPrice}` +
            ` | SL:${trade.currentSL}`
        );
    }

    console.log(`[FyersSocket] Loaded ${watchedTrades.size} ORDER_PLACED trade(s)`);
    return [...new Set([...watchedTrades.values()].map((t) => t._fyersSymbol))];   // unique fyers symbols to subscribe
}

// ─── Broker helper ────────────────────────────────────────────────────────────

// FIRST15_ORB trades execute (entry AND exit) through OMS_CONFIG.FIRST15.BROKER
// — independent of the shared OMS_CONFIG.BROKER that Nine-Fifteen/MW use — so
// the broker placing the partial/final exits here always matches the broker
// that actually holds the position (see processFirst15Signal() in
// oms-worker.js, which places the entry order via FIRST15_BROKER too).
function getBroker(trade) {
    const brokerName = trade?.patternSource === 'FIRST15_ORB'
        ? (OMS_CONFIG.FIRST15?.BROKER ?? OMS_CONFIG.BROKER)
        : OMS_CONFIG.BROKER;
    // Multi-account: the exit MUST go through the account that holds the position (trade.accountId;
    // old trades without one = ACC1).
    return getBrokerAdapter(brokerName, tradeAccountId(trade));
}

// ─── Place exit order on Shoonya ─────────────────────────────────────────────
//
// `quantityOverride` / `partial` let FIRST15 close only part of a trade
// (the target1 leg) without touching exitedTradeIds/DB-closing logic that
// the full/only-leg exit path (Nine-Fifteen, MW pattern, FIRST15's final
// leg) relies on. Everything else is unchanged for those strategies.
async function placeExitOrder(trade, reason, ltp, { quantity, partial, rungIndex } = {}) {
    const tradeId = trade._id.toString();
    const exitQuantity = quantity ?? trade.quantity;

    // Already exited — skip
    if (exitedTradeIds.has(tradeId)) return;

    // Still in cooldown after a failed retry — skip
    const retryAfter = exitRetryAfter.get(tradeId);
    if (retryAfter && Date.now() < retryAfter) return;
    exitRetryAfter.delete(tradeId);

    // Mark as "in-flight" to prevent races. For a partial exit, this
    // still blocks a second concurrent attempt at the SAME leg — it's
    // cleared below once the partial fill is recorded, so target2 (or
    // an SL hit after target1) can still fire on a later tick.
    exitedTradeIds.add(tradeId);

    const brokerName = trade.patternSource === 'FIRST15_ORB'
        ? (OMS_CONFIG.FIRST15?.BROKER ?? OMS_CONFIG.BROKER)
        : OMS_CONFIG.BROKER;
    console.log(`[FyersSocket] ${reason} — ${trade.symbol} LTP:${ltp} | qty:${exitQuantity}${partial ? ' (PARTIAL)' : ''} | placing exit on ${brokerName}`);

    let order;

    // ── STEP 1: place the REAL broker order. This is the ONLY part that is
    // allowed to trigger a retry — nothing below this point may cause
    // another broker order to be placed for this tradeId. ──────────────────
    try {
        const broker = getBroker(trade);

        // ---- SAFETY GUARD ----
        // 1) The adapter getBroker() just built must actually be the
        //    broker `brokerName` above resolved to — catches a bug in
        //    getBroker()/broker-factory.js itself.
        // 2) If this trade doc recorded which broker its ENTRY order
        //    went to (trade.broker — see trade-model.js), that must
        //    still match too. This is the check that matters most in
        //    practice: OMS_CONFIG.BROKER / OMS_CONFIG.FIRST15.BROKER can
        //    be changed at any time, but a trade opened under the OLD
        //    broker must still be EXITED on that same broker — exiting
        //    it on whatever the config says TODAY would try to close a
        //    position that broker never opened. Older trade docs saved
        //    before this field existed have trade.broker === undefined,
        //    so this check is skipped for them rather than blocking a
        //    legitimate exit.
        assertBrokerMatches(broker, brokerName, `exit on ${trade.symbol}`);
        assertAccountMatches(broker, tradeAccountId(trade), `exit on ${trade.symbol}`);
        if (trade.broker) {
            assertBrokerMatches(broker, trade.broker, `exit on ${trade.symbol} (entry was placed on ${trade.broker})`);
        }

        const exitSide = trade.side === 'BUY' ? 'SELL' : 'BUY';

        order = await broker.placeExitMarketOrder({
            symbol: trade.symbol,
            side: exitSide,
            quantity: exitQuantity,
            price: ltp,                            // used as limit reference
            exchange: trade.exchange ?? 'NSE',
            productType: trade.productType ?? 'I',
        });

        if (!order.success) {
            const retries = (exitRetryCount.get(tradeId) ?? 0) + 1;
            exitRetryCount.set(tradeId, retries);

            if (retries >= MAX_EXIT_RETRIES) {
                console.error(
                    `[FyersSocket] Exit PERMANENTLY failed for ${trade.symbol}` +
                    ` after ${retries} attempts: ${order.error}`
                );
                // Keep in exitedTradeIds to stop further attempts
                return;
            }

            console.warn(
                `[FyersSocket] Exit attempt ${retries}/${MAX_EXIT_RETRIES} failed` +
                ` for ${trade.symbol}: ${order.error}` +
                ` — retrying in ${EXIT_RETRY_DELAY_MS / 1000}s`
            );
            exitRetryAfter.set(tradeId, Date.now() + EXIT_RETRY_DELAY_MS);
            exitedTradeIds.delete(tradeId);   // safe: broker order never went through
            return;
        }

    } catch (err) {
        // Broker call itself blew up — nothing was placed at the broker,
        // so it's safe to allow a retry on the next tick.
        console.error(`[FyersSocket] placeExitOrder broker-call exception for ${trade.symbol}:`, err.message);
        exitedTradeIds.delete(tradeId);
        return;
    }

    // ── STEP 2: order is CONFIRMED at the broker from here on. tradeId
    // stays in exitedTradeIds no matter what happens below — a DB failure
    // must never cause a second broker order for the same trade. ──────────
    console.log(`[FyersSocket] Exit placed for ${trade.symbol} — orderId:${order.brokerOrderId}`);

    // P&L estimate (approximate; broker fill price may differ slightly)
    const pnl = trade.side === 'BUY'
        ? (ltp - trade.entryPrice) * exitQuantity
        : (trade.entryPrice - ltp) * exitQuantity;

    try {
        const db = await connectToDatabase();

        if (partial) {
            // FIRST15 ladder step (see trade.orbLadder / TARGET_LADDER in
            // oms-config.js) — trade stays open (status unchanged besides
            // PARTIALLY_CLOSED), and remaining quantity is reduced. Not
            // removed from watchedTrades/unsubscribed: further ladder
            // steps or the final SL/EOD exit on the remaining qty still
            // need live ticks.
            //
            // BUG THIS FIXES (generalised from the old code): this used
            // to hardcode "walk SL to entryPrice (breakeven)" and a
            // single target1Hit flag, which only worked for ONE partial
            // leg ever. The ladder now has multiple partial legs, each
            // with its OWN stop-loss level — so this just persists
            // whatever trade.currentSL the caller (handleFirst15Tick)
            // already set for the ladder rung that was just hit, instead
            // of overwriting it.
            const remainingQuantity = trade.remainingQuantity - exitQuantity;
            const newSL = trade.currentSL;

            trade.remainingQuantity = remainingQuantity;
            trade.quantity = remainingQuantity; // so the NEXT exit only sells what's left

            const stepRecord = {
                reason,
                orderId: order.brokerOrderId,
                price: ltp,
                quantity: exitQuantity,
                pnl: parseFloat(pnl.toFixed(2)),
                slAfter: newSL,
                at: new Date().toISOString(),
            };

            // BUG FIX: a ladder-step sell (steps 2/3/4) used to only flip
            // rung.hit = true on the in-memory `trade` object, never in the
            // DB. Every 60s reload from Mongo then saw that rung's `hit`
            // still `false` and re-fired the same sell — this is what
            // caused 4 duplicate STEP2 sells on FSL (qty 3 x4, one every
            // 60s) instead of one. Persisting `orbLadder.${rungIndex}.hit`
            // in this SAME update as the rest of the partial-exit state
            // closes that gap: it's the identical field the SL-only branch
            // above already sets, just also written on the sell path.
            const ladderHitUpdate = Number.isInteger(rungIndex)
                ? { [`orbLadder.${rungIndex}.hit`]: true }
                : {};

            await db.collection(COLLECTION_TRADES).updateOne(
                { _id: trade._id },
                {
                    $set: {
                        currentSL: newSL,
                        remainingQuantity,
                        quantity: remainingQuantity,
                        status: 'PARTIALLY_CLOSED',
                        updatedAt: new Date().toISOString(),
                        ...ladderHitUpdate,
                    },
                    $push: { partialExits: stepRecord },
                }
            );

            console.log(
                `[FyersSocket] ${reason} filled ${trade.symbol} | sold:${exitQuantity}` +
                ` | remaining:${remainingQuantity} | SL -> ${newSL}`
            );

            unconfirmedExits.set(`${tradeId}:${order.brokerOrderId}`, {
                trade, brokerOrderId: order.brokerOrderId, exitQuantity, reason, partial: true,
            });

            pendingDbSync.delete(tradeId);
            // This leg is done — clear the in-flight guard so a later
            // tick (the next ladder step or an SL/EOD hit) can still fire.
            exitedTradeIds.delete(tradeId);
            return;
        }

        // Full/final exit — trade fully closed.
        await db.collection(COLLECTION_TRADES).updateOne(
            { _id: trade._id },
            {
                $set: {
                    status: 'CLOSED',
                    exitOrderId: order.brokerOrderId,
                    exitPrice: ltp,
                    exitReason: reason,
                    pnl: parseFloat(pnl.toFixed(2)),
                    remainingQuantity: 0,
                    closedAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                }
            }
        );

        console.log(`[FyersSocket] DB closed ${trade.symbol} | reason:${reason} | PnL:${pnl.toFixed(2)}`);

        unconfirmedExits.set(`${tradeId}:${order.brokerOrderId}`, {
            trade, brokerOrderId: order.brokerOrderId, exitQuantity, reason, partial: false,
        });

        pendingDbSync.delete(tradeId);

        // Remove from watch map using the Fyers symbol (not trade.token)
        releaseTrade(trade);

    } catch (err) {
        // DB write failed AFTER a real broker order already succeeded.
        // DO NOT retry the broker leg. Stop watching this symbol so no
        // further exit attempts fire on it, queue it for background
        // reconciliation (see reconcilePendingDbSync), and alert loudly.
        console.error(
            `[FyersSocket] DB sync FAILED after broker exit for ${trade.symbol}` +
            ` (orderId:${order.brokerOrderId}):`, err.message
        );

        pendingDbSync.set(tradeId, { trade, order, ltp, reason, exitQuantity, partial, pnl });
        releaseTrade(trade);

        alertExitDbSyncFailed(trade.symbol, order.brokerOrderId, err, {
            Quantity: exitQuantity,
            Reason: reason,
        });
        // tradeId is intentionally left in exitedTradeIds forever — the
        // broker leg must never be retried again for this trade.
    }
}

// ─── Background reconciliation: retries ONLY the DB write for a trade whose
// broker exit already succeeded. Never touches the broker again. ──────────
async function reconcilePendingDbSync() {
    if (pendingDbSync.size === 0) return;

    for (const [tradeId, item] of pendingDbSync.entries()) {
        const { trade, order, ltp, reason, exitQuantity, partial, pnl } = item;
        try {
            const db = await connectToDatabase();

            if (partial) {
                const remainingQuantity = trade.remainingQuantity - exitQuantity;
                await db.collection(COLLECTION_TRADES).updateOne(
                    { _id: trade._id },
                    {
                        $set: {
                            target1Hit: true,
                            target1ExitOrderId: order.brokerOrderId,
                            target1ExitPrice: ltp,
                            target1Pnl: parseFloat(pnl.toFixed(2)),
                            currentSL: trade.entryPrice,
                            remainingQuantity,
                            quantity: remainingQuantity,
                            status: 'PARTIALLY_CLOSED',
                            updatedAt: new Date().toISOString(),
                        }
                    }
                );
            } else {
                await db.collection(COLLECTION_TRADES).updateOne(
                    { _id: trade._id },
                    {
                        $set: {
                            status: 'CLOSED',
                            exitOrderId: order.brokerOrderId,
                            exitPrice: ltp,
                            exitReason: reason,
                            pnl: parseFloat(pnl.toFixed(2)),
                            remainingQuantity: 0,
                            closedAt: new Date().toISOString(),
                            updatedAt: new Date().toISOString(),
                        }
                    }
                );
            }

            console.log(`[FyersSocket] Reconciled pending DB sync for ${trade.symbol} (orderId:${order.brokerOrderId})`);
            pendingDbSync.delete(tradeId);

        } catch (err) {
            console.warn(`[FyersSocket] Reconciliation still failing for ${trade.symbol} (tradeId:${tradeId}):`, err.message);
            // leave it in the map — retried again on the next cycle
        }
    }
}

// ─── Safety-net watchdog: compares broker's real net position against what
// the DB thinks is open. Catches THIS bug and any future bug that could
// cause a duplicate/runaway order. ──────────────────────────────────────────
async function positionSafetyCheck() {
    // MULTI-ACCOUNT: each account's REAL broker positions are compared ONLY against the DB trades
    // of THAT account. (Comparing ACC1's positions against every account's trades would look like
    // a huge mismatch and auto-flatten good positions with real orders.)
    let db;
    try { db = await connectToDatabase(); } catch (err) { console.error('[SafetyNet] DB unavailable:', err.message); return; }

    let openTrades;
    try {
        openTrades = await db.collection(COLLECTION_TRADES)
            .find({ status: { $in: ['ORDER_PLACED', 'PARTIALLY_CLOSED'] } })
            .toArray();
    } catch (err) { console.error('[SafetyNet] could not load open trades:', err.message); return; }

    const accountIds = [...new Set([...enabledAccountIds(), ...openTrades.map(tradeAccountId)])];
    // Accounts are independent — check them at the same time.
    await Promise.all(accountIds.map((accountId) => positionSafetyCheckForAccount(accountId, openTrades)));
}

async function positionSafetyCheckForAccount(accountId, openTrades) {
    try {
        const broker = getBrokerAdapter(OMS_CONFIG.BROKER, accountId);
        if (typeof broker.getPositions !== 'function') return; // adapter doesn't support it

        const positions = await broker.getPositions();
        if (!positions.length) return;

        const expected = new Map(); // canonical symbol -> signed qty (this account only)
        for (const t of openTrades) {
            if (tradeAccountId(t) !== accountId) continue;
            const qty = t.remainingQuantity ?? t.quantity ?? 0;
            const signedQty = t.side === 'BUY' ? qty : -qty;
            const key = canonicalSymbol(t.symbol);
            expected.set(key, (expected.get(key) ?? 0) + signedQty);
        }

        for (const pos of positions) {
            if (!pos.quantity) continue; // flat — nothing to check

            if (pos.productType !== 'I') {
                if (!pos.productType) {
                    console.warn(`[SafetyNet][${accountId}] ${pos.symbol}: no product type returned by broker — skipping mismatch check for this position (treating as non-bot holding).`);
                }
                continue;
            }

            const expectedQty = expected.get(canonicalSymbol(pos.symbol)) ?? 0;
            if (pos.quantity === expectedQty) continue;

            console.error(
                `[SafetyNet][${accountId}] POSITION MISMATCH on ${pos.symbol}: broker=${pos.quantity},` +
                ` DB-expected=${expectedQty}`
            );

            const label = accountId === PRIMARY_ACCOUNT_ID ? pos.symbol : `${pos.symbol} [${accountId}]`;

            if (POSITION_ALERT_ONLY) {
                alertPositionMismatch(label, pos.quantity, expectedQty, false, pos.productType);
                continue;
            }

            const diff = pos.quantity - expectedQty; // extra shares currently held
            const side = diff > 0 ? 'SELL' : 'BUY';
            console.error(`[SafetyNet][${accountId}] Auto-flattening ${pos.symbol}: ${side} ${Math.abs(diff)}`);

            // Same account that holds the position — never another one.
            await broker.placeExitMarketOrder({
                symbol: pos.symbol,
                side,
                quantity: Math.abs(diff),
                price: pos.ltp,
                exchange: 'NSE',
                productType: 'I',
            });

            alertPositionMismatch(label, pos.quantity, expectedQty, true, pos.productType);
        }
    } catch (err) {
        console.error(`[SafetyNet][${accountId}] positionSafetyCheck failed:`, err.message);
    }
}

// ─── Exit-fill verifier: confirms every exit order we marked CLOSED in the
// DB actually FILLED at the broker, instead of just trusting the broker's
// "order accepted" response. Mirrors verifyFirst15EntryFills() above, but
// for the exit side — see the `unconfirmedExits` comment for the bug this
// closes. Runs frequently so a rejected exit gets corrected within
// seconds, not the full 60s positionSafetyCheck cycle. ──────────────────────
async function verifyExitFills() {
    if (!unconfirmedExits.size) return;

    for (const [key, entry] of [...unconfirmedExits.entries()]) {
        const { trade, brokerOrderId, exitQuantity, reason, partial } = entry;
        try {
            const broker = getBroker(trade);
            if (typeof broker.getOrderStatus !== 'function') {
                unconfirmedExits.delete(key); // can't verify — nothing more we can do
                continue;
            }

            const result = await broker.getOrderStatus(brokerOrderId);

            if (result.status === 'COMPLETE') {
                unconfirmedExits.delete(key); // confirmed — DB and broker agree
                continue;
            }

            if (result.status === 'REJECTED' || result.status === 'CANCELED') {
                console.error(
                    `[FyersSocket] Exit order ${brokerOrderId} for ${trade.symbol} was marked` +
                    ` CLOSED in DB but broker reports ${result.status} — position was never` +
                    ` actually closed. Firing a corrective MARKET exit now.`
                );
                unconfirmedExits.delete(key);

                const db = await connectToDatabase();
                // Undo the premature close so positionSafetyCheck's "expected"
                // calculation includes this trade again, and so the retry
                // below is exiting a trade the DB also believes is open.
                await db.collection(COLLECTION_TRADES).updateOne(
                    { _id: trade._id },
                    { $set: { status: partial ? 'PARTIALLY_CLOSED' : 'ORDER_PLACED', updatedAt: new Date().toISOString() } }
                );

                let correctiveAction = 'A corrective market exit could not be placed automatically — check the broker terminal immediately.';
                try {
                    const exitSide = trade.side === 'BUY' ? 'SELL' : 'BUY';
                    const retry = await broker.placeExitMarketOrder({
                        symbol: trade.symbol,
                        side: exitSide,
                        quantity: exitQuantity,
                        exchange: trade.exchange ?? 'NSE',
                        productType: trade.productType ?? 'I',
                    });
                    if (retry.success) {
                        correctiveAction = `A corrective MARKET exit was placed automatically (orderId:${retry.brokerOrderId}) and is being tracked the same way.`;
                        unconfirmedExits.set(`${trade._id.toString()}:${retry.brokerOrderId}`, {
                            trade, brokerOrderId: retry.brokerOrderId, exitQuantity, reason, partial,
                        });
                    } else {
                        correctiveAction = `A corrective market exit was attempted but also failed (${retry.error}) — check the broker terminal immediately.`;
                    }
                } catch (retryErr) {
                    correctiveAction = `A corrective market exit threw an error (${retryErr.message}) — check the broker terminal immediately.`;
                }

                alertExitOrderRejected(trade.symbol, brokerOrderId, result.status, correctiveAction);
                continue;
            }

            // Still OPEN / PENDING / UNKNOWN — check again next poll.
        } catch (err) {
            console.error(`[FyersSocket] verifyExitFills check failed for ${trade.symbol}:`, err.message);
        }
    }
}

setInterval(positionSafetyCheck, POSITION_CHECK_INTERVAL_MS);
setInterval(reconcilePendingDbSync, 30_000);
setInterval(verifyExitFills, EXIT_FILL_POLL_INTERVAL_MS);
setInterval(verifyFirst15EntryFills, FIRST15_ENTRY_POLL_INTERVAL_MS);

// ─── FIRST15 ORB: confirm the trigger entry actually FILLED ────────────────
//
// THE BUG THIS FIXES: FIRST15's entry is a TRIGGER (stop-limit) order (see
// placeTriggerEntryOrder() in oms-worker.js). The broker accepts it and
// oms-worker.js writes status: 'ORDER_PLACED' to the DB right then — but
// "accepted" just means it's now resting at the broker as TRIGGER_PENDING,
// waiting for price to actually cross the breakout level. It has NOT
// bought anything yet. If price instead falls straight through the
// original stop-loss level without ever triggering, the old code still
// saw an "open" trade in the DB, checked LTP <= currentSL, and fired a
// SELL exit order — selling a position that was never bought. That's
// exactly what happened today.
//
// Fix: every FIRST15 trade starts with entryConfirmed: false (see
// loadOpenTrades()) and is NOT eligible for any SL/target exit logic
// until this poller confirms, via broker.getOrderStatus(), that the
// entry order actually shows COMPLETE (filled) at the broker. Runs on a
// short interval so confirmation happens within a few seconds of the
// real fill.

async function verifyFirst15EntryFills() {
    const pending = [...watchedTrades.values()].filter(
        t => !t.entryConfirmed && t.entryOrderId   // FIX: all strategies, not only FIRST15
    );
    if (!pending.length) return;

    for (const trade of pending) {
        try {
            const broker = getBroker(trade);
            if (typeof broker.getOrderStatus !== 'function') continue; // can't verify — leave unconfirmed, safe by default

            const result = await broker.getOrderStatus(trade.entryOrderId);

            if (result.status === 'COMPLETE') {
                trade.entryConfirmed = true;
                const db = await connectToDatabase();
                await db.collection(COLLECTION_TRADES).updateOne(
                    { _id: trade._id },
                    {
                        $set: {
                            entryConfirmed: true,
                            entryFillPrice: result.avgPrice || trade.entryPrice,
                            entryFilledQty: result.filledQty ?? trade.quantity,
                            updatedAt: new Date().toISOString(),
                        }
                    }
                );
                console.log(`[FyersSocket] FIRST15 entry CONFIRMED FILLED — ${trade.symbol} @ ${result.avgPrice} — now live for SL/target checks`);
                continue;
            }

            if (result.status === 'REJECTED' || result.status === 'CANCELED') {
                // Entry never happened at all — nothing to watch or exit.
                await cancelUnfilledFirst15Entry(trade, `FIRST15_ENTRY_${result.status}`, { alreadyAtBroker: true });
                continue;
            }

            // Still OPEN / PENDING / TRIGGER_PENDING / UNKNOWN — check again next poll.
        } catch (err) {
            console.error(`[FyersSocket] FIRST15 entry-fill check failed for ${trade.symbol}:`, err.message);
        }
    }
}

// Cancels a FIRST15 trigger entry that never filled — either because price
// broke the stop-loss level before ever triggering (called from
// handleFirst15Tick()), or because the broker itself reports it
// REJECTED/CANCELED (called from verifyFirst15EntryFills() above).
// `alreadyAtBroker` skips the cancelOrder() call when the broker has
// already killed the order itself.
async function cancelUnfilledFirst15Entry(trade, reason, { alreadyAtBroker = false } = {}) {
    const tradeId = trade._id.toString();
    if (exitedTradeIds.has(tradeId)) return; // already being handled by something else
    exitedTradeIds.add(tradeId);

    try {
        if (!alreadyAtBroker) {
            const broker = getBroker(trade);
            if (typeof broker.cancelOrder === 'function') {
                await broker.cancelOrder(trade.entryOrderId);
            }
        }

        const db = await connectToDatabase();
        await db.collection(COLLECTION_TRADES).updateOne(
            { _id: trade._id },
            {
                $set: {
                    status: 'ENTRY_CANCELLED',
                    exitReason: reason,
                    remainingQuantity: 0,
                    closedAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                }
            }
        );
        console.log(`[FyersSocket] FIRST15 unfilled trigger entry cancelled for ${trade.symbol} — reason:${reason} — no position was ever open, nothing sold`);
    } catch (err) {
        console.error(`[FyersSocket] Failed to cancel unfilled FIRST15 entry for ${trade.symbol}:`, err.message);
    } finally {
        releaseTrade(trade);
    }
}

// ─── FIRST15 ORB tick handling — 4-step profit-booking ladder ──────────────
//
// One entry order is placed for the FULL quantity (see
// processFirst15Signal() in oms-worker.js), which also pre-computes
// trade.orbLadder — 4 steps, each a % move above entryPrice, each with its
// own sell quantity (a % of the ORIGINAL total) and its own SL level (also
// a % above entryPrice). This function just walks that ladder against live
// ticks:
//
//   for each un-hit rung, in order, closest-to-entry first:
//     - LTP >= rung.targetPrice -> sell rung.sellQuantity (0 = none, just
//       locks in the SL move), walk currentSL up to rung.slPrice.
//   at any point:
//     - LTP <= currentSL -> exit whatever quantity is still open, trade
//       closed. Before step 1, currentSL is still the original candle-Low
//       stop; after each rung, it's that rung's locked-in profit level.
//
// Whatever's left after all 4 rungs (~5% of the original quantity, per the
// default TARGET_LADDER in oms-config.js) is NOT exited here — it rides
// with the final rung's SL protecting it until squareOffFirst15AtClose()
// force-exits it near market close (see the scheduler in connect() below).
async function handleFirst15Tick(trade, ltp) {
    // Entry is a TRIGGER (stop-limit) order — our DB may say 'ORDER_PLACED'
    // while the broker still shows it TRIGGER_PENDING (accepted, not yet
    // filled). verifyFirst15EntryFills() is what flips entryConfirmed to
    // true, and ONLY once it does are we allowed to treat this as a real
    // open position. Until then: no target/SL exit logic runs — there is
    // nothing to sell yet, that's the bug that caused today's issue.
    if (!trade.entryConfirmed) {
        // By request: do NOT cancel the resting trigger order just because
        // price dipped through the original stop-loss level before the
        // breakout ever triggered. We never actually bought anything yet,
        // so there's no position for a stop-loss to protect — the order
        // should just stay TRIGGER_PENDING at the broker. If price later
        // comes back up and triggers the entry, the trade proceeds
        // normally from there. verifyFirst15EntryFills() still handles the
        // case where the BROKER itself rejects/cancels the order.
        return;
    }

    const ladder = trade.orbLadder ?? [];

    // Walk every un-hit rung this tick has reached, in ascending order.
    // Rungs are stored closest-target-first, so the moment we hit one
    // that ISN'T reached yet, nothing further can be either — safe to
    // stop. This also correctly handles a fast move/gap that jumps
    // straight past more than one rung within a single tick.
    for (let i = 0; i < ladder.length; i++) {
        const rung = ladder[i];
        if (rung.hit) continue;
        if (ltp < rung.targetPrice) break;

        rung.hit = true;
        // Always walk the SL up on a rung hit, even a "no sell" step —
        // that step's entire purpose is locking in profit via a tighter
        // stop. Set BEFORE placeExitOrder() so its partial-exit branch
        // persists this exact value instead of the previous rung's.
        trade.currentSL = rung.slPrice;

        if (rung.sellQuantity > 0) {
            await placeExitOrder(trade, `FIRST15_LADDER_STEP${i + 1}_HIT`, ltp, {
                quantity: rung.sellQuantity,
                partial: true,
                rungIndex: i,
            });
        } else {
            // Nothing to sell on this rung — still need to persist the
            // new SL ourselves since placeExitOrder() isn't being called.
            try {
                const db = await connectToDatabase();
                await db.collection(COLLECTION_TRADES).updateOne(
                    { _id: trade._id },
                    { $set: { currentSL: rung.slPrice, [`orbLadder.${i}.hit`]: true, updatedAt: new Date().toISOString() } }
                );
                console.log(`[FyersSocket] FIRST15 ladder step ${i + 1} (SL-only) ${trade.symbol} | LTP:${ltp} | SL -> ${rung.slPrice}`);
            } catch (err) {
                console.error(`[FyersSocket] FIRST15 ladder SL-only DB update failed for ${trade.symbol}:`, err.message);
            }
        }
    }

    if (ltp <= trade.currentSL && trade.remainingQuantity > 0) {
        await placeExitOrder(trade, 'FIRST15_SL_HIT', ltp, {
            quantity: trade.remainingQuantity,
        });
    }
}

// ─── FIRST15 ORB: force-exit whatever's left at market close ───────────────
//
// The ladder above only ever sells at its 4 profit steps or on an SL hit —
// the final ~5% (per the default TARGET_LADDER) can legitimately ride all
// the way to end of day with no trigger to sell it. Scheduled a few
// minutes before actual exchange close (EOD_SQUAREOFF_MINUTES_BEFORE_CLOSE
// in oms-config.js) so the MARKET order has time to fill. Runs once; any
// trade already fully closed (remainingQuantity 0) is a no-op.
async function squareOffFirst15AtClose() {
    for (const trade of watchedTrades.values()) {
        if (trade.patternSource !== 'FIRST15_ORB') continue;
        if (!trade.entryConfirmed) continue;
        if (!(trade.remainingQuantity > 0)) continue;

        const ltp = livePrices.get(canonicalSymbol(trade.symbol)) ?? trade.entryPrice;
        console.log(`[FyersSocket] FIRST15 EOD square-off — ${trade.symbol} | qty:${trade.remainingQuantity}`);
        await placeExitOrder(trade, 'FIRST15_EOD_SQUAREOFF', ltp, {
            quantity: trade.remainingQuantity,
        });
    }
}



// ─── Handle incoming tick ─────────────────────────────────────────────────────

async function handleTick(message) {
    try {
        if (!message || typeof message !== 'object') return;

        // Fyers SDK emits connection/subscription ack messages — ignore them
        const msgType = message.type;
        if (msgType === 'cn' || msgType === 'sub') return;

        // Only process quote ticks ('sf' = snapshot-full, 'if' = incremental-full)
        if (msgType !== 'sf' && msgType !== 'if') return;

        const symbol = message.symbol;
        const ltp = message.ltp;

        if (!symbol || typeof ltp !== 'number' || ltp <= 0) return;

        // MULTI-ACCOUNT: every open trade on this symbol (one per account).
        const trades = [...watchedTrades.values()].filter((t) => t._fyersSymbol === symbol);
        if (!trades.length) return;

        // Record this tick for the dashboard's live-price bridge — same
        // real-time value used for actual SL/target checks, just also
        // exposed read-only for anything watching this trade.
        livePrices.set(canonicalSymbol(trades[0].symbol), { ltp, ts: Date.now() });

        console.log(`[FyersSocket] TICK — ${symbol} | LTP:${ltp} | ${trades.length} trade(s)`);

        // All accounts' trades on this symbol are checked — and, if needed, EXITED — at the same
        // moment (parallel, not one account after another), each through its own account session.
        await Promise.all(trades.map((trade) => handleTradeTick(trade, ltp).catch((err) => {
            console.error(`[FyersSocket] Tick handler error (${trade.symbol} ${tradeAccountId(trade)}):`, err.message);
        })));

    } catch (err) {
        console.error('[FyersSocket] Tick handler error:', err.message);
    }
}

// Original per-trade tick logic (FIRST15 ladder / target / stop-loss) — unchanged, just
// split out so it can run once per trade instead of once per symbol.
async function handleTradeTick(trade, ltp) {
        // ── FIRST15 ORB: dual-target, 50/50 partial exit + SL-to-target1 ──
        // Scoped strictly to patternSource === 'FIRST15_ORB'. Nine-Fifteen
        // and MW pattern trades never take this branch — they fall through
        // to the original single-target/fixed-SL logic below, unchanged.
        if (trade.patternSource === 'FIRST15_ORB') {
            await handleFirst15Tick(trade, ltp);
            return;
        }

        // FIX: never run SL/target on a trade whose entry hasn't filled.
        // (Unfilled SELL trigger + SL 'hit' = naked BUY. See GODREJCP 30-Oct.)
        if (!trade.entryConfirmed) return;

        // ── TARGET check (Nine-Fifteen / MW pattern — unchanged) ─────────────
        const targetHit = trade.side === 'BUY'
            ? (trade.targetPrice > trade.entryPrice && ltp >= trade.targetPrice)
            : (trade.targetPrice < trade.entryPrice && ltp <= trade.targetPrice);

        if (targetHit) {
            await placeExitOrder(trade, 'TARGET_HIT', ltp);
            return;
        }

        // ── STOP-LOSS check ───────────────────────────────────────────────────
        const slHit = trade.side === 'BUY'
            ? ltp <= trade.currentSL
            : ltp >= trade.currentSL;

        if (slHit) {
            await placeExitOrder(trade, 'SL_HIT', ltp);
            return;
        }
}

// ─── Subscribe / Unsubscribe ──────────────────────────────────────────────────

function subscribeSymbols(symbols) {
    if (!fyersSocket || !symbols.length) return;
    try {
        // FIX: Fyers' documented subscribe() signature only takes
        // (symbols, isDepth) — there is no third numeric "mode" argument.
        // The previous code passed `1` as a 3rd arg based on an incorrect
        // assumption; that's not part of the real API and may be why the
        // subscription never produced real ticks (server likely ignored
        // or misinterpreted the extra parameter).
        //
        // The correct way to get LTP-only data (per Fyers' own README/
        // sample) is: subscribe normally, then call .mode(LiteMode)
        // separately to switch to the lighter LTP-only feed.
        fyersSocket.subscribe(symbols, false);
        fyersSocket.mode(fyersSocket.LiteMode);
        console.log(`[FyersSocket] Subscribed (Lite/LTP mode): ${symbols.join(', ')}`);
    } catch (err) {
        console.error(`[FyersSocket] Subscribe failed for [${symbols.join(', ')}]: ${err.message}`);
    }
}

function unsubscribeSymbol(symbol) {
    if (!fyersSocket || !symbol) return;
    try {
        // FIX: same undocumented 3rd argument issue as subscribeSymbols above —
        // unsubscribe() only takes (symbols, isDepth) per Fyers' documented API.
        fyersSocket.unsubscribe([symbol], false);
        console.log(`[FyersSocket] Unsubscribed: ${symbol}`);
    } catch (err) {
        console.warn(`[FyersSocket] Unsubscribe failed for ${symbol}:`, err.message);
    }
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

function cleanup() {
    stopPing();

    if (reloadTimer) { clearInterval(reloadTimer); reloadTimer = null; }
    if (marketCloseTimer) { clearTimeout(marketCloseTimer); marketCloseTimer = null; }
    if (eodSquareoffTimer) { clearTimeout(eodSquareoffTimer); eodSquareoffTimer = null; }

    if (fyersSocket) {
        try { fyersSocket.close(); } catch { /* ignore */ }
        fyersSocket = null;
    }
}

// ─── Reconnect scheduler ──────────────────────────────────────────────────────

function scheduleReconnect() {
    if (reconnectTimer) return;  // already scheduled
    console.log(`[FyersSocket] Will reconnect in ${reconnectDelay / 1000}s…`);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT);
        connect();
    }, reconnectDelay);
}

// ─── Main connect ─────────────────────────────────────────────────────────────

async function connect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    cleanup();

    // NEW — don't even attempt to connect outside trading hours. Covers both
    // "started before 9:15" and "still alive after 15:30" cases.
    if (!isMarketOpen()) {
        const { hour, min } = getISTParts();
        if (hour * 60 + min >= MARKET_CLOSE_HOUR_IST * 60 + MARKET_CLOSE_MIN_IST) {
            console.log('[FyersSocket] Market is closed for the day — exiting.');
            process.exit(0);
        }
        console.log('[FyersSocket] Market not open yet — checking again in 60s.');
        reconnectTimer = setTimeout(connect, 60_000);
        return;
    }

    try {
        // connectToDatabase() returns the db object directly (not { db })
        const db = await connectToDatabase();
        const symbols = await loadOpenTrades(db);

        if (!symbols.length) {
            console.log('[FyersSocket] No open trades — will retry in 60s');
            reconnectTimer = setTimeout(connect, 60_000);
            return;
        }

        const tokenString = buildFyersTokenString();

        latestSymbols = symbols; // refresh for the 'connect' handler below

        console.log('[FyersSocket] Connecting to Fyers data socket…');

        // FIX: fyersDataSocket is a SINGLETON inside the Fyers SDK — it must
        // always be created via getInstance(), never `new`. Calling `new`
        // again on reconnect (after the first instance already exists in
        // this process) throws "Only one instance of DataSocket is allowed.
        // Use getInstance() instead." getInstance() safely returns the
        // existing instance if one is already alive, or creates one if not.
        const isFirstConnect = !listenersRegistered;
        // FIX: getInstance() takes 3 args per Fyers' README —
        // (accessToken, logPath, enableLogging). We were only passing the
        // token, with logging silently off. Enabling it here so the SDK's
        // OWN internal logs show up — this should reveal the real reason
        // ticks aren't arriving (auth issue, wrong topic format, etc.)
        // instead of us guessing from the outside.
        //
        // The SDK does NOT create the log folder itself — it just tries to
        // open a file inside it and fails silently (ENOENT) if missing.
        // Create it ourselves first so logging actually works.
        const logDir = './fyers-socket-logs';
        try {
            fs.mkdirSync(logDir, { recursive: true });
        } catch (err) {
            console.warn('[FyersSocket] Could not create log directory:', err.message);
        }
        fyersSocket = fyersDataSocket.getInstance(tokenString, logDir, true);

        // FIX: since getInstance() returns the SAME object on every
        // reconnect, registering .on(...) handlers again each time would
        // stack duplicate listeners on top of the old ones — meaning every
        // tick would eventually fire the exit-order logic multiple times
        // (real duplicate orders on a live trading bot). Only register
        // listeners the very first time this process connects; on later
        // reconnects the existing listeners are reused as-is.
        if (isFirstConnect) {
            listenersRegistered = true;

            // ── Connected ─────────────────────────────────────────────────────────
            fyersSocket.on('connect', () => {
                reconnectDelay = 1_000;  // reset backoff on successful connect
                console.log('[FyersSocket] Connected!');

                startPing();
                scheduleMarketCloseShutdown();   // NEW — hard stop at 15:30 IST
                scheduleFirst15Squareoff();      // force-exit remaining FIRST15 ladder qty before close

                // Subscribe all watched symbols (always the freshest list — see latestSymbols above)
                subscribeSymbols(latestSymbols);

                // Reload trades every 5 minutes to catch newly entered positions
                // (clear first in case this is a reconnect)
                // NOTE: comment above said "5 minutes" but interval below is 60_000 (1 min) — left as-is
                // since 1-minute reload is more useful for "continuously check" behavior; tighten/loosen
                // as you prefer.
                if (reloadTimer) clearInterval(reloadTimer);
                reloadTimer = setInterval(async () => {
                    if (!isMarketOpen()) return; // guard in case close-timer hasn't fired yet
                    try {
                        console.log('[FyersSocket] Reloading trades from DB…');
                        const freshDb = await connectToDatabase();
                        const newSymbols = await loadOpenTrades(freshDb);
                        if (fyersSocket && newSymbols.length) {
                            subscribeSymbols(newSymbols);
                        }
                    } catch (err) {
                        console.warn('[FyersSocket] Trade reload failed:', err.message);
                    }
                }, 60_000);
            });

            // ── Incoming data (Fyers only documents 'message' — not 'data';
            // see fyers-api-v3 sample code. The old .on('data', ...) call
            // below was passing an unrecognized event name, which is exactly
            // what produced the mysterious "invalid parameter: data" log line
            // seen on every run — confirmed via the SDK's own debug log
            // (functionName: "on", data.input: "data"). Removed.
            const onMessage = async (msg) => { await handleTick(msg); };
            fyersSocket.on('message', onMessage);

            // ── Error ─────────────────────────────────────────────────────────────
            fyersSocket.on('error', (err) => {
                const raw = typeof err === 'string' ? err : (err?.message ?? String(err));
                console.error(`[FyersSocket] Socket error: ${raw}`);
                cleanup();
                if (!isMarketOpen()) {
                    console.log('[FyersSocket] Market closed — not reconnecting after error.');
                    process.exit(0);
                }
                scheduleReconnect();
            });

            // ── Closed ────────────────────────────────────────────────────────────
            fyersSocket.on('close', (closeInfo) => {
                const code = typeof closeInfo === 'number' ? closeInfo : closeInfo?.code;
                console.warn(`[FyersSocket] Closed (${code}) — ${describeCloseCode(code)}`);
                cleanup();
                if (!isMarketOpen()) {
                    console.log('[FyersSocket] Market closed — not reconnecting.');
                    process.exit(0);
                }
                scheduleReconnect();
            });

        } // end isFirstConnect guard

        // If this is a reconnect (listeners already registered), still make
        // sure the freshest symbol list gets subscribed once the socket is
        // back up — the 'connect' handler above already does this via
        // latestSymbols, so nothing extra is needed here.

        // SDK-level autoreconnect as an additional safety net (10 attempts max)
        fyersSocket.autoreconnect(10);

        fyersSocket.connect();

    } catch (err) {
        // Fatal config errors — no point retrying, token needs to be regenerated
        if (
            err instanceof FyersConfigError ||
            err instanceof FyersTokenExpiredError ||
            err instanceof FyersTokenFormatError
        ) {
            console.error(`\n[FyersSocket] ⛔ Fatal error:\n  ${err.message}\n`);
            process.exit(1);
        }

        console.error('[FyersSocket] Setup error:', err.message);
        scheduleReconnect();
    }
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

process.on('SIGINT', () => { console.log('\n[FyersSocket] SIGINT — shutting down'); cleanup(); process.exit(0); });
process.on('SIGTERM', () => { console.log('\n[FyersSocket] SIGTERM — shutting down'); cleanup(); process.exit(0); });

// ─── Live-price bridge (read-only, localhost-only) ─────────────────────────────
//
// Exposes the `livePrices` Map above to the dashboard's web server process
// (server.js runs separately — see utilities/live-price-bridge.js). This is
// intentionally the ONLY thing this HTTP server does: it never accepts any
// input, never touches watchedTrades, and cannot affect order placement or
// SL/target decisions in any way — a client hitting this endpoint just
// reads a snapshot of prices that were already going to be recorded above
// regardless of whether anything is listening.
//
// Bound to 127.0.0.1 so it is reachable only from other processes on this
// same AWS box — never exposed to the internet, even if this box's other
// ports are. If this port is already taken (e.g. a second instance
// accidentally started), we log it and carry on — the trading logic above
// works identically either way; only the dashboard's live-price overlay
// would fall back to the broker's own (slightly slower) LTP.
const livePriceServer = http.createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/live-prices') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
    }
    const snapshot = {};
    for (const [symbol, entry] of livePrices.entries()) {
        snapshot[symbol] = entry;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(snapshot));
});

livePriceServer.on('error', (err) => {
    console.error(`[FyersSocket] Live-price bridge failed to start on 127.0.0.1:${LIVE_PRICE_PORT}:`, err.message);
});

livePriceServer.listen(LIVE_PRICE_PORT, '127.0.0.1', () => {
    console.log(`[FyersSocket] Live-price bridge listening on 127.0.0.1:${LIVE_PRICE_PORT} (dashboard reads from here)`);
});

// ─── Start ────────────────────────────────────────────────────────────────────

console.log('[FyersSocket] Starting…');
connect();