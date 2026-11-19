/**
 * eod-report-service.js
 *
 * Shared core for the "9:15 EOD report" — pulls today's (or a given
 * date's) 9:15 AM signals from `mw_volume_surge_patterns`, fetches
 * 3-minute intraday candles from Fyers, and works out per-signal
 * performance.
 *
 * This module contains ONLY the data logic (no console.log / process.exit
 * / file writing) so it can be reused by:
 *   - src/workers/nine-fifteen-eod-report-worker.js (CLI)
 *   - routes/eod-report.routes.js (web UI / JSON API)
 *
 * Entry price (trigger level):
 *   BUY  -> high of the 9:15 AM candle + 0.20 (20 paise)
 *   SELL -> low of the 9:15 AM candle - 0.20 (20 paise)
 * A signal only counts as an actual trade if some later candle that day
 * actually reaches this trigger level (high >= trigger for BUY, low <=
 * trigger for SELL) — mirroring a real trigger/stop order. If the
 * trigger is never hit, the signal is reported as failed ("trigger
 * price never hit"), not as a trade with a profit/loss.
 *
 * Exit price (used for the headline profit %):
 *   price at the 3:05 PM candle (LTP at default exit time)
 *
 * On top of the original logic this module now also tracks, for every
 * triggered signal:
 *   - ltp310  -> LTP at the 3:05 PM candle (same as exitPrice, default exit)
 *   - high    -> the best intraday profit % that was actually available
 *                after entry (max favorable excursion), i.e. "how much
 *                profit could have been booked at the best possible
 *                moment that day"
 *   - low     -> the worst intraday drawback % after entry (max
 *                adverse excursion), i.e. how far it went against the
 *                trade before recovering
 *   - target / target% and whether it was hit (and the profit % locked
 *     in if a custom target was supplied)
 *   - stoploss / stoploss% and whether it was hit (and the loss %
 *     locked in if a custom stoploss was supplied)
 *
 * Target/stoploss are user-configurable per report run (not persisted
 * per-symbol) — pass `target` / `stoploss` as a percentage (e.g. 2 for
 * 2%) into `generateEodReport()`.
 */

import * as XLSX from 'xlsx';
import { connectToDatabase } from '../../db/mongodb.js';
import { FyersAuth } from '../brokers/fyers/fyers-auth.js';
import { getFyersSymbol } from '../../utilities/symbol-mapper.js';

export const NINE_FIFTEEN_COLLECTION = 'mw_volume_surge_patterns';

// Candles that the always-on `fyers-candle-fetcher-worker.js` already
// persisted while the market was live. If a symbol/date is already in
// here we use it as-is instead of calling the (slow, rate-limited)
// Fyers history API again — this is what makes re-running a report for
// a past date near-instant instead of re-fetching every symbol.
const FNO_CANDLES_COLLECTION = 'fno_candles';

// Which Mongo collection holds the persisted 3-min candles for each
// broker. Both collections are written in the SAME shape (symbol, date,
// candles:[{time,open,high,low,close,volume}]) — see
// backfill-fno-candles.js (Fyers) and
// shoonya-3min-candle-backfill-worker.js (Shoonya) — so nothing else in
// this file needs to change to read either one.
const BROKER_CANDLE_COLLECTIONS = {
    fyers: FNO_CANDLES_COLLECTION,
    shoonya: "shoonay'sfno_candle",
};
const DEFAULT_BROKER = 'fyers';

// IMPORTANT FOR CONSISTENT NUMBERS: for a PAST date, a broker's candles
// never change once they're recorded — 9:15 AM on a given day happened
// exactly once. So as long as we always read from the persisted
// collection above (never fall back to asking the broker live for a
// date that's already over), running the same report twice — today,
// next week, next year — always re-reads the exact same candles and
// re-runs the exact same arithmetic, so it MUST produce the exact same
// number. Only Fyers currently has a "fetch live from the broker if
// missing from Mongo" fallback (fetchDayCandlesFromFyers below), and
// that's kept ONLY for same-day/very-recent dates where the background
// collector may not have caught up yet. Shoonya has no such fallback —
// if a date/symbol isn't in shoonay'sfno_candle yet, it's reported as
// "no data" rather than silently pulling from somewhere that could
// answer differently next time.

// Fyers history/candle API is per-symbol and rate-limited, so we make
// requests one at a time with a delay between them, rather than firing
// them concurrently (which triggers "request limit reached" errors).
const FYERS_HISTORY_DELAY_MS = 300;
const FYERS_HISTORY_MAX_RETRIES = 3;
const FYERS_HISTORY_RETRY_DELAY_MS = 1000;

const ENTRY_HOUR_IST = 9;
const ENTRY_MINUTE_IST = 15;
const EXIT_HOUR_IST = 15;
const EXIT_MINUTE_IST = 6; // 3:06 PM checkpoint (default/headline exit)
const ENTRY_OFFSET = 0.20; // 20 paise
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export function getTodayDateStr() {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isRateLimitError(err) {
    const msg = (err?.message || '').toLowerCase();
    return msg.includes('request limit') || msg.includes('rate limit') || msg.includes('too many requests');
}

function candleMatchesTime(epochSeconds, targetHour, targetMinute) {
    const istDate = new Date(epochSeconds * 1000 + IST_OFFSET_MS);
    return istDate.getUTCHours() === targetHour && istDate.getUTCMinutes() === targetMinute;
}

/**
 * Parses a user-supplied "HH:MM" (24-hour) string, e.g. "12:00", into
 * { hour, minute }. Returns null if missing/malformed so callers can
 * treat a bad/absent custom exit time as "not requested".
 */
function parseTimeStr(timeStr) {
    if (!timeStr || typeof timeStr !== 'string') return null;
    const m = timeStr.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (Number.isNaN(hour) || Number.isNaN(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return { hour, minute };
}

function formatIstTime(epochSeconds) {
    const istDate = new Date(epochSeconds * 1000 + IST_OFFSET_MS);
    const h = String(istDate.getUTCHours()).padStart(2, '0');
    const m = String(istDate.getUTCMinutes()).padStart(2, '0');
    return `${h}:${m}`;
}

/**
 * Finds the first candle at or after the given IST hour/minute. Used
 * for the user-configurable "exit at this time" checkpoint, where the
 * requested time may not fall exactly on a 3-minute candle boundary
 * (e.g. 12:01) — in that case we treat it as "exit at the next candle
 * close at/after that time".
 */
function findCandleAtOrAfterTime(candles, targetHour, targetMinute) {
    const targetTotalMin = targetHour * 60 + targetMinute;
    return candles.find(c => {
        const istDate = new Date(c[0] * 1000 + IST_OFFSET_MS);
        const totalMin = istDate.getUTCHours() * 60 + istDate.getUTCMinutes();
        return totalMin >= targetTotalMin;
    });
}

const round2 = n => Math.round(n * 100) / 100;

function epochSecondsFromIso(iso) {
    return Math.floor(new Date(iso).getTime() / 1000);
}

/**
 * Pulls the checkpoint candles (9:15 entry, 3:05 exit) plus
 * every candle after entry out of a raw [[ts,o,h,l,c,v], ...] array,
 * regardless of whether that array came from Mongo or straight from
 * Fyers.
 */
function buildCandleResult(candles, symbol, dateStr, exitTimeParsed = null) {
    const entryCandle = candles.find(c => candleMatchesTime(c[0], ENTRY_HOUR_IST, ENTRY_MINUTE_IST));
    // Exit checkpoint uses "first candle at/after" rather than an exact
    // match: with 3-minute candles starting at 9:15 (9:15, 9:18, 9:21...),
    // a time like 15:10 never falls exactly on a candle boundary, so an
    // exact-match lookup would find nothing and every signal would wrongly
    // fail as "no data". This mirrors the custom exit-time logic below.
    const exitCandle = findCandleAtOrAfterTime(candles, EXIT_HOUR_IST, EXIT_MINUTE_IST);

    if (!entryCandle) {
        console.warn(`[EOD Report] No ${ENTRY_HOUR_IST}:${String(ENTRY_MINUTE_IST).padStart(2, '0')} candle found for ${symbol} on ${dateStr}`);
        return null;
    }
    if (!exitCandle) {
        console.warn(`[EOD Report] No ${EXIT_HOUR_IST}:${String(EXIT_MINUTE_IST).padStart(2, '0')} candle found for ${symbol} on ${dateStr}`);
        return null;
    }

    const entryHigh = entryCandle[2];
    const entryLow = entryCandle[3];
    const exitPrice = exitCandle[4];

    if (typeof entryHigh !== 'number' || typeof entryLow !== 'number' || typeof exitPrice !== 'number') {
        console.warn(`[EOD Report] Malformed candle data for ${symbol} on ${dateStr}`);
        return null;
    }

    const entryIndex = candles.indexOf(entryCandle);
    const candlesAfterEntry = candles.slice(entryIndex + 1);

    // The very next 3-minute candle after the 9:15 entry candle (i.e.
    // the 9:18 candle). Whether the trigger price was actually touched
    // is now decided ONLY off this single candle — see the trigger
    // check in generateEodReport() — not off the whole day's candles.
    const triggerCandle = candlesAfterEntry.length > 0 ? candlesAfterEntry[0] : null;

    // Optional "what if I exited at HH:MM" checkpoint. We look across
    // the FULL day's candles (not just candlesAfterEntry) and take the
    // first candle at/after the requested time, so an off-boundary
    // time like 12:01 still resolves to a sensible candle.
    let ltpCustom = null;
    let customTimeLabel = null;
    if (exitTimeParsed) {
        const customCandle = findCandleAtOrAfterTime(candles, exitTimeParsed.hour, exitTimeParsed.minute);
        if (customCandle && typeof customCandle[4] === 'number') {
            ltpCustom = customCandle[4];
            customTimeLabel = formatIstTime(customCandle[0]);
        }
    }

    return {
        entryHigh,
        entryLow,
        ltp310: exitPrice, // 3:05 PM close — the default exit
        ltpCustom, // close price at/after the user-requested custom exit time, or null
        customTimeLabel, // the actual candle time used (e.g. "12:00"), for display
        triggerCandle, // the 9:18 candle — sole basis for the trigger check
        candlesAfterEntry // [[ts,o,h,l,c,v], ...] — used for MFE/MAE + target/stoploss walk
    };
}

/**
 * Looks for the day's candles in `fno_candles` first (already persisted
 * by the live-market candle-fetcher worker). Returns null if that
 * symbol/date isn't in Mongo yet, so the caller knows to fall back to
 * the Fyers API.
 */
// PERFORMANCE: without indexes, every report query is a full collection
// scan — and that scan gets slower every single day as more history gets
// backfilled/collected. These two indexes match the exact fields every
// report query filters on (fno_candles by symbol+date, signals by date),
// turning "scan everything" into "jump straight to the right rows".
// Created lazily on first use and cached in-process so it only actually
// hits Mongo once per server run, not on every report request.
let indexesEnsured = false;
async function ensureIndexes(db) {
    if (indexesEnsured) return;
    try {
        await Promise.all([
            db.collection(FNO_CANDLES_COLLECTION).createIndex({ symbol: 1, date: 1 }, { unique: true, background: true }),
            db.collection(NINE_FIFTEEN_COLLECTION).createIndex({ date: 1 }, { background: true })
        ]);
        indexesEnsured = true;
    } catch (err) {
        // Non-fatal — reports still work without the index, just slower.
        // Most likely cause: a pre-existing duplicate (symbol,date) pair
        // from before backfilling was idempotent; log it so it can be
        // cleaned up, but don't block report generation over it.
        console.warn('[EOD Report] Could not create indexes (reports will still work, just slower):', err.message);
    }
}

/**
 * Converts one raw fno_candles document into the same shape
 * buildCandleResult() expects — shared by both the single-symbol DB
 * lookup and the batched multi-symbol lookup below, so both paths use
 * IDENTICAL filtering/sorting logic (same output, just fetched differently).
 */
function candleResultFromDoc(doc, plainSymbol, dateStr, exitTimeParsed) {
    if (!doc || !Array.isArray(doc.candles) || doc.candles.length === 0) return null;

    const candles = doc.candles
        .filter(c => c && typeof c.open === 'number' && typeof c.high === 'number' && typeof c.low === 'number' && typeof c.close === 'number')
        .map(c => [epochSecondsFromIso(c.time), c.open, c.high, c.low, c.close, c.volume])
        .sort((a, b) => a[0] - b[0]);

    if (candles.length === 0) return null;
    return buildCandleResult(candles, plainSymbol, dateStr, exitTimeParsed);
}

/**
 * Fetches SECOND-resolution intraday candles for a symbol across a
 * date range, straight from Fyers.
 *
 * Why this exists: 3-minute candles can't tell us whether the high or
 * the low happened first within that candle, which is exactly the
 * ambiguity that forces the "assume worst case" logic in the trailing
 * SL check below. Second candles (5S/10S/etc) collapse that window
 * small enough that the ordering ambiguity becomes negligible, so the
 * trailing SL simulation here doesn't need the pessimistic assumption.
 *
 * IMPORTANT — this is NOT a drop-in replacement for
 * fetchDayCandlesFromFyers. Second-resolution history is very likely
 * rate/range limited to a much shorter lookback window per request
 * than 3-min data (Fyers doesn't publish the exact cap for -S
 * resolutions as of this writing — test it against your account/plan).
 * So instead of one range_from/range_to call, this fetches ONE
 * TRADING DAY AT A TIME and stitches the results together. That also
 * naturally handles weekends/holidays: any date with no data just
 * returns an empty array for that day and is skipped.
 *
 * @param {object} fyers - authenticated fyers client
 * @param {string} fyersSymbol - e.g. 'NSE:RELIANCE-EQ'
 * @param {string} fromDateStr - 'YYYY-MM-DD'
 * @param {string} toDateStr - 'YYYY-MM-DD'
 * @param {string} [secResolution] - one of '1S','5S','10S','15S','30S','45S'
 * @returns {Promise<Array<[epochSeconds, open, high, low, close, volume]>>}
 */
async function fetchSecondCandlesFromFyers(
    fyers,
    fyersSymbol,
    fromDateStr,
    toDateStr,
    secResolution = '5S'
) {
    const allCandles = [];

    // Walk day by day so we never exceed whatever the per-request
    // range cap turns out to be for second-resolution data.
    let cursor = new Date(fromDateStr + 'T00:00:00');
    const end = new Date(toDateStr + 'T00:00:00');

    while (cursor <= end) {

        const dayStr = cursor.toISOString().slice(0, 10);

        for (let attempt = 1; attempt <= FYERS_HISTORY_MAX_RETRIES; attempt++) {
            try {
                const response = await fyers.getHistory({
                    symbol: fyersSymbol,
                    resolution: secResolution,
                    date_format: '1',
                    range_from: dayStr,
                    range_to: dayStr,
                    cont_flag: '1'
                });

                if (response?.s === 'ok' && Array.isArray(response.candles)) {
                    allCandles.push(...response.candles);
                } else if (response?.s !== 'no_data') {
                    // 'no_data' is expected for weekends/holidays — only
                    // warn on genuine failures.
                    console.warn(`[EOD Report] Second-candle fetch failed for ${fyersSymbol} on ${dayStr}:`, response?.message || response);
                }
                break; // success (or expected no_data) — move to next day

            } catch (err) {
                if (isRateLimitError(err) && attempt < FYERS_HISTORY_MAX_RETRIES) {
                    const delay = FYERS_HISTORY_RETRY_DELAY_MS * attempt;
                    console.warn(`[EOD Report] Rate limited on ${fyersSymbol} (${dayStr}), retrying in ${delay}ms (attempt ${attempt}/${FYERS_HISTORY_MAX_RETRIES})`);
                    await sleep(delay);
                    continue;
                }
                console.error(`[EOD Report] getHistory() threw for ${fyersSymbol} on ${dayStr}:`, err.message);
                break;
            }
        }

        // Be gentle — second-resolution + one-request-per-day means a
        // week/month backtest can easily be 5-20+ requests per symbol.
        await sleep(300);

        cursor.setDate(cursor.getDate() + 1);
    }

    return allCandles; // [[timestamp, open, high, low, close, volume], ...]
}

/**
 * Fetches 3-minute intraday candles for a symbol on `dateStr` straight
 * from Fyers (slow, rate-limited — only used when the DB cache misses).
 */
async function fetchDayCandlesFromFyers(fyers, fyersSymbol, dateStr, exitTimeParsed = null) {
    for (let attempt = 1; attempt <= FYERS_HISTORY_MAX_RETRIES; attempt++) {
        try {
            const response = await fyers.getHistory({
                symbol: fyersSymbol,
                resolution: '3', // 3-minute candles (matches chart timeframe)
                date_format: '1',
                range_from: dateStr,
                range_to: dateStr,
                cont_flag: '1'
            });

            if (response?.s !== 'ok' || !Array.isArray(response.candles) || response.candles.length === 0) {
                console.warn(`[EOD Report] History fetch failed for ${fyersSymbol}:`, response?.message || response);
                return null;
            }

            // Candle format: [timestamp, open, high, low, close, volume]
            return buildCandleResult(response.candles, fyersSymbol, dateStr, exitTimeParsed);
        } catch (err) {
            if (isRateLimitError(err) && attempt < FYERS_HISTORY_MAX_RETRIES) {
                const delay = FYERS_HISTORY_RETRY_DELAY_MS * attempt;
                console.warn(`[EOD Report] Rate limited on ${fyersSymbol}, retrying in ${delay}ms (attempt ${attempt}/${FYERS_HISTORY_MAX_RETRIES})`);
                await sleep(delay);
                continue;
            }
            console.error(`[EOD Report] getHistory() threw for ${fyersSymbol}:`, err.message);
            return null;
        }
    }
    return null;
}

/**
 * @param {object} db - Mongo db handle, used for the candle cache lookup.
 * @param {object} fyers - authenticated Fyers client, used only on cache misses (Fyers broker only).
 * @param {{plainSymbol:string, fyersSymbol:string}[]} symbolPairs
 * @param {string} dateStr
 * @param {object|null} exitTimeParsed
 * @param {string} broker - 'fyers' | 'shoonya' — picks which persisted collection to read.
 */
async function fetchCandleMap(db, fyers, symbolPairs, dateStr, exitTimeParsed = null, broker = DEFAULT_BROKER) {
    const candleMap = new Map(); // keyed by fyersSymbol (used as a stable per-symbol key regardless of broker)
    const failReasons = new Map(); // fyersSymbol -> human-readable reason it has no candles (surfaced in the report instead of one generic string)
    const collectionName = BROKER_CANDLE_COLLECTIONS[broker] || FNO_CANDLES_COLLECTION;
    let dbHits = 0;
    let liveFetches = 0;

    // PERFORMANCE: fetch every symbol's candles for this day in ONE
    // Mongo round-trip (an $in query) instead of one findOne() per
    // symbol. Same documents, same filtering/sorting logic as before
    // (via candleResultFromDoc) — this only changes HOW MANY network
    // round-trips it takes to get them, not what data comes back.
    let docsBySymbol = new Map();
    if (db) {
        const plainSymbols = symbolPairs.map(p => p.plainSymbol);
        const docs = await db.collection(collectionName)
            .find({ symbol: { $in: plainSymbols }, date: dateStr })
            .toArray();
        docsBySymbol = new Map(docs.map(d => [d.symbol, d]));
    }

    const missingFromDb = [];
    for (const pair of symbolPairs) {
        const doc = docsBySymbol.get(pair.plainSymbol);
        const result = candleResultFromDoc(doc, pair.plainSymbol, dateStr, exitTimeParsed);
        if (result) {
            candleMap.set(pair.fyersSymbol, result);
            dbHits++;
        } else {
            missingFromDb.push(pair);
        }
    }

    // Live-broker fallback only exists for Fyers, and is only meant to
    // cover a same-day/very-recent gap before the background collector
    // has caught up. Deliberately NOT done for Shoonya (no live-fetch
    // wired up here) so that a Shoonya-sourced report only ever reads
    // from the persisted collection — same input every time, same
    // output every time.
    if (broker === 'fyers') {
        // If the Fyers client itself never authenticated (expired/missing
        // token), every single live fetch below will fail the same way —
        // check once up front so the report can say THAT plainly instead
        // of "no candle data available" on every one of N symbols, which
        // looks like a filter/topN bug rather than what it actually is.
        if (!fyers) {
            console.warn('[EOD Report] Fyers client is not authenticated — all live-fetch fallbacks will fail this run.');
            for (const { fyersSymbol } of missingFromDb) {
                failReasons.set(fyersSymbol, 'Fyers session is not authenticated (re-login required) — DB cache also had no candles for this date');
            }
        } else {
            for (const { fyersSymbol } of missingFromDb) {
                const fetched = await fetchDayCandlesFromFyers(fyers, fyersSymbol, dateStr, exitTimeParsed);
                if (fetched) {
                    candleMap.set(fyersSymbol, fetched);
                } else {
                    failReasons.set(fyersSymbol, 'no candle data available (checked DB cache and Fyers live history)');
                }
                liveFetches++;
                await sleep(FYERS_HISTORY_DELAY_MS);
            }
        }
    } else {
        for (const { fyersSymbol } of missingFromDb) {
            failReasons.set(fyersSymbol, `no candle data available in DB for broker "${broker}" on this date (no live fallback for this broker — only the persisted collection is read)`);
        }
    }

    console.log(`[EOD Report] Candle source (${broker}) — DB cache: ${dbHits}, live API: ${liveFetches}, missing: ${missingFromDb.length - liveFetches}`);
    return { candleMap, failReasons };
}

function calcProfitPercent(signal, entryPrice, ltp) {
    if (signal === 'BUY') {
        return ((ltp - entryPrice) / entryPrice) * 100;
    }
    // SELL
    return ((entryPrice - ltp) / entryPrice) * 100;
}

/**
 * Given every signal for the day (`allSignalDocs` — the full 9:15 list,
 * before we know which ones will actually trigger) and the subset that
 * DID trigger into real trades (`triggeredTrades`, each needs symbol,
 * signal, entryPrice, profitPercent), splits `balance` EQUALLY across
 * every signal — triggered or not. This matches reality: at 9:15 AM you
 * don't know yet which signals will hit their trigger price, so the
 * whole day's capital has to be reserved (52 signals -> 52 slices) even
 * though only some of those slices end up actually buying anything.
 *
 * A slice whose signal never triggers sits as unused cash for the day.
 * A slice whose signal triggers buys as many whole shares as its slice
 * allows, and the rest of that slice becomes unused too.
 */
function computeAllocation(allSignalDocs, triggeredTrades, balance) {
    const startBalance = Number(balance);
    const totalCount = Array.isArray(allSignalDocs) ? allSignalDocs.length : 0;
    if (!startBalance || startBalance <= 0 || totalCount === 0) {
        return null;
    }

    const perSignalAllocation = startBalance / totalCount;
    const triggeredMap = new Map(triggeredTrades.map(t => [`${t.symbol}|${t.signal}`, t]));

    let totalUsed = 0;
    let totalPnl = 0;

    const detail = allSignalDocs.map(doc => {
        const t = triggeredMap.get(`${doc.symbol}|${doc.signal}`);

        if (!t) {
            // Signal was considered (capital reserved for it) but never
            // actually triggered into a trade — its whole slice sits idle.
            return {
                symbol: doc.symbol,
                signal: doc.signal,
                triggered: false,
                entryPrice: null,
                profitPercent: null,
                allocated: round2(perSignalAllocation),
                qty: 0,
                used: 0,
                unused: round2(perSignalAllocation),
                pnl: 0
            };
        }

        const qty = t.entryPrice > 0 ? Math.floor(perSignalAllocation / t.entryPrice) : 0;
        const used = round2(qty * t.entryPrice);
        const unused = round2(perSignalAllocation - used);
        const pnl = round2((used * t.profitPercent) / 100);
        totalUsed += used;
        totalPnl += pnl;
        return {
            symbol: doc.symbol,
            signal: doc.signal,
            triggered: true,
            entryPrice: t.entryPrice,
            profitPercent: round2(t.profitPercent),
            allocated: round2(perSignalAllocation),
            qty,
            used,
            unused,
            pnl
        };
    });

    totalUsed = round2(totalUsed);
    totalPnl = round2(totalPnl);
    const totalUnused = round2(startBalance - totalUsed);
    const endingBalance = round2(startBalance + totalPnl);

    return {
        startBalance: round2(startBalance),
        perSignalAllocation: round2(perSignalAllocation),
        signalCount: totalCount,
        triggeredCount: triggeredTrades.length,
        skippedNoQty: detail.filter(d => d.triggered && d.qty === 0).length,
        totalUsed,
        totalUnused,
        totalPnl,
        endingBalance,
        returnPercent: round2((totalPnl / startBalance) * 100),
        isProfit: totalPnl >= 0,
        detail
    };
}

/**
 * Wraps computeAllocation() with the exact "use the custom exit price
 * when one applies" logic that generateEodReport() needs — pulled out
 * into its own pure function (no I/O, just data in -> data out) so
 * generateEodReportRange() can reuse the IDENTICAL logic to recompute
 * allocation for a DIFFERENT balance without re-running the expensive
 * DB/candle-fetching part of the report. Same inputs always produce the
 * same output, so accuracy is unaffected by when/how many times this runs.
 *
 * @param {{successful:object[], failed:object[], allSignals:{symbol:string,signal:string}[], exitTime:string|null, noSignals:boolean}} report
 * @param {number|null} balance
 */
function computeAllocationForReport(report, balance) {
    if (balance === null || balance === undefined || !(Number(balance) > 0)) return null;
    if (!report || report.noSignals) return null;

    const failedWithData = (report.failed || []).filter(f => typeof f.profitPercent === 'number');
    const allTriggered = (report.successful || []).concat(failedWithData);

    let customExitAppliedCount = 0;
    const allocationTrades = allTriggered.map(t => {
        if (report.exitTime && typeof t.customPercent === 'number') {
            customExitAppliedCount++;
            return { ...t, profitPercent: t.customPercent };
        }
        return t;
    });

    const allocation = computeAllocation(report.allSignals, allocationTrades, balance);
    if (allocation && report.exitTime) {
        allocation.exitTimeApplied = report.exitTime;
        allocation.customExitAppliedCount = customExitAppliedCount;
    }
    return allocation;
}

/**
 * Runs async fn(item) over `items` with at most `limit` running at once —
 * a plain-JS worker pool, no extra dependency. Used to fetch multiple
 * days' reports concurrently instead of one-after-another, while still
 * capping how many hit Mongo/Fyers at the same instant.
 */
async function mapWithConcurrency(items, limit, fn) {
    const results = new Array(items.length);
    let nextIndex = 0;

    async function worker() {
        while (true) {
            const i = nextIndex++;
            if (i >= items.length) return;
            results[i] = await fn(items[i], i);
        }
    }

    const workerCount = Math.min(limit, items.length);
    await Promise.all(Array.from({ length: workerCount }, worker));
    return results;
}

function toDateStr(d) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/** Monday..Friday of the calendar week that contains `dateStr`. */
export function getWeekRange(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const dow = d.getDay(); // 0 = Sun ... 6 = Sat
    const diffToMonday = dow === 0 ? -6 : 1 - dow;
    const monday = new Date(d);
    monday.setDate(d.getDate() + diffToMonday);
    const friday = new Date(monday);
    friday.setDate(monday.getDate() + 4);
    return { start: toDateStr(monday), end: toDateStr(friday) };
}

/** 1st..last calendar day of the month that contains `dateStr`. */
export function getMonthRange(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const first = new Date(d.getFullYear(), d.getMonth(), 1);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    return { start: toDateStr(first), end: toDateStr(last) };
}

/** Every Mon-Fri date string between start and end (inclusive). */
function enumerateWeekdays(startDateStr, endDateStr) {
    const out = [];
    const cur = new Date(startDateStr + 'T00:00:00');
    const end = new Date(endDateStr + 'T00:00:00');
    while (cur <= end) {
        const dow = cur.getDay();
        if (dow !== 0 && dow !== 6) out.push(toDateStr(cur));
        cur.setDate(cur.getDate() + 1);
    }
    return out;
}

/**
 * Runs the full 9:15 EOD analysis for `dateStr` and returns a plain
 * data object — no console output, no file writing.
 *
 * @param {object} opts
 * @param {string} [opts.dateStr] - YYYY-MM-DD, defaults to today
 * @param {number|null} [opts.target] - custom target %, e.g. 2 for 2%
 * @param {number|null} [opts.stoploss] - custom stoploss %, e.g. 1 for 1%
 * @param {number|null} [opts.rangeMin] - only include stocks whose entry price is >= this
 * @param {number|null} [opts.rangeMax] - only include stocks whose entry price is <= this
 * @param {string|null} [opts.signalType] - only include 'BUY' or 'SELL' signals (case-insensitive); null/'' = both
 * @param {number|null} [opts.ratioMin] - only include signals whose volume-surge ratio is >= this
 * @param {number|null} [opts.ratioMax] - only include signals whose volume-surge ratio is <= this
 * @param {string|null} [opts.exitTime] - optional "HH:MM" (24h, IST) checkpoint. When
 *        supplied, every triggered signal also reports what its P/L would have been if
 *        the trade were closed at (the candle at/after) this time, alongside the normal
 *        3:05 PM close/target/stoploss exit.
 * @param {(msg:string)=>void} [opts.onLog] - optional progress callback
 *        (used by the web route to stream progress; defaults to console.log)
 */
// PERFORMANCE: the expensive part of a day's report (fetching candles,
// working out which signals triggered and their entry/exit/profit%) only
// depends on {date, target, stoploss, rangeMin, rangeMax, signalType,
// ratioMin, ratioMax, exitTime} — NOT on balance. So once a given
// day+filter combo has been computed, it's cached here (in-process
// memory) and reused instantly for every later request with those same
// filters, no matter what balance is asked for — the balance-dependent
// allocation math is always recomputed fresh on top (see
// computeAllocationForReport), so accuracy is unaffected either way.
// This is what makes re-running the same month (e.g. just tweaking the
// balance or re-opening a day you already looked at) come back near
// instantly instead of re-fetching candles all over again.
const DAY_REPORT_CACHE = new Map();
const DAY_REPORT_CACHE_MAX_ENTRIES = 6000; // ~ a year of daily reports across a few filter combos

function dayReportCacheKey(p) {
    return [p.dateStr, p.target, p.stoploss, p.rangeMin, p.rangeMax, p.signalType, p.ratioMin, p.ratioMax, p.exitTime, p.trailingSL, p.trailingPercent, p.broker, p.topN]
        .map(v => (v === null || v === undefined ? '_' : v))
        .join('|');
}
function getDayReportCache(key) {
    return DAY_REPORT_CACHE.get(key) || null;
}
function setDayReportCache(key, value) {
    if (DAY_REPORT_CACHE.size >= DAY_REPORT_CACHE_MAX_ENTRIES) {
        DAY_REPORT_CACHE.delete(DAY_REPORT_CACHE.keys().next().value); // evict oldest
    }
    DAY_REPORT_CACHE.set(key, value);
}

export async function generateEodReport({ dateStr, target = null, stoploss = null, rangeMin = null, rangeMax = null, signalType = null, ratioMin = null, ratioMax = null, exitTime = null, balance = null, trailingSL = false, trailingPercent = null, broker = null, topN = null, onLog = null } = {}) {
    const log = onLog || (() => { });
    const resolvedDate = dateStr || getTodayDateStr();

    // Which broker's persisted 3-min candles to use. Unknown values fall
    // back to Fyers (the original/default source) rather than silently
    // reading nothing.
    const brokerVal = (broker && BROKER_CANDLE_COLLECTIONS[String(broker).toLowerCase()])
        ? String(broker).toLowerCase()
        : DEFAULT_BROKER;

    // Top N — keep only the N best-performing triggered signals (by
    // profit %) after every other filter has already been applied. A
    // plain sort-then-slice on already-computed numbers, so for the
    // same date + filters it always keeps the same N trades in the
    // same order.
    const topNVal = topN !== null && topN !== undefined && topN !== '' && Number(topN) > 0
        ? Math.floor(Number(topN))
        : null;
    const balanceVal = balance !== null && balance !== undefined && balance !== '' && Number(balance) > 0 ? Number(balance) : null;
    const targetPct = target !== null && target !== undefined && target !== '' ? Number(target) : null;
    const stoplossPct = stoploss !== null && stoploss !== undefined && stoploss !== '' ? Number(stoploss) : null;
    const rangeMinVal = rangeMin !== null && rangeMin !== undefined && rangeMin !== '' ? Number(rangeMin) : null;
    const rangeMaxVal = rangeMax !== null && rangeMax !== undefined && rangeMax !== '' ? Number(rangeMax) : null;
    const ratioMinVal = ratioMin !== null && ratioMin !== undefined && ratioMin !== '' ? Number(ratioMin) : null;
    const ratioMaxVal = ratioMax !== null && ratioMax !== undefined && ratioMax !== '' ? Number(ratioMax) : null;
    const signalTypeVal = signalType !== null && signalType !== undefined && signalType !== '' && signalType.toUpperCase() !== 'ALL'
        ? signalType.toUpperCase()
        : null;
    const exitTimeParsed = parseTimeStr(exitTime);
    const exitTimeVal = exitTimeParsed ? exitTime.trim() : null;

    // Trailing stop loss — when enabled (the "Trailing Stop Loss" checkbox),
    // this REPLACES the fixed stoploss % for exit purposes: the stop
    // ratchets in the trade's favor as price moves, instead of sitting at
    // one fixed price. A custom target %, if also supplied, still applies
    // on top of it. Falls back to trailingPct=1 if the box is checked but
    // no custom % was typed in, so the toggle always does *something*.
    const trailingEnabled = trailingSL === true || trailingSL === 'true' || trailingSL === '1' || trailingSL === 1;
    const trailingPct = trailingEnabled
        ? (trailingPercent !== null && trailingPercent !== undefined && trailingPercent !== '' && !Number.isNaN(Number(trailingPercent))
            ? Math.abs(Number(trailingPercent))
            : 1)
        : null;

    const cacheKey = dayReportCacheKey({
        dateStr: resolvedDate, target: targetPct, stoploss: stoplossPct, rangeMin: rangeMinVal, rangeMax: rangeMaxVal,
        signalType: signalTypeVal, ratioMin: ratioMinVal, ratioMax: ratioMaxVal, exitTime: exitTimeVal,
        trailingSL: trailingEnabled, trailingPercent: trailingPct, broker: brokerVal, topN: topNVal
    });
    const cachedBase = getDayReportCache(cacheKey);
    if (cachedBase) {
        const allocation = computeAllocationForReport(cachedBase, balanceVal);
        return { ...cachedBase, balance: balanceVal, allocation };
    }

    log(`Running for date: ${resolvedDate}`);

    const db = await connectToDatabase();
    await ensureIndexes(db);

    let signals = await db.collection(NINE_FIFTEEN_COLLECTION)
        .find({ date: resolvedDate })
        .toArray();

    // Signal-type (BUY/SELL) filter — applied straight away since it
    // needs no candle data.
    if (signalTypeVal !== null) {
        signals = signals.filter(doc => doc.signal === signalTypeVal);
    }

    // Ratio filter — the volume-surge ratio is captured on the signal
    // document itself (same field the 9:15 AM Volume Surge Screener
    // shows), so this can be applied straight away too.
    if (ratioMinVal !== null || ratioMaxVal !== null) {
        signals = signals.filter(doc => {
            if (typeof doc.ratio !== 'number') return false;
            if (ratioMinVal !== null && doc.ratio < ratioMinVal) return false;
            if (ratioMaxVal !== null && doc.ratio > ratioMaxVal) return false;
            return true;
        });
    }

    // Cheap pre-filter using the price already captured on the signal
    // itself (if present), so we don't even bother fetching candles for
    // symbols that are obviously outside the requested price range.
    // The authoritative filter (on the actual computed entry price)
    // still runs further down, after candles are fetched.
    if (rangeMinVal !== null || rangeMaxVal !== null) {
        signals = signals.filter(doc => {
            if (typeof doc.close !== 'number') return true; // no snapshot price — let it through, filter later
            if (rangeMinVal !== null && doc.close < rangeMinVal) return false;
            if (rangeMaxVal !== null && doc.close > rangeMaxVal) return false;
            return true;
        });
    }

    // Top N stocks — pick the N symbols to actually trade BEFORE running
    // the backtest, the same way a real trader would at 9:15 AM (ranked
    // by volume-surge ratio, since that's the only signal-strength info
    // available at entry time). Applying this here — not after the
    // backtest, by profit% — avoids look-ahead bias (you can't rank by a
    // result you don't have yet) and guarantees at most N stocks ever
    // reach the backtest, so the report can't show more than N rows.
    if (topNVal !== null && signals.length > topNVal) {
        signals = signals
            .slice()
            .sort((a, b) => (typeof b.ratio === 'number' ? b.ratio : -Infinity) - (typeof a.ratio === 'number' ? a.ratio : -Infinity))
            .slice(0, topNVal);
    }

    if (signals.length === 0) {
        const baseReport = {
            dateStr: resolvedDate,
            target: targetPct,
            stoploss: stoplossPct,
            rangeMin: rangeMinVal,
            rangeMax: rangeMaxVal,
            signalType: signalTypeVal,
            ratioMin: ratioMinVal,
            ratioMax: ratioMaxVal,
            exitTime: exitTimeVal,
            trailingSL: trailingEnabled,
            trailingPercent: trailingPct,
            broker: brokerVal,
            topN: topNVal,
            noSignals: true,
            successful: [], failed: [],
            successfulBuy: [], successfulSell: [],
            failedBuy: [], failedSell: [], failedNoData: [],
            summary: null,
            allSignals: []
        };
        setDayReportCache(cacheKey, baseReport);
        return { ...baseReport, balance: balanceVal, allocation: null };
    }

    const fyersAuth = new FyersAuth();
    const fyers = fyersAuth.getAuthenticatedClient();

    const fyersSymbolForDoc = new Map(); // doc.symbol -> fyers symbol string
    const symbolPairs = [];

    for (const doc of signals) {
        const fSym = getFyersSymbol({ symbol: doc.symbol });
        fyersSymbolForDoc.set(doc.symbol, fSym);
        symbolPairs.push({ plainSymbol: doc.symbol, fyersSymbol: fSym });
    }

    log(`Fetching candle data for ${symbolPairs.length} symbol(s) from ${brokerVal}...`);
    const { candleMap, failReasons } = await fetchCandleMap(db, fyers, symbolPairs, resolvedDate, exitTimeParsed, brokerVal);

    const successful = [];
    const failed = [];

    for (const doc of signals) {
        const fSym = fyersSymbolForDoc.get(doc.symbol);
        const data = candleMap.get(fSym);

        if (!data) {
            failed.push({
                symbol: doc.symbol,
                signal: doc.signal,
                ratio: typeof doc.ratio === 'number' ? round2(doc.ratio) : null,
                reason: failReasons.get(fSym) || 'no candle data available (checked DB cache and Fyers)'
            });
            continue;
        }

        const { entryHigh, entryLow, ltp310, ltpCustom, customTimeLabel, triggerCandle, candlesAfterEntry } = data;

        const buyEntryPrice = round2(entryHigh + ENTRY_OFFSET);
        const sellEntryPrice = round2(entryLow - ENTRY_OFFSET);
        const entryPrice = doc.signal === 'BUY' ? buyEntryPrice : sellEntryPrice;

        // Authoritative range filter, now that we have the real entry
        // price (the earlier filter on doc.close was only a cheap
        // pre-pass to skip fetching candles for obvious outliers).
        if (rangeMinVal !== null && entryPrice < rangeMinVal) continue;
        if (rangeMaxVal !== null && entryPrice > rangeMaxVal) continue;

        // Trigger check is now decided ONLY off the very next 3-minute
        // candle after the 9:15 entry candle (i.e. the 9:18 candle) —
        // not off the whole day's candles. If that single candle didn't
        // reach the trigger level, the stock is rejected outright, even
        // if a later candle that day would have hit it.
        const buyTriggered = triggerCandle ? triggerCandle[2] >= buyEntryPrice : false;
        const sellTriggered = triggerCandle ? triggerCandle[3] <= sellEntryPrice : false;
        const triggered = doc.signal === 'BUY' ? buyTriggered : sellTriggered;

        if (!triggered) {
            failed.push({
                symbol: doc.symbol,
                signal: doc.signal,
                ratio: typeof doc.ratio === 'number' ? round2(doc.ratio) : null,
                entryPrice,
                reason: triggerCandle ? '9:18 candle did not hit trigger price' : 'no 9:18 candle available'
            });
            continue;
        }

        // Max favorable / adverse excursion across the whole day after
        // entry — "high" is the best profit % that was ever on the table,
        // "low" is the worst drawdown — purely informational, independent
        // of whether a target/stoploss was configured.
        const candlesFromEntry = candlesAfterEntry.filter(c => typeof c[2] === 'number' && typeof c[3] === 'number');
        let highProfitPercent = calcProfitPercent(doc.signal, entryPrice, ltp310);
        let lowProfitPercent = highProfitPercent;
        if (candlesFromEntry.length > 0) {
            if (doc.signal === 'BUY') {
                const highestHigh = Math.max(...candlesFromEntry.map(c => c[2]));
                const lowestLow = Math.min(...candlesFromEntry.map(c => c[3]));
                highProfitPercent = calcProfitPercent('BUY', entryPrice, highestHigh);
                lowProfitPercent = calcProfitPercent('BUY', entryPrice, lowestLow);
            } else {
                const lowestLow = Math.min(...candlesFromEntry.map(c => c[3]));
                const highestHigh = Math.max(...candlesFromEntry.map(c => c[2]));
                highProfitPercent = calcProfitPercent('SELL', entryPrice, lowestLow);
                lowProfitPercent = calcProfitPercent('SELL', entryPrice, highestHigh);
            }
        }

        // Walk the candles in chronological order and stop at whichever of
        // target / stoploss is hit FIRST — only one of the two can actually
        // happen to a real trade, since hitting either one closes it out.
        // If neither is configured (or neither is ever hit), the trade is
        // treated as held to the 3:05 PM close, the default exit.
        let exitReason = 'eod';
        let exitPrice = ltp310;

        const hasTarget = targetPct !== null && !Number.isNaN(targetPct);
        const hasStoploss = stoplossPct !== null && !Number.isNaN(stoplossPct);

        if (trailingEnabled) {
            // TRAILING STOPLOSS WALK — replaces the fixed stoploss price
            // with one that ratchets in the trade's favor as the price
            // moves: for a BUY it only ever moves UP (trailing behind the
            // highest high seen since entry), for a SELL it only ever
            // moves DOWN (trailing behind the lowest low). It never loosens.
            // A fixed target (if configured) still applies on top of it.
            const targetPrice = hasTarget
                ? (doc.signal === 'BUY' ? entryPrice * (1 + targetPct / 100) : entryPrice * (1 - targetPct / 100))
                : null;

            let extremeSinceEntry = entryPrice; // highest high (BUY) / lowest low (SELL) so far
            let trailStopPrice = doc.signal === 'BUY'
                ? entryPrice * (1 - trailingPct / 100)
                : entryPrice * (1 + trailingPct / 100);

            for (const c of candlesFromEntry) {
                const high = c[2];
                const low = c[3];

                // Check against the stop level as it stood BEFORE this
                // candle — same "stoploss wins a same-candle tie" caution
                // as the fixed-stoploss walk below.
                const trailHitHere = doc.signal === 'BUY' ? low <= trailStopPrice : high >= trailStopPrice;
                const targetHitHere = targetPrice !== null && (doc.signal === 'BUY' ? high >= targetPrice : low <= targetPrice);

                if (trailHitHere) {
                    exitReason = 'trailing_stoploss';
                    exitPrice = round2(trailStopPrice);
                    break;
                }
                if (targetHitHere) {
                    exitReason = 'target';
                    exitPrice = round2(targetPrice);
                    break;
                }

                // Ratchet the trail using this candle's favorable extreme,
                // ready for the next candle.
                if (doc.signal === 'BUY') {
                    if (high > extremeSinceEntry) {
                        extremeSinceEntry = high;
                        trailStopPrice = Math.max(trailStopPrice, extremeSinceEntry * (1 - trailingPct / 100));
                    }
                } else {
                    if (low < extremeSinceEntry) {
                        extremeSinceEntry = low;
                        trailStopPrice = Math.min(trailStopPrice, extremeSinceEntry * (1 + trailingPct / 100));
                    }
                }
            }
        } else if (hasTarget || hasStoploss) {
            const targetPrice = hasTarget
                ? (doc.signal === 'BUY' ? entryPrice * (1 + targetPct / 100) : entryPrice * (1 - targetPct / 100))
                : null;
            const slPrice = hasStoploss
                ? (doc.signal === 'BUY' ? entryPrice * (1 - Math.abs(stoplossPct) / 100) : entryPrice * (1 + Math.abs(stoplossPct) / 100))
                : null;

            for (const c of candlesFromEntry) {
                const high = c[2];
                const low = c[3];

                const targetHitHere = targetPrice !== null && (doc.signal === 'BUY' ? high >= targetPrice : low <= targetPrice);
                // A 3-minute candle only tells us the high/low that occurred
                // somewhere inside it, not the order they occurred in. If
                // both the target and the stoploss fall inside the SAME
                // candle we can't know which was touched first, so we make
                // the conservative assumption that the stoploss hit first
                // (the same assumption most backtesting engines use, since
                // assuming the best case would overstate performance).
                const slHitHere = slPrice !== null && (doc.signal === 'BUY' ? low <= slPrice : high >= slPrice);

                if (slHitHere) {
                    exitReason = 'stoploss';
                    exitPrice = round2(slPrice);
                    break;
                }
                if (targetHitHere) {
                    exitReason = 'target';
                    exitPrice = round2(targetPrice);
                    break;
                }
            }
        }

        const profitPercent = calcProfitPercent(doc.signal, entryPrice, exitPrice);
        const ltp310Percent = typeof ltp310 === 'number' ? calcProfitPercent(doc.signal, entryPrice, ltp310) : null;

        // "What if I exited everything at HH:MM" checkpoint — always the
        // literal price at (the candle at/after) the requested time,
        // independent of target/stoploss/EOD exit logic above.
        const customPercent = typeof ltpCustom === 'number' ? calcProfitPercent(doc.signal, entryPrice, ltpCustom) : null;

        const record = {
            symbol: doc.symbol,
            signal: doc.signal,
            ratio: typeof doc.ratio === 'number' ? round2(doc.ratio) : null,
            entryPrice,
            ltp310,
            ltp310Percent,
            ltp: ltp310, // kept for backward compatibility with existing consumers
            ltpCustom,
            customTimeLabel, // actual candle time used, e.g. "12:00"
            customPercent: typeof customPercent === 'number' ? round2(customPercent) : null,
            exitReason, // 'target' | 'stoploss' | 'trailing_stoploss' | 'eod'
            exitPrice,
            profitPercent, // profit % at the ACTUAL exit (target/stoploss/EOD), not always 3:05 PM anymore
            high: round2(highProfitPercent), // best profit that was ever available (informational)
            low: round2(lowProfitPercent), // worst drawdown that ever occurred (informational)
            targetPercent: targetPct,
            targetHit: exitReason === 'target',
            stoplossPercent: stoplossPct,
            stoplossHit: exitReason === 'stoploss',
            trailingSL: trailingEnabled,
            trailingPercent: trailingPct,
            trailingStoplossHit: exitReason === 'trailing_stoploss'
        };

        // Signals that didn't actually produce a profit are treated as
        // failed, not successful, even though we have valid price data.
        if (profitPercent < 0) {
            failed.push({ ...record, reason: 'negative profit' });
            continue;
        }

        successful.push(record);
    }

    successful.sort((a, b) => b.profitPercent - a.profitPercent);

    // NOTE: Top N is now applied earlier, to `signals` (ranked by ratio)
    // before the backtest even runs — see above. That guarantees at most
    // N stocks total (winners + losers), instead of only capping winners
    // by a profit% we couldn't have known in advance.

    const successfulBuy = successful.filter(s => s.signal === 'BUY').sort((a, b) => b.profitPercent - a.profitPercent);
    const successfulSell = successful.filter(s => s.signal === 'SELL').sort((a, b) => b.profitPercent - a.profitPercent);

    const failedWithData = failed.filter(f => typeof f.profitPercent === 'number');
    const failedNoData = failed.filter(f => typeof f.profitPercent !== 'number');

    const failedBuy = failedWithData.filter(f => f.signal === 'BUY').sort((a, b) => b.profitPercent - a.profitPercent);
    const failedSell = failedWithData.filter(f => f.signal === 'SELL').sort((a, b) => b.profitPercent - a.profitPercent);

    const allTriggered = successful.concat(failedWithData);
    const winners = allTriggered.filter(t => t.profitPercent >= 0);
    const losers = allTriggered.filter(t => t.profitPercent < 0);

    const totalProfitPercent = allTriggered.reduce((sum, t) => sum + t.profitPercent, 0);
    const totalCapitalRequired = allTriggered.reduce((sum, t) => sum + t.entryPrice, 0);

    const moneyEarned = winners.reduce((sum, t) => sum + (t.entryPrice * t.profitPercent) / 100, 0);
    const moneyLost = losers.reduce((sum, t) => sum + (t.entryPrice * Math.abs(t.profitPercent)) / 100, 0);
    const netMoney = moneyEarned - moneyLost;
    const netReturnPercent = totalCapitalRequired > 0 ? (netMoney / totalCapitalRequired) * 100 : 0;

    const targetHitCount = allTriggered.filter(t => t.targetHit).length;
    const stoplossHitCount = allTriggered.filter(t => t.stoplossHit).length;
    const trailingStoplossHitCount = allTriggered.filter(t => t.trailingStoplossHit).length;

    // Custom exit-time ("what if we exited everything at HH:MM") totals —
    // only meaningful entries (those where a candle at/after that time
    // existed) contribute; missing ones are simply excluded, same as
    // the rest of the report handles missing data elsewhere.
    const withCustom = allTriggered.filter(t => typeof t.customPercent === 'number');
    const totalProfitPercentCustom = withCustom.length > 0
        ? withCustom.reduce((sum, t) => sum + t.customPercent, 0)
        : null;
    const winnersCustom = withCustom.filter(t => t.customPercent >= 0);
    const losersCustom = withCustom.filter(t => t.customPercent < 0);
    const moneyEarnedCustom = winnersCustom.reduce((sum, t) => sum + (t.entryPrice * t.customPercent) / 100, 0);
    const moneyLostCustom = losersCustom.reduce((sum, t) => sum + (t.entryPrice * Math.abs(t.customPercent)) / 100, 0);
    const netMoneyCustom = withCustom.length > 0 ? moneyEarnedCustom - moneyLostCustom : null;
    const capitalRequiredCustom = withCustom.reduce((sum, t) => sum + t.entryPrice, 0);
    const netReturnPercentCustom = withCustom.length > 0 && capitalRequiredCustom > 0
        ? (netMoneyCustom / capitalRequiredCustom) * 100
        : null;

    const summary = {
        totalSymbolsProcessed: signals.length,
        successfulCount: successful.length,
        failedCount: failed.length,
        triggeredCount: allTriggered.length,
        topPerformer: successful.length > 0 ? successful[0] : null,
        totalProfitPercent: round2(totalProfitPercent),
        totalCapitalRequired: round2(totalCapitalRequired),
        moneyEarned: round2(moneyEarned),
        moneyLost: round2(moneyLost),
        netMoney: round2(netMoney),
        netReturnPercent: round2(netReturnPercent),
        isNetProfit: netMoney >= 0,
        target: targetPct,
        stoploss: stoplossPct,
        targetHitCount,
        stoplossHitCount,
        trailingSL: trailingEnabled,
        trailingPercent: trailingPct,
        trailingStoplossHitCount,
        // Custom exit-time totals (null when no exitTime was requested,
        // or none of the triggered signals had a candle at/after it)
        exitTime: exitTimeVal,
        totalProfitPercentCustom: totalProfitPercentCustom !== null ? round2(totalProfitPercentCustom) : null,
        netMoneyCustom: netMoneyCustom !== null ? round2(netMoneyCustom) : null,
        netReturnPercentCustom: netReturnPercentCustom !== null ? round2(netReturnPercentCustom) : null,
        isNetProfitCustom: netMoneyCustom !== null ? netMoneyCustom >= 0 : null,
        // Avg Best Possible % — same idea as First15's backtest report:
        // the average, across every triggered trade, of the best profit %
        // that was ever available (i.e. `high`) before whatever exit
        // actually happened. Purely informational — shows how much upside
        // was typically left on the table.
        avgBestPossiblePercent: allTriggered.length > 0
            ? round2(allTriggered.reduce((sum, t) => sum + t.high, 0) / allTriggered.length)
            : null,
        customExitCount: withCustom.length
    };

    // If a custom exit time was requested, the money simulation should use
    // THAT exit price (not the default 3:05 close) — otherwise "what if I
    // exited at 11am" wouldn't actually change the P&L numbers, only the
    // informational column. Trades that don't have a candle at/after the
    // custom time (e.g. it's before 9:15 or after the data ends) fall back
    // to the default 3:05 exit, same as the text/Excel summary already does.
    const allSignalsLight = signals.map(s => ({ symbol: s.symbol, signal: s.signal }));

    const baseReport = {
        dateStr: resolvedDate,
        target: targetPct,
        stoploss: stoplossPct,
        rangeMin: rangeMinVal,
        rangeMax: rangeMaxVal,
        signalType: signalTypeVal,
        ratioMin: ratioMinVal,
        ratioMax: ratioMaxVal,
        exitTime: exitTimeVal,
        trailingSL: trailingEnabled,
        trailingPercent: trailingPct,
        broker: brokerVal,
        topN: topNVal,
        noSignals: false,
        successful, failed,
        successfulBuy, successfulSell,
        failedBuy, failedSell, failedNoData,
        summary,
        // Lightweight (symbol+signal only, no candle/price data) list of
        // EVERY signal considered for the day — this is what lets the
        // week/month simulator recompute allocation for a different
        // balance later without re-fetching candles from scratch.
        allSignals: allSignalsLight
    };

    // Cache the balance-independent result — this is what makes tweaking
    // the balance, or re-running the same date range with a different
    // target/stoploss you've already tried, come back near-instantly
    // instead of re-fetching and re-crunching candles all over again.
    setDayReportCache(cacheKey, baseReport);

    const allocation = computeAllocationForReport(baseReport, balanceVal);
    return { ...baseReport, balance: balanceVal, allocation };
}

/**
 * Runs `generateEodReport` for every weekday between `startDate` and
 * `endDate` (inclusive), chaining the balance through: each day's
 * ending balance (starting balance +/- that day's allocated P&L)
 * becomes the next day's starting balance. This answers "if I'd
 * invested ₹X at the start of the week/month and reinvested the whole
 * pot every day, where would I have ended up" — days with no triggered
 * signals simply carry the balance forward unchanged.
 *
 * @param {object} opts
 * @param {string} opts.startDate - YYYY-MM-DD
 * @param {string} opts.endDate - YYYY-MM-DD
 * @param {number} opts.balance - starting capital, e.g. 100000
 * @param {number|null} [opts.target]
 * @param {number|null} [opts.stoploss]
 * @param {number|null} [opts.rangeMin]
 * @param {number|null} [opts.rangeMax]
 * @param {string|null} [opts.signalType]
 * @param {number|null} [opts.ratioMin]
 * @param {number|null} [opts.ratioMax]
 * @param {string|null} [opts.exitTime]
 * @param {boolean} [opts.trailingSL]
 * @param {number|null} [opts.trailingPercent]
 * @param {(msg:string)=>void} [opts.onLog]
 */
export async function generateEodReportRange({ startDate, endDate, balance, target = null, stoploss = null, rangeMin = null, rangeMax = null, signalType = null, ratioMin = null, ratioMax = null, exitTime = null, trailingSL = false, trailingPercent = null, broker = null, topN = null, onLog = null } = {}) {
    const log = onLog || (() => { });
    const startBalance = Number(balance);
    const dates = enumerateWeekdays(startDate, endDate);

    // PERFORMANCE: the only reason a range simulation needs to be
    // sequential is the MONEY — each day's starting balance is whatever
    // the previous day ended with. But the expensive part (fetching
    // candles, working out which signals triggered, their entry/exit
    // prices and profit %) doesn't depend on the balance AT ALL — a
    // day's signals and prices are identical whether you started with
    // ₹10,000 or ₹10,00,000. So: fetch every day's report CONCURRENTLY
    // (capped, so we're not hammering Mongo/Fyers with 130 requests at
    // once), and only THEN walk through them in order — a pure,
    // in-memory, no-I/O pass — chaining the balance day to day. Same
    // exact math as before, just no longer waiting for each day's
    // fetch to finish before starting the next one's.
    // 20 is generous but safe: after backfilling, days almost always come
    // straight from Mongo (no Fyers rate limit to worry about), and Mongo
    // Atlas comfortably handles this many concurrent reads. If a day DOES
    // still need a live Fyers fallback, fetchCandleMap's own per-symbol
    // delay/retry logic inside that single day's run still protects it —
    // this cap only limits how many DAYS run at once, not Fyers calls per day.
    const CONCURRENCY = 20;
    const reports = await mapWithConcurrency(dates, CONCURRENCY, async (dateStr) => {
        log(`[Range] Fetching ${dateStr}...`);
        return generateEodReport({
            dateStr, target, stoploss, rangeMin, rangeMax, signalType, ratioMin, ratioMax, exitTime,
            trailingSL, trailingPercent, broker, topN,
            balance: null, onLog // balance intentionally omitted here — see note above
        });
    });

    let runningBalance = startBalance;
    const days = [];
    // Weighted avg Best Possible % across the whole range — weighted by
    // how many trades triggered each day, same idea as First15's range
    // summary. summary.avgBestPossiblePercent is itself already an
    // average, so we recover each day's total via avg*count to weight
    // correctly instead of just averaging the daily averages (which would
    // unfairly give a 1-trade day the same pull as a 20-trade day).
    let bestPossibleSum = 0;
    let bestPossibleCount = 0;

    for (let i = 0; i < dates.length; i++) {
        const dateStr = dates[i];
        const report = reports[i];
        const allocation = computeAllocationForReport(report, runningBalance);

        if (!report.noSignals && report.summary && report.summary.avgBestPossiblePercent !== null
            && report.summary.avgBestPossiblePercent !== undefined && report.summary.triggeredCount > 0) {
            bestPossibleSum += report.summary.avgBestPossiblePercent * report.summary.triggeredCount;
            bestPossibleCount += report.summary.triggeredCount;
        }

        if (report.noSignals || !allocation) {
            days.push({
                dateStr,
                noSignals: true,
                triggeredCount: 0,
                startBalance: round2(runningBalance),
                allocated: 0,
                unused: round2(runningBalance),
                pnl: 0,
                endBalance: round2(runningBalance),
                returnPercent: 0
            });
            continue;
        }

        days.push({
            dateStr,
            noSignals: false,
            triggeredCount: report.summary.triggeredCount,
            startBalance: allocation.startBalance,
            allocated: allocation.totalUsed,
            unused: allocation.totalUnused,
            pnl: allocation.totalPnl,
            endBalance: allocation.endingBalance,
            returnPercent: allocation.returnPercent
        });
        runningBalance = allocation.endingBalance;
    }

    const endBalance = round2(runningBalance);
    const totalPnl = round2(endBalance - startBalance);
    const tradingDaysCount = days.filter(d => !d.noSignals).length;
    const profitDays = days.filter(d => !d.noSignals && d.pnl > 0).length;
    const lossDays = days.filter(d => !d.noSignals && d.pnl < 0).length;

    return {
        startDate,
        endDate,
        startBalance: round2(startBalance),
        endBalance,
        totalPnl,
        totalReturnPercent: startBalance > 0 ? round2((totalPnl / startBalance) * 100) : 0,
        isProfit: totalPnl >= 0,
        avgBestPossiblePercent: bestPossibleCount > 0 ? round2(bestPossibleSum / bestPossibleCount) : null,
        totalDaysChecked: dates.length,
        tradingDaysCount,
        profitDays,
        lossDays,
        target, stoploss, rangeMin, rangeMax, signalType, ratioMin, ratioMax, exitTime,
        days
    };
}

/**
 * Renders the same plain-text report the CLI worker used to write to
 * disk, now including the target/stoploss/high/low/3:05 columns.
 */
export function renderReportText(report) {
    const { dateStr, target, stoploss, rangeMin, rangeMax, successful, successfulBuy, successfulSell, failed, failedBuy, failedSell, failedNoData, summary } = report;

    const lines = [];
    lines.push('EOD REPORT - PROFIT %');
    lines.push('======================');
    lines.push(`Date: ${dateStr}`);
    if (target !== null) lines.push(`Target: ${target}%`);
    if (stoploss !== null) lines.push(`Stoploss: ${stoploss}%`);
    if (rangeMin !== null || rangeMax !== null) {
        lines.push(`Price range filter: ${rangeMin !== null ? rangeMin : 'any'} - ${rangeMax !== null ? rangeMax : 'any'}`);
    }
    if (report.signalType) lines.push(`Signal filter: ${report.signalType}`);
    if (report.ratioMin !== null || report.ratioMax !== null) {
        lines.push(`Ratio filter: ${report.ratioMin !== null ? report.ratioMin : 'any'}x - ${report.ratioMax !== null ? report.ratioMax : 'any'}x`);
    }
    if (report.exitTime) lines.push(`Custom exit time: ${report.exitTime}`);
    lines.push('');

    if (report.noSignals) {
        lines.push('No signals found for this date.');
        return lines.join('\n');
    }

    lines.push(`SUCCESSFUL (${successful.length} stocks)`);
    lines.push('-----------------------');

    const hasCustomExit = Boolean(report.exitTime);
    const customExitLabel = `${report.exitTime} LTP / P%`;

    function pushTable(label, group) {
        lines.push('');
        lines.push(`${label} (${group.length} stocks)`);
        lines.push('-'.repeat(label.length + 12));
        lines.push('Rank  Symbol        Signal    Ratio     Entry     Exit      Exit Via  3:06 LTP  3:06 P%   Profit %   High %    Low %' + (hasCustomExit ? `  ${customExitLabel}` : ''));
        group.forEach((s, i) => {
            const exitVia = s.exitReason === 'target' ? 'TARGET' : s.exitReason === 'trailing_stoploss' ? 'TRAILING SL' : s.exitReason === 'stoploss' ? 'STOPLOSS' : 'EOD';
            const customCol = hasCustomExit ? `${String(s.ltpCustom ?? '-').padEnd(10)}${(typeof s.customPercent === 'number' ? s.customPercent.toFixed(2) + '%' : '-').padEnd(10)}` : '';
            lines.push(
                `${String(i + 1).padEnd(6)}${s.symbol.padEnd(14)}${s.signal.padEnd(10)}` +
                `${(typeof s.ratio === 'number' ? s.ratio.toFixed(2) + 'x' : '-').padEnd(10)}` +
                `${String(s.entryPrice).padEnd(10)}${String(s.exitPrice).padEnd(10)}${exitVia.padEnd(10)}` +
                `${String(s.ltp310 ?? '-').padEnd(10)}${(typeof s.ltp310Percent === 'number' ? s.ltp310Percent.toFixed(2) + '%' : '-').padEnd(10)}` +
                `${(s.profitPercent.toFixed(2) + '%').padEnd(11)}${(s.high.toFixed(2) + '%').padEnd(10)}${(s.low.toFixed(2) + '%').padEnd(10)}` +
                customCol
            );
        });
    }

    pushTable('BUY', successfulBuy);
    pushTable('SELL', successfulSell);

    lines.push('');
    lines.push(`FAILED (${failed.length} stocks)`);
    lines.push('------------------');
    pushTable('BUY', failedBuy);
    pushTable('SELL', failedSell);

    if (failedNoData.length > 0) {
        lines.push('');
        lines.push(`NOT ENTERED / NO DATA (${failedNoData.length} stocks)`);
        lines.push('-------------------------');
        lines.push('Rank  Symbol        Signal    Reason');
        failedNoData.forEach((f, i) => {
            lines.push(`${String(i + 1).padEnd(6)}${f.symbol.padEnd(14)}${f.signal.padEnd(10)}${f.reason}`);
        });
    }

    lines.push('');
    lines.push('SUMMARY');
    lines.push('-------');
    lines.push(`Total symbols processed: ${summary.totalSymbolsProcessed}`);
    lines.push(`Successful: ${summary.successfulCount}`);
    lines.push(`Failed: ${summary.failedCount}`);
    if (summary.topPerformer) {
        lines.push(`Top performer: ${summary.topPerformer.symbol} (${summary.topPerformer.signal}, ${summary.topPerformer.profitPercent.toFixed(2)}%)`);
    }
    if (target !== null) lines.push(`Target (${target}%) hit: ${summary.targetHitCount}`);
    if (stoploss !== null) lines.push(`Stoploss (${stoploss}%) hit: ${summary.stoplossHitCount}`);
    if (summary.trailingSL) lines.push(`Trailing Stoploss (${summary.trailingPercent}%) hit: ${summary.trailingStoplossHitCount}`);
    lines.push('');
    lines.push(`Total P/L % (sum of all trade %): ${summary.totalProfitPercent.toFixed(2)}%`);
    lines.push(`Capital required (1 share/stock, ${summary.triggeredCount} triggered): \u20b9${summary.totalCapitalRequired.toFixed(2)}`);
    lines.push(`Money earned from profitable stocks: \u20b9${summary.moneyEarned.toFixed(2)}`);
    lines.push(`Money lost from losing stocks: \u20b9${summary.moneyLost.toFixed(2)}`);
    lines.push(`Net: ${summary.isNetProfit ? 'PROFIT' : 'LOSS'} of \u20b9${Math.abs(summary.netMoney).toFixed(2)} (${summary.netReturnPercent.toFixed(2)}% on capital deployed)`);
    if (summary.avgBestPossiblePercent !== null) {
        lines.push(`Avg Best Possible % (upside left on the table): ${summary.avgBestPossiblePercent.toFixed(2)}%`);
    }
    if (report.exitTime && summary.customExitCount > 0) {
        lines.push('');
        lines.push(`If exited at ${report.exitTime} instead:`);
        lines.push(`  Total P/L % (sum of all trade %): ${summary.totalProfitPercentCustom.toFixed(2)}%`);
        lines.push(`  Net: ${summary.isNetProfitCustom ? 'PROFIT' : 'LOSS'} of \u20b9${Math.abs(summary.netMoneyCustom).toFixed(2)} (${summary.netReturnPercentCustom.toFixed(2)}% on capital deployed)`);
        lines.push(`  (based on ${summary.customExitCount}/${summary.triggeredCount} triggered signals that had a candle at/after ${report.exitTime})`);
    }

    if (report.allocation) {
        const a = report.allocation;
        lines.push('');
        lines.push('CAPITAL ALLOCATION');
        lines.push('-------------------');
        lines.push(`Starting balance: \u20b9${a.startBalance.toFixed(2)} split equally across ALL ${a.signalCount} signal(s) (only ${a.triggeredCount} triggered) = \u20b9${a.perSignalAllocation.toFixed(2)}/signal`);
        lines.push(`Used: \u20b9${a.totalUsed.toFixed(2)}   Unused (leftover): \u20b9${a.totalUnused.toFixed(2)}`);
        lines.push(`P/L: ${a.isProfit ? '+' : '-'}\u20b9${Math.abs(a.totalPnl).toFixed(2)} (${a.returnPercent.toFixed(2)}%)`);
        lines.push(`Ending balance: \u20b9${a.endingBalance.toFixed(2)}`);
        if (a.skippedNoQty > 0) lines.push(`Note: ${a.skippedNoQty} triggered signal(s) had a per-signal allocation too small to buy even 1 share.`);
        lines.push('');
        lines.push('Symbol        Signal    Triggered  Entry     Allocated ₹  Qty   Used ₹    Unused ₹  P&L ₹');
        a.detail.forEach(d => {
            lines.push(
                `${d.symbol.padEnd(14)}${d.signal.padEnd(10)}${(d.triggered ? 'YES' : 'no').padEnd(11)}${String(d.entryPrice ?? '-').padEnd(10)}` +
                `${d.allocated.toFixed(2).padEnd(13)}${String(d.qty).padEnd(6)}${d.used.toFixed(2).padEnd(10)}${d.unused.toFixed(2).padEnd(10)}${(d.pnl >= 0 ? '+' : '') + d.pnl.toFixed(2)}`
            );
        });
    }

    return lines.join('\n');
}

/**
 * Renders the same report as an .xlsx workbook (one sheet with every
 * triggered signal, one summary sheet) and returns a Buffer suitable
 * for sending straight over HTTP.
 */
export function renderReportExcel(report) {
    const wb = XLSX.utils.book_new();

    if (report.noSignals) {
        const ws = XLSX.utils.aoa_to_sheet([['No signals found for this date.']]);
        XLSX.utils.book_append_sheet(wb, ws, 'Report');
        return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    }

    const allTriggered = report.successful
        .concat(report.failed.filter(f => typeof f.profitPercent === 'number'))
        .sort((a, b) => b.profitPercent - a.profitPercent);

    const hasCustomExit = Boolean(report.exitTime);

    const header = [
        'Symbol', 'Signal', 'Ratio', 'Entry', 'Exit', 'Exit Via',
        '3:06 LTP', '3:06 Profit %',
        'Profit %', 'Best Possible %', 'Worst Dip %'
    ];
    if (hasCustomExit) header.push(`${report.exitTime} LTP`, `${report.exitTime} Profit %`);

    const rows = allTriggered.map(s => {
        const row = [
            s.symbol,
            s.signal,
            typeof s.ratio === 'number' ? s.ratio : '-',
            s.entryPrice,
            s.exitPrice,
            s.exitReason === 'target' ? 'TARGET' : s.exitReason === 'trailing_stoploss' ? 'TRAILING SL' : s.exitReason === 'stoploss' ? 'STOPLOSS' : 'EOD',
            s.ltp310 ?? '-',
            typeof s.ltp310Percent === 'number' ? round2(s.ltp310Percent) : '-',
            round2(s.profitPercent),
            round2(s.high),
            round2(s.low)
        ];
        if (hasCustomExit) row.push(s.ltpCustom ?? '-', typeof s.customPercent === 'number' ? round2(s.customPercent) : '-');
        return row;
    });

    const mainSheet = XLSX.utils.aoa_to_sheet([header, ...rows]);
    XLSX.utils.book_append_sheet(wb, mainSheet, 'Triggered Signals');

    if (report.failedNoData.length > 0) {
        const noDataHeader = ['Symbol', 'Signal', 'Ratio', 'Reason'];
        const noDataRows = report.failedNoData.map(f => [f.symbol, f.signal, typeof f.ratio === 'number' ? f.ratio : '-', f.reason]);
        const noDataSheet = XLSX.utils.aoa_to_sheet([noDataHeader, ...noDataRows]);
        XLSX.utils.book_append_sheet(wb, noDataSheet, 'Not Entered');
    }

    const s = report.summary;
    const summaryRows = [
        ['Date', report.dateStr],
        ['Target %', report.target ?? '-'],
        ['Stoploss %', report.stoploss ?? '-'],
        ['Price Range', `${report.rangeMin ?? 'any'} - ${report.rangeMax ?? 'any'}`],
        ['Signal Filter', report.signalType ?? 'ALL'],
        ['Ratio Range', `${report.ratioMin ?? 'any'} - ${report.ratioMax ?? 'any'}`],
        ['Signals', s.totalSymbolsProcessed],
        ['Triggered', s.triggeredCount],
        ['Total P/L %', s.totalProfitPercent],
        ['Net (\u20b9)', s.netMoney],
        ['Net Return % (on capital)', s.netReturnPercent],
        ['Avg Best Possible % (upside left on table)', s.avgBestPossiblePercent ?? '-'],
        ['Capital Required (\u20b9)', s.totalCapitalRequired],
        ['Target Hit', s.targetHitCount],
        ['Stoploss Hit', s.stoplossHitCount],
        ...(s.trailingSL ? [[`Trailing Stoploss Hit (${s.trailingPercent}%)`, s.trailingStoplossHitCount]] : [])
    ];
    if (report.exitTime) {
        summaryRows.push(
            ['Custom Exit Time', report.exitTime],
            [`Total P/L % @ ${report.exitTime}`, s.totalProfitPercentCustom ?? '-'],
            [`Net (\u20b9) @ ${report.exitTime}`, s.netMoneyCustom ?? '-'],
            [`Net Return % @ ${report.exitTime}`, s.netReturnPercentCustom ?? '-']
        );
    }
    if (report.allocation) {
        const a = report.allocation;
        summaryRows.push(
            ['Starting Balance (\u20b9)', a.startBalance],
            ['Signals (all)', a.signalCount],
            ['Signals Triggered', a.triggeredCount],
            ['Per-Signal Allocation (\u20b9)', a.perSignalAllocation],
            ['Used (\u20b9)', a.totalUsed],
            ['Unused (\u20b9)', a.totalUnused],
            ['Allocation P&L (\u20b9)', a.totalPnl],
            ['Allocation Return %', a.returnPercent],
            ['Ending Balance (\u20b9)', a.endingBalance]
        );
    }
    const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
    XLSX.utils.book_append_sheet(wb, summarySheet, 'Summary');

    if (report.allocation) {
        const allocHeader = ['Symbol', 'Signal', 'Triggered', 'Entry', 'Allocated ₹', 'Qty', 'Used ₹', 'Unused ₹', 'P&L ₹'];
        const allocRows = report.allocation.detail.map(d => [d.symbol, d.signal, d.triggered ? 'YES' : 'no', d.entryPrice ?? '-', d.allocated, d.qty, d.used, d.unused, d.pnl]);
        const allocSheet = XLSX.utils.aoa_to_sheet([allocHeader, ...allocRows]);
        XLSX.utils.book_append_sheet(wb, allocSheet, 'Capital Allocation');
    }

    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}