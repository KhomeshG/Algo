import { delay, getTodayDate } from '../../workers/worker-helpers.js';
import { connectToDatabase } from "../../db/mongodb.js";
import fnoMasterLoader from '../../utilities/fno-master-loader.js';
import fyersAuth from '../brokers/fyers/fyers-client.js';
import { getFyersSymbol } from '../../utilities/symbol-mapper.js';
import { isTradingDay } from '../../utilities/trading-days-loader.js';

const COLLECTION_CANDLES = 'fno_candles';            // read-only here — previous day's 20 candles
const COLLECTION_SURGE = 'mw_volume_surge_patterns';  // where matches get stored

const RESOLUTION = '3';

const PREVIOUS_DAY_CANDLE_COUNT = 20;  // last 20 candles from previous day
const EMA_LENGTH = 21;                 // 20 previous-day + 1 today's = 21
const BUY_MULTIPLIER = 5;
const SELL_MULTIPLIER = 3;

// How many symbols we're allowed to hit Fyers for AT THE SAME TIME when
// today's candle is missing from the DB. Lowered from 8 -> 2 after hitting
// "request limit reached" on every symbol when all 204 stocks needed a
// live fetch at once (8-at-a-time with only a 250ms gap worked out to
// ~32 requests/sec, which is too fast for Fyers' actual limit).
const FYERS_FALLBACK_CONCURRENCY = 2;

// Gap between the START of one Fyers call and the next, PER PARALLEL SLOT.
// With CONCURRENCY=2 and a 600ms gap per slot, that's roughly ~3-4
// requests/sec spread out — slower, but reliable even when every symbol
// needs a live fetch (e.g. on a fresh/backfill day with nothing cached).
const FYERS_CALL_GAP_MS = 600;

// Target time is always 09:15 — the day's opening 3-min candle — regardless
// of when this worker actually runs. Date can be overridden for backfilling
// a day you missed:
//   node volume-surge-worker.js --date=2026-07-14
function getCliArg(flag) {

    const arg =
        process.argv.find(a => a.startsWith(`--${flag}=`));

    return arg
        ? arg.split('=')[1]
        : null;
}

// const TARGET_DATE = "2026-07-13"; // the 09:15-09:18 3-min candle
const TARGET_DATE = getCliArg('date') || process.env.TARGET_DATE || getTodayDate();
const TARGET_TIME = '09:15'; // the 09:15-09:18 3-min candle

function getTargetTimestamp(dateStr) {

    return new Date(`${dateStr}T${TARGET_TIME}:00+05:30`).getTime();
}

function toEpoch(timeStr) {

    return new Date(timeStr).getTime();
}

function formatFyersDate(date) {

    return new Date(date)
        .toISOString()
        .split('T')[0];
}

async function fetchTodayCandleFromFyers(
    fyersSymbol,
    dateStr,
    targetTimestamp,
    retryCount = 0
) {

    try {

        const fyers =
            fyersAuth.getAuthenticatedClient();

        const payload = {

            symbol: fyersSymbol,

            resolution: RESOLUTION,

            date_format: '1',

            range_from: formatFyersDate(dateStr),

            range_to: formatFyersDate(dateStr),

            cont_flag: 1
        };

        const response =
            await fyers.getHistory(payload);

        if (!response || !response.candles) {

            return null;
        }

        const candles =
            response.candles.map(
                candle => ({

                    time:
                        new Date(candle[0] * 1000).toISOString(),

                    open: candle[1],
                    high: candle[2],
                    low: candle[3],
                    close: candle[4],
                    volume: candle[5]
                })
            );

        return (
            candles.find(c => toEpoch(c.time) === targetTimestamp) || null
        );

    } catch (err) {

        console.error(
            `[MW Volume Surge Worker] Fyers fetch error for ${fyersSymbol}:`,
            err.message
        );

        if (retryCount >= 3) {

            return null;
        }

        const backoffTime =
            Math.pow(2, retryCount) * 2000;

        await delay(backoffTime);

        return fetchTodayCandleFromFyers(
            fyersSymbol,
            dateStr,
            targetTimestamp,
            retryCount + 1
        );
    }
}

// Direct port of ta.ema(volume, 21): seed with SMA of the first `length`
// values. With exactly 21 candles (20 previous-day + 1 today), the EMA at
// the last index IS that seed SMA — matching how ta.ema initializes on the
// bar where it first has enough history.
function computeEma(values, length) {

    if (values.length < length) {

        return null;
    }

    const k = 2 / (length + 1);

    let ema =
        values
            .slice(0, length)
            .reduce((a, b) => a + b, 0) / length;

    for (let i = length; i < values.length; i++) {

        ema =
            values[i] * k +
            ema * (1 - k);
    }

    return ema;
}

// isBuy  = close > open  and volume >= 5 * ema_vol
// isSell = close < open  and volume >= 3 * ema_vol
function evaluateCandle(candles) {

    const volumes =
        candles.map(c => c.volume);

    const emaVol =
        computeEma(volumes, EMA_LENGTH);

    if (emaVol == null) {

        return null;
    }

    const last =
        candles[candles.length - 1];

    const isGreen = last.close > last.open;
    const isRed = last.close < last.open;

    const ratio =
        emaVol > 0
            ? last.volume / emaVol
            : 0;

    const isBuy =
        isGreen &&
        last.volume >= BUY_MULTIPLIER * emaVol;

    const isSell =
        isRed &&
        last.volume >= SELL_MULTIPLIER * emaVol;

    if (!isBuy && !isSell) {

        return null;
    }

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

// ---------------------------------------------------------------------
// BULK DB READS
// ---------------------------------------------------------------------
// Instead of 2 queries PER symbol (400+ round trips for 204 stocks), we
// do this in a small, fixed number of queries total:
//   1. One aggregation to get each symbol's most recent candle-doc
//      strictly BEFORE today (the "previous trading day" doc).
//   2. One find() to get every symbol's candle-doc for TODAY, in case
//      the live collector has already written it.
// Both are indexed on {symbol, date}, so these stay fast even as the
// fno_candles collection grows.
// ---------------------------------------------------------------------
async function getPreviousDayCandlesBulk(db, symbols, beforeDateStr) {

    // NOTE: allowDiskUse is blocked on MongoDB Atlas free-tier clusters
    // (M0/M2/M5), so a $sort on full documents (which include the large
    // `candles` array) can blow past the 32MB in-memory sort limit as the
    // collection grows. Fix: sort only a tiny "identity" projection
    // (_id, symbol, date) first — that's small enough to always fit in
    // memory — then fetch the full docs for just the winning _ids.

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

        // Sort ascending by time before slicing — the previous version
        // assumed the array was already in order, which is risky if a
        // doc is ever written out of order. This makes the EMA input
        // correct regardless of storage order.
        const sorted = [...candles].sort(
            (a, b) => toEpoch(a.time) - toEpoch(b.time)
        );

        map.set(row._id, sorted.slice(-PREVIOUS_DAY_CANDLE_COUNT));
    }

    return map;
}

async function getTodayCandlesBulk(db, symbols, dateStr, targetTimestamp) {

    const docs = await db.collection(COLLECTION_CANDLES)
        .find({ symbol: { $in: symbols }, date: dateStr })
        .toArray();

    const map = new Map();

    for (const doc of docs) {

        if (!Array.isArray(doc.candles)) continue;

        const match = doc.candles.find(c => toEpoch(c.time) === targetTimestamp);

        if (match) map.set(doc.symbol, match);
    }

    return map;
}

// Runs `worker(item)` over `items` with at most `concurrency` running at
// once, waiting `gapMs` between the START of each call within a slot.
// This is what replaces the old "await delay(300) after every single
// stock" — now the delay only applies to symbols that actually need a
// live Fyers call, and several of those happen in parallel.
async function runWithConcurrency(items, concurrency, gapMs, worker) {

    let cursor = 0;

    async function runSlot() {

        while (cursor < items.length) {

            const index = cursor++;

            await worker(items[index], index);

            if (cursor < items.length) {
                await delay(gapMs);
            }
        }
    }

    const slots =
        Array.from(
            { length: Math.min(concurrency, items.length) },
            runSlot
        );

    await Promise.all(slots);
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

async function main() {

    const startTime = Date.now();
    console.log(
        '[MW Volume Surge Worker] Starting...'
    );

    if (!isTradingDay(TARGET_DATE)) {
        console.log(
            `[MW Volume Surge Worker] ⏭️  ${TARGET_DATE} is not a trading day ` +
            `(weekend or NSE holiday) — skipping.`
        );
        return;
    }

    const db =
        await connectToDatabase();

    try {

        const targetTimestamp = getTargetTimestamp(TARGET_DATE);

        console.log(
            `[MW Volume Surge Worker] Target candle: ${TARGET_TIME} (${TARGET_DATE})`
        );

        const stocks =
            fnoMasterLoader.getFNOStocks();

        console.log(
            `[MW Volume Surge Worker] Checking ${stocks.length} stocks`
        );

        const symbols = stocks.map(s => s.symbol);

        // ---- 1. Bulk-fetch everything we can from the DB in ~2 queries ----
        const [previousDayMap, todayFromDbMap] = await Promise.all([
            getPreviousDayCandlesBulk(db, symbols, TARGET_DATE),
            getTodayCandlesBulk(db, symbols, TARGET_DATE, targetTimestamp)
        ]);

        // ---- 2. Figure out which stocks still need a live Fyers call ----
        // (only stocks that have enough previous-day history AND are
        // missing today's candle in the DB — no point calling Fyers for
        // a stock we're going to skip anyway.)
        const stocksNeedingFyers = stocks.filter(stock => {

            const prev = previousDayMap.get(stock.symbol);
            const hasEnoughHistory = prev && prev.length >= PREVIOUS_DAY_CANDLE_COUNT;
            const alreadyHasToday = todayFromDbMap.has(stock.symbol);

            return hasEnoughHistory && !alreadyHasToday;
        });

        console.log(
            `[MW Volume Surge Worker] ${todayFromDbMap.size} already in DB, ` +
            `${stocksNeedingFyers.length} need a live Fyers fetch`
        );

        // ---- 3. Fetch the missing ones from Fyers, several in parallel ----
        const fyersResultMap = new Map();

        await runWithConcurrency(
            stocksNeedingFyers,
            FYERS_FALLBACK_CONCURRENCY,
            FYERS_CALL_GAP_MS,
            async (stock) => {

                const fyersSymbol = getFyersSymbol(stock);

                const candle = await fetchTodayCandleFromFyers(
                    fyersSymbol,
                    TARGET_DATE,
                    targetTimestamp
                );

                if (candle) {
                    fyersResultMap.set(stock.symbol, candle);
                } else {
                    console.log(
                        `[MW Volume Surge Worker] ${stock.symbol} - ${TARGET_TIME} candle not available from Fyers yet`
                    );
                }
            }
        );

        // ---- 4. Evaluate every stock in memory (no more DB/API calls) ----
        const surgeDocs = [];

        for (const stock of stocks) {

            const previousDayCandles = previousDayMap.get(stock.symbol);

            if (!previousDayCandles || previousDayCandles.length < PREVIOUS_DAY_CANDLE_COUNT) {

                console.log(
                    `[MW Volume Surge Worker] ${stock.symbol} - not enough previous day candles, skipping`
                );

                continue;
            }

            const todayCandle =
                todayFromDbMap.get(stock.symbol) ||
                fyersResultMap.get(stock.symbol);

            if (!todayCandle) {
                continue; // already logged above for the Fyers-fallback case
            }

            const combinedCandles = [...previousDayCandles, todayCandle];

            const result = evaluateCandle(combinedCandles);

            if (!result) continue;

            surgeDocs.push({ stock, result });

            console.log(
                `[MW Volume Surge Worker] ${stock.symbol} ${result.signal} @ ${result.candleTime} (ratio ${result.ratio.toFixed(2)}x)`
            );
        }

        // ---- 5. Write all matches in ONE bulk DB call instead of many ----
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
            `[MW Volume Surge Worker] Completed — ${surgeDocs.length} signal(s) found`
        );

    } catch (err) {

        console.error(
            err
        );

    } finally {

        const elapsedMs = Date.now() - startTime;
        console.log(
            `[MW Volume Surge Worker] Finished in ${(elapsedMs / 1000).toFixed(2)} s`
        );

        process.exit(0);
    }
}

main();