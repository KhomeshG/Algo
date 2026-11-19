import dotenv from 'dotenv';
import fs from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
 
// This file is run STANDALONE (via cron/Task Scheduler), a separate Node
// process from server.js — server.js's own dotenv.config() call never
// reaches this process, so without this, any .env override (like the
// per-strategy OMS_RUN_* flags below) would silently be ignored when
// oms-worker.js is invoked directly.
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../.env') });
 
import {
    connectToDatabase
} from '../../db/mongodb.js';
 
import {
    OMS_CONFIG
} from '../config/oms-config.js';
 
import {
    createTrade
} from '../models/trade-model.js';
 
import {
    getBrokerAdapter,
    assertBrokerMatches,
    assertAccountMatches
} from '../brokers/broker-factory.js';
 
import {
    appendPendingTradeSync,
    getPendingSignalIds,
    reconcilePendingTradeSync
} from './pending-trade-sync.js';
 
import {
    alertEntryDbSyncFailed,
    alertOrderNotPlaced
} from '../../services/alert-service.js';

import { getActiveShoonyaToken } from '../../services/shoonya-api-login-service.js';

import {
    PRIMARY_ACCOUNT_ID,
    enabledAccountIds,
    getAccountBalance
} from '../config/accounts.js';

import {
    placeEntryAcrossAccounts,
    prepareAccounts
} from './multi-account-entry.js';
 
import {
    isTradingDay
} from '../../utilities/trading-days-loader.js';
 
// ─────────────────────────────────────────────────────────────────────────
// MARKET-HOURS GATE
//
// THE BUG THIS FIXES: this worker is scheduled via a host crontab entry
// (`*/3 * * * *`, see docker.md) that fires EVERY 3 MINUTES, 24 HOURS A
// DAY — there was never any check in this file for whether the market is
// even open. So at 6:15 AM, 11 PM, on a Sunday, on a market holiday —
// every single tick spun up a fresh container and, if any RUN_* flag was
// on, walked all the way into fetching signals and (if any were found or
// a stale token needed refreshing) calling the broker, including
// triggering a full Shoonya login. That's exactly how a "Login Failed"
// email at 6:15 AM happens: nothing at that hour actually needed the bot
// to be logged in, since the market doesn't open until 9:15 AM.
//
// This also closes a second problem: the single-flight login lock in
// shoonya-api-login-service.js only coordinates calls WITHIN one running
// process. Because cron here launches a brand-new `docker-compose run`
// process every 3 minutes, if one tick's login retry loop is still
// working (it can take several minutes on a bad morning) when the next
// tick fires, that next tick starts a COMPLETELY SEPARATE process with
// its own independent login attempt — recreating the exact "multiple
// simultaneous login attempts" pile-up the single-flight lock was meant
// to prevent, just one level up (across processes instead of within one).
// Stopping most ticks before they ever reach the broker call removes
// nearly all of the opportunities for that overlap to happen.
//
// Window is intentionally a little wider than the 9:15-15:30 trading
// session: 9:05 AM lets pre-open signal fetches/logins warm up in time,
// and 15:35 PM gives a few minutes of buffer for EOD cleanup ticks.
const MARKET_OPEN_HHMM = '09:05';
const MARKET_CLOSE_HHMM = '15:35';
 
function isWithinMarketHoursIST() {
    const now = new Date();
    const istString = now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', hour12: false });
    const istNow = new Date(istString);
    const hhmm = `${String(istNow.getHours()).padStart(2, '0')}:${String(istNow.getMinutes()).padStart(2, '0')}`;
    const dateStr = istNow.toISOString().slice(0, 10); // not perfectly IST-safe at midnight edges, fine for a day-level check
 
    if (!isTradingDay(dateStr)) return false;
    return hhmm >= MARKET_OPEN_HHMM && hhmm <= MARKET_CLOSE_HHMM;
}
 
// ─────────────────────────────────────────────────────────────────────────
// CROSS-PROCESS RUN LOCK
//
// Belt-and-braces alongside the market-hours gate above: even inside the
// trading window, if one cron-spawned process is still mid-cycle (a slow
// DB query, a broker call hanging) when the next tick fires 3 minutes
// later, we do NOT want two separate processes racing on the same signals
// and broker session at once. A plain lock file (checked/created
// atomically via the 'wx' flag) makes each new tick bail out immediately
// if a previous run hasn't finished, instead of piling up.
// A stale lock (crash without cleanup) is auto-cleared after 10 minutes —
// far longer than a normal cycle should ever take.
const LOCK_FILE = resolve(__dirname, '../../data/oms-worker.lock');
const STALE_LOCK_MS = 10 * 60 * 1000;
 
function acquireRunLock() {
    try {
        fs.mkdirSync(dirname(LOCK_FILE), { recursive: true });
        fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' });
        return true;
    } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        try {
            const age = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
            if (age > STALE_LOCK_MS) {
                console.warn(`[OMS] Clearing stale lock file (${Math.round(age / 1000)}s old) left by a previous run that never cleaned up.`);
                fs.rmSync(LOCK_FILE, { force: true });
                fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' });
                return true;
            }
        } catch (_) { /* fall through to "locked" */ }
        return false;
    }
}
 
function releaseRunLock() {
    try { fs.rmSync(LOCK_FILE, { force: true }); } catch (_) { /* non-fatal */ }
}
 
// =====================================================================
// COLLECTIONS
// =====================================================================
const NINE_FIFTEEN_COLLECTION = 'mw_volume_surge_patterns'; // 9:15 AM pattern signals
const MW_PATTERN_COLLECTION = 'mw_patterns';                // MW pattern signals
const FIRST15_COLLECTION = 'detected_orb_patterns';         // First-15-min (9:15-9:30) ORB signals — written by wisdom-orb-pattern-worker.js
const TRADE_COLLECTION = 'trades';
 
// =====================================================================
// CONFIGURABLE SETTINGS
// Ideally these live in OMS_CONFIG (oms-config.js). Fallback defaults
// are provided here via `??` so the worker keeps working even if a
// particular key hasn't been added to the config file yet.
// =====================================================================
 
// RUN_NINE_FIFTEEN and RUN_MW_PATTERN are simple on/off switches.
// RUN_FIRST15 is the same kind of switch for the First-15-Minute ORB
// breakout strategy (strategy.docx) — defaults to false/off until you
// explicitly set OMS_RUN_FIRST15=true (or RUN_FIRST15 in oms-config.js).
// Any combination of the three can run together in one call:
//
//   RUN_NINE_FIFTEEN=true,  RUN_MW_PATTERN=false -> 9:15 AM pattern ONLY
//   RUN_NINE_FIFTEEN=false, RUN_MW_PATTERN=true   -> MW pattern ONLY
//   RUN_NINE_FIFTEEN=true,  RUN_MW_PATTERN=true   -> BOTH, combined
//   RUN_FIRST15=true                              -> First-15 ORB also runs, alongside whichever of the above are on
//   RUN_NINE_FIFTEEN=false, RUN_MW_PATTERN=false, RUN_FIRST15=false -> do nothing, worker exits
const RUN_NINE_FIFTEEN = OMS_CONFIG.RUN_NINE_FIFTEEN ?? true;
const RUN_MW_PATTERN = OMS_CONFIG.RUN_MW_PATTERN ?? false;
const RUN_FIRST15 = OMS_CONFIG.RUN_FIRST15 ?? false;
 
// ------------------------------------------------------------------
// SAFETY GUARD — Nine-Fifteen entry time window
// ------------------------------------------------------------------
// Restricts Nine-Fifteen order placement to a narrow IST window
// (default 9:17 AM - 9:21 AM) to prevent accidental/stale orders from
// firing outside the intended entry moment.
//
// TO DISABLE THIS GUARD: comment out the single line below
// (ENFORCE_NINE_FIFTEEN_TIME_WINDOW = true) and uncomment the one
// under it (= false). Nothing else needs to change.
const ENFORCE_NINE_FIFTEEN_TIME_WINDOW = true;
// const ENFORCE_NINE_FIFTEEN_TIME_WINDOW = false;
 
const NINE_FIFTEEN_WINDOW_START = { hour: 9, minute: 17 }; // inclusive
const NINE_FIFTEEN_WINDOW_END = { hour: 9, minute: 21 };   // inclusive
 
// Returns true if right now (IST) falls within the allowed entry
// window. Only ever called for NINE_FIFTEEN signals — MW_PATTERN and
// FIRST15_ORB signals are completely unaffected by this guard.
function isWithinNineFifteenWindow() {
 
    const nowIST = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    }).formatToParts(new Date());
 
    const hour = Number(nowIST.find(p => p.type === 'hour').value);
    const minute = Number(nowIST.find(p => p.type === 'minute').value);
    const nowMinutes = hour * 60 + minute;
 
    const startMinutes = NINE_FIFTEEN_WINDOW_START.hour * 60 + NINE_FIFTEEN_WINDOW_START.minute;
    const endMinutes = NINE_FIFTEEN_WINDOW_END.hour * 60 + NINE_FIFTEEN_WINDOW_END.minute;
 
    return nowMinutes >= startMinutes && nowMinutes <= endMinutes;
}
// ------------------------------------------------------------------
// END SAFETY GUARD block
// ------------------------------------------------------------------
 
// Tag saved on every trade so we always know which pattern generated it.
const PATTERN_SOURCE = {
    NINE_FIFTEEN: 'NINE_FIFTEEN',
    MW_PATTERN: 'MW_PATTERN',
    FIRST15_ORB: 'FIRST15_ORB'
};
 
// How much (in rupees/paisa) above the High (BUY) / below the Low (SELL)
// of the stock we place the entry order at. e.g. 0.15 = 0.15 paisa.
const ENTRY_PRICE_OFFSET = OMS_CONFIG.ENTRY_PRICE_OFFSET ?? 0.20;
 
// ------------------------------------------------------------------
// SLIPPAGE GUARD:
//   By the time the 3-min candle closes and we've computed entryPrice,
//   the live market has kept moving. If the live LTP is already more
//   than this % away from entryPrice, the order is skipped instead of
//   placed at a price we never actually calculated for. 0 or negative
//   disables the check entirely.
// ------------------------------------------------------------------
const SLIPPAGE_MAX_PERCENT = OMS_CONFIG.SLIPPAGE_MAX_PERCENT ?? 0.5;
 
// Only signals created within this many minutes are considered "fresh".
const SIGNAL_LOOKBACK_MINUTES = OMS_CONFIG.SIGNAL_LOOKBACK_MINUTES ?? 10;
 
// Optional safety filter: only pick up MW signals whose volume+price
// match happened at or after this hour (IST, 24h clock). Checked against
// the REAL breakout candle's time (volumeMatch.time — set by
// mw-nine-fifteen-neckline-confirmation-worker.js's rolling any-time-of-day
// check), not a fixed cutoff on when the worker runs. Defaults to 0
// (midnight) — i.e. OFF, since "any time of day" breakouts are valid by
// design now. Raise this only if you specifically want to skip early-
// morning volatility.
const MW_PATTERN_START_HOUR = OMS_CONFIG.MW_PATTERN_START_HOUR ?? 0;
 
// Optional symbol filter. Leave blank/null to consider ALL symbols
// (needed now since we rank across stocks by ratio and pick the top ones).
const SYMBOL_FILTER = OMS_CONFIG.SYMBOL_FILTER ?? null;
 
// Which side(s) to pick up signals for: 'BUY', 'SELL', or 'BOTH'.
const SIGNAL_SIDE = (OMS_CONFIG.SIGNAL ?? 'BOTH').toUpperCase();
const PICK_BUY = SIGNAL_SIDE === 'BUY' || SIGNAL_SIDE === 'BOTH';
const PICK_SELL = SIGNAL_SIDE === 'SELL' || SIGNAL_SIDE === 'BOTH';
 
// Price range: only stocks priced between these two values are eligible.
// (MIN_PRICE/MAX_PRICE are the current config keys; MIN_SIGNAL_PRICE/
// MAX_SIGNAL_PRICE are kept as a fallback for older config documents.)
const MIN_SIGNAL_PRICE = OMS_CONFIG.MIN_PRICE ?? OMS_CONFIG.MIN_SIGNAL_PRICE ?? 50;
const MAX_SIGNAL_PRICE = OMS_CONFIG.MAX_PRICE ?? OMS_CONFIG.MAX_SIGNAL_PRICE ?? 5000;
 
// Ratio range: only signals whose `ratio` field falls within this range
// are eligible. MAX_RATIO left null/undefined means "no upper bound".
const MIN_SIGNAL_RATIO = OMS_CONFIG.MIN_RATIO ?? 0;
const MAX_SIGNAL_RATIO = OMS_CONFIG.MAX_RATIO ?? null;
 
// Total trading balance (₹) for THIS RUN. It gets split EQUALLY across
// every signal that is actually going to be processed in this run, so
// e.g. BALANCE=20000 with 20 combined signals -> ₹1,000 allocated per
// signal, and quantity for each signal = floor(1000 / entryPrice).
// When null, no balance-based sizing happens (quantity will be 0 and
// every signal gets skipped — see processSignal()).
const TRADING_BALANCE = OMS_CONFIG.BALANCE ?? null;
 
// ------------------------------------------------------------------
// MW-PATTERN-ONLY OVERRIDES — target %, stop-loss %, and quantity for
// MW pattern trades ONLY. Nine-fifteen trades never read these; they
// keep using TARGET_PERCENT / STOP_LOSS_PERCENT / TRADING_BALANCE
// above exactly as before. See the MW_PATTERN block in oms-config.js.
// ------------------------------------------------------------------
const MW_CONFIG = OMS_CONFIG.MW_PATTERN ?? {};
// MW-pattern-only price range (MW_PATTERN.MIN_PRICE / MAX_PRICE). Falls
// back to the shared MIN_PRICE/MAX_PRICE if left null/undefined, so
// Nine-Fifteen's range is never affected by this.
const MW_MIN_PRICE = MW_CONFIG.MIN_PRICE ?? MIN_SIGNAL_PRICE;
const MW_MAX_PRICE = MW_CONFIG.MAX_PRICE ?? MAX_SIGNAL_PRICE;
const MW_TARGET_PERCENT = MW_CONFIG.TARGET_PERCENT ?? OMS_CONFIG.TARGET_PERCENT;
// MW_PATTERN.STOP_LOSS_PERCENT === null means "use the pattern's own
// candle-based stop-loss (signal.stopLoss — the volume-surge candle's
// high for M / low for W) directly, not a percentage at all." Setting it
// to a number (e.g. 1) keeps the old flat-percent-from-entry behavior.
// This flag is read per-signal below (useCandleBasedStop), not folded
// into a single constant here, since it changes which formula runs, not
// just which number feeds the same formula.
const MW_STOP_LOSS_PERCENT = MW_CONFIG.STOP_LOSS_PERCENT ?? OMS_CONFIG.STOP_LOSS_PERCENT;
// A fixed quantity (e.g. 1 or 10) for every MW pattern trade. When set,
// this is used directly and no balance-based math happens at all for MW
// signals. Leave null to size MW trades off a balance instead (either
// MW_CONFIG.BALANCE, or the shared TRADING_BALANCE as a last fallback).
const MW_FIXED_QUANTITY = MW_CONFIG.FIXED_QUANTITY ?? null;
const MW_TRADING_BALANCE = MW_CONFIG.BALANCE ?? null;
// Which MW pattern type(s) to trade — 'W' (BUY only), 'M' (SELL only),
// or 'BOTH' (default). Independent of the shared SIGNAL setting.
const MW_PATTERN_TYPE = (MW_CONFIG.PATTERN_TYPE ?? 'BOTH').toUpperCase();
const MW_PICK_BUY = MW_PATTERN_TYPE === 'W' || MW_PATTERN_TYPE === 'BOTH';
const MW_PICK_SELL = MW_PATTERN_TYPE === 'M' || MW_PATTERN_TYPE === 'BOTH';
// The "3-minute volume" check — whether an MW signal must ALSO have
// volumeConfirmed=true (above-average volume on its breakout candle,
// checked via 3-min candles) to be picked up for trading. Default true
// (same as before). Set MW_PATTERN.REQUIRE_VOLUME_CONFIRMATION to false
// in oms-config.js to disable it.
const MW_REQUIRE_VOLUME_CONFIRMATION = MW_CONFIG.REQUIRE_VOLUME_CONFIRMATION ?? true;
 
// ------------------------------------------------------------------
// FIRST15-ONLY OVERRIDES — see the FIRST15 block in oms-config.js.
// Nine-Fifteen and MW pattern trades never read these.
// ------------------------------------------------------------------
const FIRST15_CONFIG = OMS_CONFIG.FIRST15 ?? {};
 
// How many top-ranked (by `ratio`, highest first) signals to pick PER
// SIDE (BUY and SELL are ranked/picked separately). If, after applying
// the price-range filter, the top-3 by rank aren't all within range,
// the query naturally moves on to the 4th, 5th, etc. highest-ratio
// signal that IS within range — because the price filter is applied
// before ranking/limiting, not after.
// NOTE: declared here (before FIRST15_TOP_N below) because FIRST15_TOP_N
// falls back to this value — as a `const`, referencing it before its own
// declaration line throws "Cannot access 'TOP_N_PER_SIDE' before
// initialization" at module-load time, which crashes the whole worker
// silently under dotenvx before main()'s try/catch ever runs.
const TOP_N_PER_SIDE = OMS_CONFIG.TOP_N_PER_SIDE ?? 10;
 
// Broker this strategy trades through — independent of the shared
// OMS_CONFIG.BROKER used by Nine-Fifteen/MW. Falls back to the shared
// broker only if FIRST15.BROKER was never set.
const FIRST15_BROKER = FIRST15_CONFIG.BROKER ?? OMS_CONFIG.BROKER;
const FIRST15_ENTRY_PRICE_OFFSET = FIRST15_CONFIG.ENTRY_PRICE_OFFSET ?? ENTRY_PRICE_OFFSET;
// ₹ added on top of the trigger level for the limit price sent once the
// trigger fires — see TRIGGER_LIMIT_BUFFER in oms-config.js.
const FIRST15_TRIGGER_LIMIT_BUFFER = FIRST15_CONFIG.TRIGGER_LIMIT_BUFFER ?? 0.50;
const FIRST15_MIN_PRICE = FIRST15_CONFIG.MIN_PRICE ?? 0;
const FIRST15_MAX_PRICE = FIRST15_CONFIG.MAX_PRICE ?? Number.MAX_SAFE_INTEGER;
const FIRST15_TOP_N = FIRST15_CONFIG.TOP_N ?? TOP_N_PER_SIDE;
const FIRST15_TRADING_BALANCE = FIRST15_CONFIG.BALANCE ?? null;
const FIRST15_FIXED_QUANTITY = FIRST15_CONFIG.FIXED_QUANTITY ?? null;
 
// % of quantity sold at target1 — the rest runs to target2 with a
// step-trailed SL. Dynamic (was a hardcoded 50/50 split). See
// oms-config.js FIRST15.TARGET1_EXIT_PERCENT for the full explanation.
const FIRST15_TARGET1_EXIT_PERCENT = FIRST15_CONFIG.TARGET1_EXIT_PERCENT ?? 50;
 
 
/**
 * Returns an ISO string for today's date at the given hour (local time),
 * with minutes/seconds/ms zeroed out. Used for the "MW pattern only
 * picked up from 12pm onward" rule, and (with hour=24) for "start of
 * tomorrow" as an end-of-today boundary. Returns an ISO STRING because
 * the date fields we compare against (createdAt, volumeConfirmationUpdatedAt)
 * are stored as ISO strings in Mongo — comparing against a raw Date object
 * would silently fail to match due to BSON type ordering.
 */
function getTodayAtHour(hour) {
    const d = new Date();
    d.setHours(hour, 0, 0, 0);
    return d.toISOString();
}
function getTodayDateString() {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
/**
 * Fetches the TOP_N_PER_SIDE highest-`ratio` unprocessed signals for a
 * single side (BUY or SELL) from the 9:15 AM pattern collection, within
 * the configured price range. Because the price-range filter runs in
 * the DB query BEFORE the ratio sort + limit, a higher-ratio stock that
 * falls outside the price range is automatically skipped and the next
 * one in rank order takes its place — the "if not found in range, pick
 * the 4th one" behaviour.
 */
async function fetchTopNineFifteenSignals(db, { side, startTime }) {
 
    const query = {
        // $ne: true (not `processed: false`) because docs may not have a
        // `processed` field at all yet — `processed: false` would wrongly
        // exclude those.
        // processed: { $ne: true },
        signal: side, // 'BUY' or 'SELL'
        // symbol: "LICHSGFIN",
        // createdAt: { $gte: startTime },
        date: getTodayDateString(), // e.g. "2026-07-17" — always current date, not hardcode
        priceAtSignal: { $gte: MIN_SIGNAL_PRICE, $lte: MAX_SIGNAL_PRICE },
        ratio: MAX_SIGNAL_RATIO != null
            ? { $gte: MIN_SIGNAL_RATIO, $lte: MAX_SIGNAL_RATIO }
            : { $gte: MIN_SIGNAL_RATIO }
    };
 
    if (SYMBOL_FILTER) {
        query.symbol = SYMBOL_FILTER;
    }
 
    const rankedSignals = await db.collection(NINE_FIFTEEN_COLLECTION)
        .find(query)
        .sort({ ratio: -1 }) // highest ratio first
        .limit(TOP_N_PER_SIDE)
        .toArray();
 
    return rankedSignals.map(signal => ({
        ...signal,
        patternSource: PATTERN_SOURCE.NINE_FIFTEEN,
        sourceCollection: NINE_FIFTEEN_COLLECTION
    }));
}
 
/**
 * Fetches the TOP_N_PER_SIDE highest-`confidence` unprocessed W/M
 * patterns for a single side from mw_patterns.
 *
 * Schema, matching what mw-nine-fifteen-neckline-confirmation-worker.js
 * actually writes (see its resultDoc / findConfirmation()):
 *   - No `signal` field — side comes from `type`:
 *       type: 'W' -> BUY   (double-bottom / bullish breakout)
 *       type: 'M' -> SELL  (double-top / bearish breakdown)
 *   - No `ratio` field — ranked by `confidence` instead.
 *   - The neckline price is the flat field `resistance`, not a nested
 *     `neckline.price` — used for both the price-range filter and as
 *     the High/Low equivalent for the entry-price offset rule below.
 *   - A pattern only actually TRADEABLE once its neckline has broken —
 *     that's `status: 'confirmed'` (NOT 'forming' — 'forming' means the
 *     break hasn't happened yet, so trading those would mean entering
 *     before any breakout at all).
 *   - The volume confirmation flag is the flat boolean `volumeConfirmed`,
 *     not a nested `volumeConfirmation.confirmed`.
 *   - The date the neckline actually broke is `pointCDate` (only set
 *     once status is 'confirmed') — that's the "only today's breakouts"
 *     freshness check, replacing the old (nonexistent)
 *     volumeConfirmationUpdatedAt field.
 */
async function fetchTopMwPatternSignals(db, { side }) {
 
    const patternType = side === 'BUY' ? 'W' : 'M';
    const todayStr = getTodayDateString();
 
    const query = {
        processed: { $ne: true },
        type: patternType,
        status: 'confirmed',        // neckline has actually broken
        pointCDate: todayStr,       // AND that break happened today, not some earlier day
        resistance: { $gte: MW_MIN_PRICE, $lte: MW_MAX_PRICE }
    };
 
    // The "3-minute volume" check — only required when
    // MW_PATTERN.REQUIRE_VOLUME_CONFIRMATION is true (default). Set it
    // to false in oms-config.js to trade confirmed breakouts even
    // without this extra volume check.
    if (MW_REQUIRE_VOLUME_CONFIRMATION) {
        query.volumeConfirmed = true;
    }
 
    if (SYMBOL_FILTER) {
        query.symbol = SYMBOL_FILTER;
    }
 
    const rankedSignals = await db.collection(MW_PATTERN_COLLECTION)
        .find(query)
        .sort({ confidence: -1 }) // highest confidence first
        .limit(TOP_N_PER_SIDE)
        .toArray();
 
    // Optional hour-of-day safety filter (see MW_PATTERN_START_HOUR above)
    // applied against the ACTUAL breakout candle's time, in IST — not the
    // time this worker happens to be running.
    const filtered = MW_PATTERN_START_HOUR > 0
        ? rankedSignals.filter(doc => {
            if (!doc.volumeMatch?.time) return true; // no candle-time info — don't block it
            const hourIST = Number(new Intl.DateTimeFormat('en-GB', {
                timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false
            }).format(new Date(doc.volumeMatch.time)));
            return hourIST >= MW_PATTERN_START_HOUR;
        })
        : rankedSignals;
 
    return filtered.map(doc => ({
        ...doc,
        signal: side, // normalized BUY/SELL so processSignal() can treat both collections the same way
        high: side === 'BUY' ? doc.resistance : doc.high,
        low: side === 'SELL' ? doc.resistance : doc.low,
        patternSource: PATTERN_SOURCE.MW_PATTERN,
        sourceCollection: MW_PATTERN_COLLECTION
    }));
}
 
/**
 * Fetches the FIRST15_TOP_N highest-`volumeVsAvgRatio` unprocessed
 * First-15-Minute ORB signals for TODAY from `detected_orb_patterns`
 * (written by wisdom-orb-pattern-worker.js). BUY-only — strategy.docx
 * has no short/SELL leg for this strategy, so there is no `side`
 * parameter here (unlike the other two fetchTop* functions).
 */
async function fetchTopFirst15Signals(db) {
 
    const query = {
        processed: { $ne: true },
        date: getTodayDateString(),
        high: { $gte: FIRST15_MIN_PRICE, $lte: FIRST15_MAX_PRICE }
    };
 
    if (SYMBOL_FILTER) {
        query.symbol = SYMBOL_FILTER;
    }
 
    const rankedSignals = await db.collection(FIRST15_COLLECTION)
        .find(query)
        .sort({ volumeVsAvgRatio: -1 }) // highest volume-vs-average ratio first
        .limit(FIRST15_TOP_N)
        .toArray();
 
    return rankedSignals.map(signal => ({
        ...signal,
        signal: 'BUY', // long-only strategy
        patternSource: PATTERN_SOURCE.FIRST15_ORB,
        sourceCollection: FIRST15_COLLECTION
    }));
}
 
 
/**
 * @param {object} signal - the signal document to trade
 * @param {number|null} allocatedBalance - the ₹ amount THIS signal gets
 *   to spend. This is TRADING_BALANCE / (number of signals in the run),
 *   NOT the full TRADING_BALANCE — that's what makes the money spread
 *   evenly across every signal instead of being re-spent in full on
 *   each one. Computed once in main() and passed down here.
 */
async function processSignal(signal, allocatedBalance, accountId = PRIMARY_ACCOUNT_ID) {
 
    // `accountId` = which of your trading accounts places this order (ACC1 = the original
    // account; ACC2/ACC3 are the extra Nine-Fifteen accounts). Default ACC1 = unchanged behaviour.
    const broker =
        getBrokerAdapter(
            OMS_CONFIG.BROKER,
            accountId
        );
    // ---- SAFETY GUARD: never let this signal's order reach the wrong
    // broker/account. See assertBrokerMatches() in broker-factory.js. ----
    assertBrokerMatches(broker, OMS_CONFIG.BROKER, `Nine-Fifteen/MW signal ${signal.symbol}`);
    assertAccountMatches(broker, accountId, `signal ${signal.symbol}`);
 
    // ------------------------------------------------------------------
    // ENTRY PRICE RULE:
    //   BUY  -> ENTRY_PRICE_OFFSET (e.g. 0.15) ABOVE the stock's High
    //   SELL -> ENTRY_PRICE_OFFSET (e.g. 0.15) BELOW the stock's Low
    // NOTE: this assumes the signal document carries `high` / `low`
    // fields for the stock (for mw_patterns, `neckline.price` is mapped
    // onto high/low before this runs — see fetchTopMwPatternSignals).
    // If they're missing for some reason, we fall back to
    // signal.priceAtSignal so the worker doesn't crash, but that should
    // be treated as a data problem upstream.
    // ------------------------------------------------------------------
    let entryPrice;
 
    if (signal.signal === 'BUY') {
 
        const referenceHigh = signal.high ?? signal.priceAtSignal;
 
        entryPrice = Number(
            (referenceHigh + ENTRY_PRICE_OFFSET).toFixed(2)
        );
 
    } else {
 
        const referenceLow = signal.low ?? signal.priceAtSignal;
 
        entryPrice = Number(
            (referenceLow - ENTRY_PRICE_OFFSET).toFixed(2)
        );
    }
 
    const isMwPattern = signal.patternSource === PATTERN_SOURCE.MW_PATTERN;
 
    // ------------------------------------------------------------------
    // QUANTITY RULE:
    //   MW PATTERN signals: if MW_FIXED_QUANTITY is set (e.g. 1 or 10),
    //   use it directly — no balance math at all, same quantity every
    //   time regardless of price. This is the "just always trade 1 / 10
    //   quantity" switch.
    //
    //   Everything else (nine-fifteen signals, or MW signals when
    //   MW_FIXED_QUANTITY is null): each signal gets an EQUAL SLICE of
    //   its pool's balance (`allocatedBalance`, computed in
    //   runOmsCycle()). Quantity is floor(allocatedBalance / entryPrice)
    //   — e.g. 20 signals with a ₹20,000 pool -> ₹1,000 allocated per
    //   signal -> qty = floor(1000 / entryPrice) for each one.
    //   There is no static fallback quantity here — if no balance is
    //   configured, or the per-signal slice can't afford even 1 unit at
    //   the entry price, the signal is skipped (see caller).
    // ------------------------------------------------------------------
    const quantity = (isMwPattern && MW_FIXED_QUANTITY != null)
        ? MW_FIXED_QUANTITY
        : (allocatedBalance != null ? Math.floor(allocatedBalance / entryPrice) : 0);
 
    if (quantity <= 0) {
 
        console.log(
            'Skipping signal:', signal.symbol,
            '— allocated balance ₹' + allocatedBalance,
            'cannot afford even 1 unit at entry price', entryPrice
        );
 
        return null;
    }
 
    // Target %/Stop-loss %: MW pattern signals use MW_TARGET_PERCENT /
    // MW_STOP_LOSS_PERCENT (from OMS_CONFIG.MW_PATTERN, falling back to
    // the shared TARGET_PERCENT/STOP_LOSS_PERCENT if not set). Every
    // other signal (nine-fifteen) keeps using the shared values exactly
    // as before — completely unaffected by the MW_PATTERN block.
    const stopLossPercent = isMwPattern ? MW_STOP_LOSS_PERCENT : OMS_CONFIG.STOP_LOSS_PERCENT;
    const targetPercent = isMwPattern ? MW_TARGET_PERCENT : OMS_CONFIG.TARGET_PERCENT;
 
    // Only MW pattern signals can trigger this — Nine-Fifteen never reads
    // MW_CONFIG. If MW_PATTERN.STOP_LOSS_PERCENT is explicitly null AND
    // the signal actually carries a usable candle-based stopLoss (set by
    // mw-nine-fifteen-neckline-confirmation-worker.js — the volume-surge
    // candle's high for M / low for W), use that number directly instead
    // of computing a percentage. If it's null but signal.stopLoss is
    // missing or not a finite number for some reason, fall back to the
    // percent formula below rather than placing an order with a broken
    // stop-loss.
    const useCandleBasedStop =
        isMwPattern &&
        MW_CONFIG.STOP_LOSS_PERCENT === null &&
        typeof signal.stopLoss === 'number' &&
        Number.isFinite(signal.stopLoss);
 
    if (isMwPattern && MW_CONFIG.STOP_LOSS_PERCENT === null && !useCandleBasedStop) {
        console.warn(
            `[OMS] ⚠️ MW_PATTERN.STOP_LOSS_PERCENT is null (candle-based stop requested) but ` +
            `${signal.symbol}'s signal.stopLoss is missing/invalid (${signal.stopLoss}) — ` +
            `falling back to percent-based stop (${stopLossPercent}%) for this order only.`
        );
    }
 
    const stopLossPrice = useCandleBasedStop
        ? signal.stopLoss
        : (signal.signal === 'BUY'
            ? entryPrice * (1 - stopLossPercent / 100)   // below for BUY
            : entryPrice * (1 + stopLossPercent / 100)); // above for SELL
 
    const targetPrice = signal.signal === 'BUY'
        ? entryPrice * (1 + targetPercent / 100)      // above for BUY
        : entryPrice * (1 - targetPercent / 100);     // below for SELL
 
    console.log(`Processing signal [${accountId}]:`, signal.symbol, signal.signal, 'ratio:', signal.ratio);
    console.log('Pattern source:', signal.patternSource);
    console.log(
        useCandleBasedStop
            ? `Using stop-loss: candle-based, ${stopLossPrice} (MW_PATTERN.STOP_LOSS_PERCENT is null — volume-surge candle high/low from signal.stopLoss)`
            : `Using target%: ${targetPercent}, stopLoss%: ${stopLossPercent} ${isMwPattern ? '(MW_PATTERN settings)' : '(shared/nine-fifteen settings)'}`
    );
    if (isMwPattern && MW_FIXED_QUANTITY != null) {
        console.log('Using MW fixed quantity:', MW_FIXED_QUANTITY);
    }
    console.log('Allocated balance for this signal:', allocatedBalance);
    console.log('Calculated entry price:', entryPrice);
    console.log('Calculated stop loss price:', stopLossPrice);
    console.log('Calculated target price:', targetPrice);
    console.log('Calculated quantity:', quantity);
 
    // ------------------------------------------------------------------
    // SLIPPAGE GUARD (MW_PATTERN signals only):
    // entryPrice was calculated from the 3-min candle that just closed,
    // but placing this order still takes a live round-trip. Check the
    // CURRENT live price right before firing the order — if it has
    // already run past entryPrice by more than SLIPPAGE_MAX_PERCENT,
    // skip the trade instead of chasing a price we never actually
    // calculated for. Nine-fifteen signals are untouched — original
    // behavior, no slippage check.
    // ------------------------------------------------------------------
    if (isMwPattern && SLIPPAGE_MAX_PERCENT > 0) {
 
        const livePrice =
            await broker.getLTP({
                symbol: signal.symbol
            });
 
        if (livePrice == null) {
 
            console.log(
                'Slippage check: could not fetch live LTP for', signal.symbol,
                '— proceeding without the check.'
            );
 
        } else {
 
            const slippagePercent =
                Math.abs(livePrice - entryPrice) / entryPrice * 100;
 
            if (slippagePercent > SLIPPAGE_MAX_PERCENT) {
 
                console.log(
                    'Skipping signal:', signal.symbol,
                    '— price already moved', slippagePercent.toFixed(2) + '%',
                    'past entry price (live:', livePrice, ', entry:', entryPrice, ',',
                    'limit:', SLIPPAGE_MAX_PERCENT + '%)'
                );
 
                return null;
            }
 
            console.log(
                'Slippage check passed:', signal.symbol,
                'live:', livePrice, 'entry:', entryPrice,
                '(' + slippagePercent.toFixed(2) + '% move)'
            );
        }
    }
 
    const trade =
        createTrade({
            signal,
            quantity,
            entryPrice,
            stopLossPrice,
            targetPrice,
            // Flag stored on the trade so we always know whether this
            // trade came from the 9:15 pattern, the MW pattern, or (in
            // BOTH mode) whichever of the two actually produced it.
            patternSource: signal.patternSource,
            broker: OMS_CONFIG.BROKER,
            accountId
        });
 
    const order =
        await broker.placeEntryOrder({
 
            symbol:
                signal.symbol,
 
            side:
                signal.signal,
 
            quantity,
 
            price:
                entryPrice
        });
 
    if (!order.success) {
 
        throw new Error(
            'Entry order failed'
        );
    }
 
    trade.entryOrderId =
        order.brokerOrderId;
 
    // Order was successfully placed with the broker — flip status from
    // the default 'ENTRY_PENDING' (set in createTrade) to 'ORDER_PLACED'
    // so downstream workers (e.g. fyers-socket.js, which watches for
    // status: 'ORDER_PLACED') pick this trade up correctly.
    trade.status = 'ORDER_PLACED';
    trade.updatedAt = new Date().toISOString();
 
    return trade;
}
 
/**
 * FIRST15_ORB is handled separately from processSignal() because it
 * produces TWO trades per signal (50% at the 1:1 target, 50% at the 1:2
 * target — see strategy.docx), not one — and its stop-loss/targets are
 * computed from the qualifying candle's actual High/Low (risk-based),
 * not a flat target%/stop-loss% like Nine-Fifteen/MW.
 *
 * Entry is placed immediately (same as the other two strategies use
 * this same file for) as a TRIGGER order (Stop-Limit) at High +
 * FIRST15_ENTRY_PRICE_OFFSET — it only activates once price actually
 * crosses that level, which is what "enters on break of the first
 * candle's high" is supposed to mean. (Previously this was a plain
 * resting Limit order — changed because a Limit order can fill right
 * away if price is already through the level, with no real "breakout"
 * confirmation at all.)
 *
 * @returns {object[]} 0, 1, or 2 trade documents that were actually
 *   placed with the broker (a leg is silently dropped if its 50% share
 *   of the allocated balance can't afford even 1 unit, or if its order
 *   fails with the broker — the other leg still goes through).
 */
async function processFirst15Signal(signal, allocatedBalance) {
 
    // Hard guard: this strategy is long-only per strategy.docx. Even
    // though fetchTopFirst15Signals() always tags these 'BUY' itself,
    // this check makes it impossible for a SELL trade to ever be placed
    // here, no matter what the signal document says.
    if (signal.signal !== 'BUY') {
        console.log('Skipping FIRST15 signal:', signal.symbol, '— strategy is long-only, got side:', signal.signal);
        return [];
    }
 
    const broker = getBrokerAdapter(FIRST15_BROKER);
    // ---- SAFETY GUARD ----
    // FIRST15_ORB has its OWN broker (OMS_CONFIG.FIRST15.BROKER), separate
    // from the shared OMS_CONFIG.BROKER that Nine-Fifteen/MW use. This is
    // exactly the kind of setup where a config edit or refactor could
    // silently mix the two up and place a FIRST15 order on the wrong
    // account. assertBrokerMatches() throws (never places the order) if
    // the adapter we actually got back isn't tagged as FIRST15_BROKER —
    // it does NOT touch anything on the websocket side; that guard lives
    // separately in fyers-socket.js (see getBroker()/placeExitOrder()
    // there), which watches its own order-status feed for the SAME kind
    // of mismatch before firing an exit order.
    assertBrokerMatches(broker, FIRST15_BROKER, `FIRST15 signal ${signal.symbol}`);
 
    const entryPrice = Number((signal.high + FIRST15_ENTRY_PRICE_OFFSET).toFixed(2));
    const stopLossPrice = signal.low; // fixed — the qualifying candle's Low, per strategy.docx
    const risk = entryPrice - stopLossPrice;
 
    if (!(risk > 0)) {
        console.log('Skipping FIRST15 signal:', signal.symbol, '— invalid candle (Low not below entry price).');
        return [];
    }
 
    const target1Price = Number((entryPrice + risk).toFixed(2));       // 1:1
    const target2Price = Number((entryPrice + 2 * risk).toFixed(2));   // 1:2
 
    // FIXED_QUANTITY (when set) always wins — same convention as
    // MW_PATTERN.FIXED_QUANTITY. Otherwise fall back to the existing
    // balance-based sizing (floor(allocatedBalance / entryPrice)).
    const totalQuantity = FIRST15_FIXED_QUANTITY != null
        ? FIRST15_FIXED_QUANTITY
        : (allocatedBalance != null ? Math.floor(allocatedBalance / entryPrice) : 0);
 
    if (totalQuantity <= 0) {
        console.log(
            'Skipping FIRST15 signal:', signal.symbol,
            '— allocated balance ₹' + allocatedBalance,
            'cannot afford even 1 unit at entry price', entryPrice
        );
        return [];
    }
 
    console.log('Processing FIRST15 signal:', signal.symbol, 'volumeVsAvgRatio:', signal.volumeVsAvgRatio);
    console.log('Broker:', FIRST15_BROKER, '| Entry price:', entryPrice, '| SL:', stopLossPrice, '| T1(1:1):', target1Price, '| T2(1:2):', target2Price);
    console.log('Allocated balance:', allocatedBalance, '| totalQuantity:', totalQuantity);
 
    // ------------------------------------------------------------------
    // SINGLE ENTRY ORDER — one order for the full quantity. The 50/50
    // split across target1/target2 (and the SL move to target1 once
    // target1 is hit) is NOT done via two separate broker entry orders
    // any more; it's tracked on this ONE trade doc and executed by
    // fyers-socket.js as partial exits against the live tick feed.
    // This behaviour is exclusive to FIRST15 — Nine-Fifteen and MW
    // pattern trades are untouched and keep going through
    // processSignal() with a single fixed target/SL exactly as before.
    // ------------------------------------------------------------------
    const trade = createTrade({
        signal,
        quantity: totalQuantity,
        entryPrice,
        stopLossPrice,
        targetPrice: target2Price, // final target, once target1 leg is done
        patternSource: PATTERN_SOURCE.FIRST15_ORB,
        broker: FIRST15_BROKER
    });
 
    trade.target1Price = target1Price;
    trade.target2Price = target2Price;
    trade.target1Hit = false;
    // Dynamic split — FIRST15_TARGET1_EXIT_PERCENT % sold on target1,
    // the remainder runs on toward target2 (step-trailed once
    // target1 hits). Math.ceil so a fraction always rounds the
    // target1 leg up rather than leaving a 0-qty runner on tiny
    // totalQuantity values (e.g. qty 1 at 70% still sells all of it).
    // NOTE: target1Price/target2Price/target1Quantity/target2Quantity
    // above are kept ONLY for the historical backtest report
    // (first15-backtest-service.js) — live trading now follows
    // trade.orbLadder below instead. See TARGET_LADDER in oms-config.js.
    trade.target1Quantity = Math.min(
        totalQuantity,
        Math.ceil(totalQuantity * (FIRST15_TARGET1_EXIT_PERCENT / 100))
    );
    trade.target2Quantity = totalQuantity - trade.target1Quantity; // sold on target2 (the runner)
    trade.remainingQuantity = totalQuantity;                    // decremented by fyers-socket.js as legs exit
    trade.originalQuantity = totalQuantity;
 
    // ------------------------------------------------------------------
    // LIVE ladder — 4 profit-booking steps + whatever's left rides to
    // the market-close square-off. Quantities are computed with
    // Math.floor + a running remainder (not Math.round independently
    // per step) so the 4 steps can never accidentally add up to MORE
    // than totalQuantity — any rounding leftover simply becomes part of
    // the final EOD quantity instead, which is safe since that's
    // getting fully exited anyway.
    // ------------------------------------------------------------------
    let qtyLeftToAllocate = totalQuantity;
    trade.orbLadder = (FIRST15_CONFIG.TARGET_LADDER ?? []).map((rung) => {
        const sellQuantity = rung.sellPercent > 0
            ? Math.min(qtyLeftToAllocate, Math.floor(totalQuantity * (rung.sellPercent / 100)))
            : 0;
        qtyLeftToAllocate -= sellQuantity;
        return {
            targetPrice: Number((entryPrice * (1 + rung.targetPercent / 100)).toFixed(2)),
            slPrice: Number((entryPrice * (1 + rung.slPercent / 100)).toFixed(2)),
            sellPercent: rung.sellPercent,
            sellQuantity,
            hit: false,
        };
    });
    trade.orbEodQuantity = qtyLeftToAllocate; // whatever's left after the ladder — squared off at close
    console.log(
        'FIRST15 ladder for', signal.symbol, ':',
        trade.orbLadder.map(r => `+${r.sellPercent}% qty @ ${r.targetPrice} (SL->${r.slPrice})`).join(' | '),
        '| EOD qty:', trade.orbEodQuantity
    );
 
    try {
        if (typeof broker.placeTriggerEntryOrder !== 'function') {
            // Defensive: FIRST15_BROKER is 'WISDOM' today (see
            // oms-config.js), and only WisdomAdapter implements the
            // trigger-order method. If the config is ever pointed at a
            // different broker before that adapter gets the same method
            // added, fail loudly here instead of silently falling back
            // to a plain Limit order (the exact behaviour we're moving
            // away from).
            throw new Error(`placeTriggerEntryOrder() is not implemented for broker "${FIRST15_BROKER}"`);
        }
 
        const limitPrice = Number((entryPrice + FIRST15_TRIGGER_LIMIT_BUFFER).toFixed(2));
 
        const order = await broker.placeTriggerEntryOrder({
            symbol: signal.symbol,
            side: 'BUY',
            quantity: totalQuantity,
            triggerPrice: entryPrice,
            limitPrice
        });
 
        if (!order.success) {
            console.error(`[OMS] FIRST15 entry order failed for ${signal.symbol}:`, order.error);
            return [];
        }
 
        trade.entryOrderId = order.brokerOrderId;
        trade.status = 'ORDER_PLACED';
        trade.updatedAt = new Date().toISOString();
 
        return [trade];
 
    } catch (err) {
        console.error(`[OMS] FIRST15 entry exception for ${signal.symbol}:`, err.message);
        return [];
    }
}
 
/**
 * Core signal-fetch + order-placement cycle. Runs ONE pass: pick up
 * eligible signals per the given (or config-default) switches, split the
 * given (or config-default) balance across them, place orders. NEVER
 * calls process.exit() — safe to call repeatedly from a long-running
 * process (e.g. mw-live-scan-worker.js's loop) as well as from the CLI
 * entry point below.
 *
 * @param {object} [overrides] - optional per-call overrides, layered on
 *   top of OMS_CONFIG so callers don't need to touch the config file or
 *   env vars to run a different combination in-process:
 *     runNineFifteen {boolean} - defaults to RUN_NINE_FIFTEEN
 *     runMwPattern   {boolean} - defaults to RUN_MW_PATTERN
 *     balance        {number|null} - defaults to TRADING_BALANCE
 * @param {import('mongodb').Db} [existingDb] - reuse an already-open DB
 *   connection (e.g. the one mw-live-scan-worker.js already holds)
 *   instead of opening a new one each call.
 */
async function runOmsCycle(overrides = {}, existingDb = null) {
 
    const runNineFifteen = overrides.runNineFifteen ?? RUN_NINE_FIFTEEN;
    const runMwPattern = overrides.runMwPattern ?? RUN_MW_PATTERN;
    const runFirst15 = overrides.runFirst15 ?? RUN_FIRST15;
    const balance = overrides.balance !== undefined ? overrides.balance : TRADING_BALANCE;
 
    if (!runNineFifteen && !runMwPattern && !runFirst15) {
        console.log('[OMS] runNineFifteen, runMwPattern and runFirst15 are all false — nothing to do this cycle.');
        return { placed: 0, signals: 0 };
    }
 
    const db = existingDb || await connectToDatabase();
 
    // ── Flush any trades from a PREVIOUS run whose broker order succeeded
    // but whose DB save failed (e.g. a Mongo timeout mid-write). This is
    // safe to call every cycle — it only ever retries the DB write, never
    // places another broker order. Doing this FIRST, before fetching new
    // signals, means a stuck trade gets saved before we'd otherwise risk
    // re-fetching its still-"unprocessed" signal below.
    try {
        await reconcilePendingTradeSync(db);
    } catch (err) {
        console.warn('[OMS] Pending-trade-sync reconciliation failed this cycle:', err.message);
    }
 
    // Signals still waiting on the reconciliation above (DB may still be
    // down) — never reprocess these as if they were brand new, or we'd
    // place a second broker order for a signal that already has one.
    const pendingSignalIds = getPendingSignalIds();
 
    const lookbackStart = new Date(
        Date.now() - SIGNAL_LOOKBACK_MINUTES * 60 * 1000
    ).toISOString();
 
    let combinedSignals = [];
 
    // ---- 9:15 AM pattern: top N by ratio, per side (BUY / SELL) ----
    if (runNineFifteen) {
        const [topBuys, topSells] = await Promise.all([
            fetchTopNineFifteenSignals(db, { side: 'BUY', startTime: lookbackStart }),
            fetchTopNineFifteenSignals(db, { side: 'SELL', startTime: lookbackStart })
        ]);
 
        if (PICK_BUY) combinedSignals.push(...topBuys);
        if (PICK_SELL) combinedSignals.push(...topSells);
    }
 
    // ---- MW pattern: top N by confidence, per side, neckline actually
    //      broken today (status='confirmed') AND volumeConfirmed=true ----
    if (runMwPattern) {
        // MW_PICK_BUY/MW_PICK_SELL (from MW_PATTERN.PATTERN_TYPE) control
        // W-vs-M independently of the shared SIGNAL setting; PICK_BUY/
        // PICK_SELL (shared with nine-fifteen) still apply on top, so
        // both switches have to allow a side for it to be traded.
        const [topBuys, topSells] = await Promise.all([
            (PICK_BUY && MW_PICK_BUY) ? fetchTopMwPatternSignals(db, { side: 'BUY' }) : [],
            (PICK_SELL && MW_PICK_SELL) ? fetchTopMwPatternSignals(db, { side: 'SELL' }) : []
        ]);
 
        combinedSignals.push(...topBuys, ...topSells);
    }
 
    // First-15 ORB: top N by volumeVsAvgRatio, BUY only ----
    // strategy.docx is explicitly long-only ("if the first candle's high
    // get break") — the ORB worker never even evaluates a short/SELL
    // side, and this is hardcoded to 'BUY' below regardless of the
    // shared SIGNAL setting (SIGNAL: 'SELL' or 'BOTH' only ever affects
    // Nine-Fifteen/MW's side selection — it never gates or flips this
    // strategy, since there is no SELL leg for it to gate).
    if (runFirst15) {
        const topFirst15 = await fetchTopFirst15Signals(db);
        combinedSignals.push(...topFirst15);
    }
 
    if (pendingSignalIds.size) {
        const before = combinedSignals.length;
        combinedSignals = combinedSignals.filter(s => !pendingSignalIds.has(String(s._id)));
        const skipped = before - combinedSignals.length;
        if (skipped) {
            console.log(`[OMS] Skipping ${skipped} signal(s) still waiting on background DB reconciliation.`);
        }
    }
 
    if (!combinedSignals.length) {
        console.log('[OMS] No signals this cycle.');
        return { placed: 0, signals: 0 };
    }
 
    // ------------------------------------------------------------------
    // MONEY DISTRIBUTION:
    //   Nine-fifteen and MW pattern signals are split from SEPARATE
    //   pools, each divided equally among just its own signals — this
    //   is what lets MW pattern trades use their own BALANCE/quantity
    //   settings without touching how nine-fifteen sizes its trades,
    //   even when both run together in one call (runNineFifteen=true
    //   AND runMwPattern=true).
    //
    //   - Nine-fifteen signals: split `balance` (the run's/override's
    //     TRADING_BALANCE) across ONLY the nine-fifteen signals.
    //   - MW pattern signals: if MW_FIXED_QUANTITY is set, no balance
    //     math happens at all for them (handled per-signal in
    //     processSignal()). Otherwise split MW_TRADING_BALANCE (falling
    //     back to `balance` if MW_TRADING_BALANCE isn't set) across
    //     ONLY the MW pattern signals.
    // ------------------------------------------------------------------
    const nineFifteenSignals = combinedSignals.filter(
        s => s.patternSource === PATTERN_SOURCE.NINE_FIFTEEN
    );
    const mwPatternSignals = combinedSignals.filter(
        s => s.patternSource === PATTERN_SOURCE.MW_PATTERN
    );
    const first15Signals = combinedSignals.filter(
        s => s.patternSource === PATTERN_SOURCE.FIRST15_ORB
    );
 
    const allocatedBalancePerNineFifteenSignal =
        balance != null && nineFifteenSignals.length > 0
            ? balance / nineFifteenSignals.length
            : null;

    // ------------------------------------------------------------------
    // MULTI-ACCOUNT NINE-FIFTEEN
    // OMS_ACCOUNTS (e.g. "ACC1,ACC2,ACC3") picks the accounts that trade Nine-Fifteen. Default is
    // just ACC1 = exactly the old single-account behaviour. With more than one account, every
    // Nine-Fifteen signal is sent to ALL of them AT THE SAME TIME (parallel, not one by one).
    // Each account sizes from its OWN balance (<PREFIX>BALANCE, else the shared balance).
    // MW Pattern and FIRST15 are untouched and keep trading on ACC1 only.
    // ------------------------------------------------------------------
    let nineFifteenAccountIds = [PRIMARY_ACCOUNT_ID];
    let multiAccount = false;
    if (nineFifteenSignals.length > 0) {
        const wanted = enabledAccountIds();
        const brokerIsShoonya = String(OMS_CONFIG.BROKER || '').toUpperCase() === 'SHOONYA';
        if (wanted.length > 1 && !brokerIsShoonya) {
            console.error(`[OMS] OMS_ACCOUNTS lists ${wanted.join(',')} but OMS_CONFIG.BROKER is ${OMS_CONFIG.BROKER} — extra accounts are Shoonya-only, trading ACC1 only.`);
        } else if (wanted.length > 1) {
            multiAccount = true;
            // Log every account in at once BEFORE any order, so a slow/failed login on one account
            // can never leave another account's already-placed order unsaved.
            const { ready, notReady } = await prepareAccounts({
                accountIds: wanted,
                getToken: (id) => getActiveShoonyaToken(false, id),
            });
            nineFifteenAccountIds = ready;
            for (const n of notReady) {
                alertOrderNotPlaced('NINE_FIFTEEN batch', new Error(`${n.accountId} not ready: ${n.error}`), { Account: n.accountId });
            }
            console.log(`[OMS] Nine-Fifteen accounts this cycle: ready=[${ready.join(', ') || 'none'}]${notReady.length ? ` skipped=[${notReady.map(n => n.accountId).join(', ')}]` : ''}`);
        }
    }
    const nineFifteenAllocatedFor = (accountId) => {
        const accBalance = getAccountBalance(accountId) ?? balance;
        return accBalance != null && nineFifteenSignals.length > 0 ? accBalance / nineFifteenSignals.length : null;
    };
 
    const mwBalanceForSplit = MW_TRADING_BALANCE ?? balance;
    const allocatedBalancePerMwSignal =
        MW_FIXED_QUANTITY == null && mwBalanceForSplit != null && mwPatternSignals.length > 0
            ? mwBalanceForSplit / mwPatternSignals.length
            : null;
 
    // FIRST15_ORB gets its own pool too (FIRST15.BALANCE, falling back
    // to the shared `balance` if not set) — split evenly across however
    // many qualifying stocks came in this run, then split 50/50 AGAIN
    // per-signal inside processFirst15Signal() for the two target legs.
    // If FIRST15_FIXED_QUANTITY is set, no balance math happens at all
    // (handled directly in processFirst15Signal()) — same convention as
    // MW_FIXED_QUANTITY above.
    const first15BalanceForSplit = FIRST15_TRADING_BALANCE ?? balance;
    const allocatedBalancePerFirst15Signal =
        FIRST15_FIXED_QUANTITY == null && first15BalanceForSplit != null && first15Signals.length > 0
            ? first15BalanceForSplit / first15Signals.length
            : null;
 
    // Look up each signal's allocated balance by its own patternSource
    // (rather than one shared value for the whole combined array).
    const allocatedBalanceFor = (signal) => {
        if (signal.patternSource === PATTERN_SOURCE.MW_PATTERN) return allocatedBalancePerMwSignal;
        if (signal.patternSource === PATTERN_SOURCE.FIRST15_ORB) return allocatedBalancePerFirst15Signal;
        return allocatedBalancePerNineFifteenSignal;
    };
 
    console.log(
        `[OMS] Processing ${combinedSignals.length} signals... (runNineFifteen=${runNineFifteen}, runMwPattern=${runMwPattern}, TOP_N_PER_SIDE=${TOP_N_PER_SIDE})`
    );
 
    if (allocatedBalancePerNineFifteenSignal != null) {
        console.log(
            `[OMS] Nine-Fifteen: Balance=${balance} split across ${nineFifteenSignals.length} signals -> ₹${allocatedBalancePerNineFifteenSignal.toFixed(2)} per signal`
        );
    }
 
    if (runMwPattern) {
        console.log(`[OMS] MW Pattern: PATTERN_TYPE=${MW_PATTERN_TYPE}`);
    }
 
    if (allocatedBalancePerFirst15Signal != null) {
        console.log(
            `[OMS] FIRST15 ORB: Balance=${first15BalanceForSplit} split across ${first15Signals.length} signals -> ₹${allocatedBalancePerFirst15Signal.toFixed(2)} per signal (then 50/50 across the two target legs) | Broker=${FIRST15_BROKER}`
        );
    }
 
    if (FIRST15_FIXED_QUANTITY != null) {
        console.log(
            `[OMS] FIRST15 ORB: using FIXED_QUANTITY=${FIRST15_FIXED_QUANTITY} for ${first15Signals.length} signal(s) — no balance-based sizing (still split 50/50 across the two target legs) | Broker=${FIRST15_BROKER}`
        );
    }
 
    if (MW_FIXED_QUANTITY != null) {
        console.log(
            `[OMS] MW Pattern: using FIXED_QUANTITY=${MW_FIXED_QUANTITY} for ${mwPatternSignals.length} signal(s) — no balance-based sizing`
        );
    } else if (allocatedBalancePerMwSignal != null) {
        console.log(
            `[OMS] MW Pattern: Balance=${mwBalanceForSplit} split across ${mwPatternSignals.length} signals -> ₹${allocatedBalancePerMwSignal.toFixed(2)} per signal`
        );
    }
 
    console.log(
        '[OMS] Signals:',
        combinedSignals.map(s => ({
            symbol: s.symbol,
            signal: s.signal,
            ratio: s.ratio,
            patternSource: s.patternSource
        }))
    );
 
    let placed = 0;
 
    for (const signal of combinedSignals) {
 
        try {
 
            const isFirst15 = signal.patternSource === PATTERN_SOURCE.FIRST15_ORB;
            const isNineFifteen = signal.patternSource === PATTERN_SOURCE.NINE_FIFTEEN;
 
            // ---- SAFETY GUARD: Nine-Fifteen entry time window ----
            // See ENFORCE_NINE_FIFTEEN_TIME_WINDOW near the top of this
            // file to disable. Only blocks NINE_FIFTEEN signals — never
            // touches MW_PATTERN or FIRST15_ORB.
            if (isNineFifteen && ENFORCE_NINE_FIFTEEN_TIME_WINDOW && !isWithinNineFifteenWindow()) {
                console.log(
                    `[OMS] ⛔ Skipping Nine-Fifteen signal for ${signal.symbol} — outside allowed entry window ` +
                    `(${NINE_FIFTEEN_WINDOW_START.hour}:${String(NINE_FIFTEEN_WINDOW_START.minute).padStart(2, '0')} - ` +
                    `${NINE_FIFTEEN_WINDOW_END.hour}:${String(NINE_FIFTEEN_WINDOW_END.minute).padStart(2, '0')} IST)`
                );
                continue;
            }
            // ---- END SAFETY GUARD ----
 
            // FIRST15_ORB produces 0-2 trades per signal (the two target
            // legs); Nine-Fifteen/MW always produce exactly 0 or 1. Both
            // paths are normalized to an array here so the DB-write code
            // below doesn't need to know the difference.
            let trades;
            if (isFirst15) {
                trades = await processFirst15Signal(signal, allocatedBalanceFor(signal));
            } else if (isNineFifteen && multiAccount) {
                if (!nineFifteenAccountIds.length) {
                    console.error(`[OMS] ⛔ No trading account is logged in — ${signal.symbol} left unprocessed, will retry next cycle.`);
                    continue;
                }
                // All accounts get the order at the same moment (Promise.allSettled inside).
                const result = await placeEntryAcrossAccounts({
                    signal,
                    accountIds: nineFifteenAccountIds,
                    allocatedFor: nineFifteenAllocatedFor,
                    placeFn: processSignal,
                });
                trades = result.trades;
                for (const f of result.failures) {
                    alertOrderNotPlaced(signal.symbol, f.error, { Account: f.accountId, Note: 'other account(s) DID place — not retried to avoid double orders' });
                }
            } else {
                trades = await (async () => {
                    const trade = await processSignal(signal, allocatedBalanceFor(signal));
                    return trade ? [trade] : [];
                })();
            }
 
            if (!trades.length) {
                // Allocated slice couldn't afford even 1 unit — signal
                // left unprocessed so it can be picked up again later
                // if conditions change (e.g. BALANCE is increased).
                continue;
            }
 
            // ── From this point, every trade in `trades` already has a
            // real, confirmed broker order behind it (entryOrderId is set
            // — processSignal()/processFirst15Signal() only ever return a
            // trade after broker.placeEntryOrder()/placeTriggerEntryOrder()
            // succeeded). Saving it below is bookkeeping, not the trade
            // itself — a failure here must NEVER cause this signal to be
            // treated as unprocessed and re-traded next cycle. ───────────
            try {
                await db
                    .collection(TRADE_COLLECTION)
                    .insertMany(trades);
 
                // Mark processed on whichever collection this particular
                // signal actually came from (important when multiple
                // sources run in the same call, since signals can come
                // from any of the three collections).
                await db
                    .collection(signal.sourceCollection)
                    .updateOne(
                        {
                            _id: signal._id
                        },
                        {
                            $set: {
                                processed: true
                            }
                        }
                    );
 
                console.log(
                    `[OMS] Trade(s) created for ${signal.symbol} [${signal.signal}] [${signal.patternSource}] — ${trades.length} leg(s)`,
                    trades.map(t => t.entryOrderId)
                );
 
                placed += trades.length;
 
            } catch (dbErr) {
                // Broker order(s) already succeeded — do NOT let this be
                // retried as a fresh signal. Queue it locally so the next
                // run picks up ONLY the DB save (never another broker
                // order), and alert immediately since this needs eyes on
                // it until it's confirmed saved.
                console.error(
                    `[OMS] Broker order succeeded for ${signal.symbol} but DB save failed — ` +
                    `queuing for background reconciliation:`, dbErr.message
                );
 
                appendPendingTradeSync({
                    signalId: signal._id,
                    sourceCollection: signal.sourceCollection,
                    trades,
                    reason: dbErr.message,
                });
 
                alertEntryDbSyncFailed(
                    signal.symbol,
                    trades.map(t => t.entryOrderId),
                    dbErr,
                    { PatternSource: signal.patternSource, Legs: trades.length }
                );
 
                // Order(s) genuinely were placed — count them as placed.
                placed += trades.length;
            }
 
        } catch (err) {
            // Failed BEFORE any broker order was placed (signal calc
            // error, or the broker itself rejected the order — both
            // processSignal() and processFirst15Signal() only throw /
            // return no trades in cases where nothing was placed). Safe
            // to mark and let it be retried next cycle as before.
            console.error(
                `[OMS] Failed to process signal ${signal.symbol}:`,
                err.message
            );
 
            try {
                await db
                    .collection(signal.sourceCollection)
                    .updateOne(
                        {
                            _id: signal._id
                        },
                        {
                            $set: {
                                processingError: err.message,
                                updatedAt: new Date().toISOString()
                            }
                        }
                    );
            } catch (markErr) {
                // DB is down and no broker order was placed either — safe
                // to just leave the signal unprocessed; it'll be picked up
                // again once the DB (and therefore signal reads) work again.
                console.warn(`[OMS] Could not record processingError for ${signal.symbol}:`, markErr.message);
            }
        }
    }
 
    return { placed, signals: combinedSignals.length };
}
 
// ── CLI entry point — only runs when this file is executed directly
// (`node src/oms/oms-worker.js`), e.g. from your existing 9:15 Task
// Scheduler entry. When mw-live-scan-worker.js imports runOmsCycle()
// instead, none of this runs (see the isMain guard below) — that keeps
// the import side-effect-free and safe to call repeatedly in a loop.
async function main() {
 
    if (!RUN_NINE_FIFTEEN && !RUN_MW_PATTERN && !RUN_FIRST15) {
        console.log('RUN_NINE_FIFTEEN, RUN_MW_PATTERN and RUN_FIRST15 are all false — worker configured to do nothing. Exiting.');
        return;
    }
 
    // Cron fires this every 3 minutes, 24/7 — skip silently outside market
    // hours/trading days so we never touch the broker (and never trigger a
    // pointless Shoonya login) when there's nothing to trade. See the
    // MARKET-HOURS GATE comment above for why this matters.
    if (!isWithinMarketHoursIST()) {
        console.log('[OMS] Outside market hours/trading day — skipping this cycle.');
        return;
    }
 
    // See CROSS-PROCESS RUN LOCK comment above — a previous cron-spawned
    // process may still be running.
    if (!acquireRunLock()) {
        console.log('[OMS] Another worker run is still in progress — skipping this tick.');
        return;
    }
 
     try {
        await runOmsCycle();
    } catch (err) {
        console.error('[OMS] Fatal error:', err);
    } finally {
        releaseRunLock();
        process.exit(0);
    }
}
 
// NOTE: was `import.meta.url === \`file://${process.argv[1]}\`` — that
// naive string-glue NEVER matches on Windows once the path contains
// spaces or parentheses (like this project's "private-trade-bot
// (Shoonaya)" folder): import.meta.url comes back URL-encoded with
// forward slashes and 3 slashes after 'file:', while `file://${argv[1]}`
// is just the raw backslash Windows path glued on with 2 slashes. The
// two could never be equal, so isMain was always false, main() never
// ran, and the worker silently did nothing after the imports — every
// single time, regardless of .env or DB contents. pathToFileURL()
// normalizes argv[1] into the same encoded form Node uses for
// import.meta.url, so the comparison actually works cross-platform.
const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    main();
}
 
export { runOmsCycle };