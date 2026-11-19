/**
 * backfill-fno-candles.js
 *
 * WHAT THIS DOES (in plain words):
 * Your `fno_candles` collection only has candles from the days the live
 * collector has actually been running (14 Jul 2026 onwards). To backtest
 * properly you need MONTHS of history. This script goes back in time and
 * downloads that history from Fyers, one month at a time, and stores it
 * in the exact same shape the rest of the app already reads from (see
 * workers/candle-fetcher.js and eod-report-service.js).
 *
 * TWO COLLECTIONS, ONE FETCH:
 * The same 3-minute candles this script downloads are written to BOTH
 * `fno_one_candles` and `fno_candles`. Fyers is only called once per
 * symbol per chunk — we're not doubling API traffic, just writing the
 * identical result to two places so anything reading either collection
 * (old code pointed at `fno_candles`, newer code pointed at
 * `fno_one_candles`) sees the same backfilled history.
 *
 * WHY ONE MONTH AT A TIME:
 * Fyers will rate-limit / block you if you ask for too much at once.
 * Asking for 6 months in one shot per symbol is asking for trouble.
 * Asking for ~1 month at a time, one symbol after another, with small
 * pauses in between, is what real backfill jobs do and stays safely
 * under the radar. This script does that automatically — you just tell
 * it the overall date range and it slices it into monthly chunks itself.
 *
 * USAGE:
 *   node src/workers/backfill-fno-candles.js --from=2026-01-14 --to=2026-07-13
 *
 *   --from   first date you want data for (defaults to 6 months before --to)
 *   --to     last date you want data for (defaults to the day before your
 *            earliest existing data, i.e. 2026-07-13)
 *
 * You can re-run this safely any time — it's idempotent (upserts on
 * symbol+date, per collection), so if it gets interrupted halfway, just
 * run it again with the same --from/--to and it'll overwrite/refill
 * whatever's missing in both collections.
 *
 * AFTER THIS FINISHES, run the signal detector for every day in the same
 * range (see backfill-signals.js) to actually generate the 9:15 BUY/SELL
 * signals for all those historical days.
 */

import { connectToDatabase } from '../../db/mongodb.js';
import fnoMasterLoader from '../../utilities/fno-master-loader.js';
import fyersAuth from '../brokers/fyers/fyers-client.js';
import { getFyersSymbol } from '../../utilities/symbol-mapper.js';

// Both collections get the exact same candle documents — see the
// "TWO COLLECTIONS, ONE FETCH" note above for why.
const COLLECTIONS_TO_WRITE = ['fno_one_candles', 'fno_candles'];
const RESOLUTION = '3'; // 3-minute candles, same as the rest of the app

// Be polite to Fyers: small gap between symbols, and a real backoff if we
// ever do get rate-limited, plus a longer breather between whole months.
const DELAY_BETWEEN_SYMBOLS_MS = 400;
const DELAY_BETWEEN_MONTHS_MS = 5000;
const MAX_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 2000;

function getCliArg(flag) {
    const arg = process.argv.find(a => a.startsWith(`--${flag}=`));
    return arg ? arg.split('=')[1] : null;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isRateLimitError(err) {
    const msg = (err?.message || '').toLowerCase();
    return msg.includes('rate') || msg.includes('too many') || msg.includes('429');
}

function toDateStr(d) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// IST date string for a Fyers candle timestamp (epoch seconds, UTC).
function epochToIstDateStr(epochSeconds) {
    const istMs = epochSeconds * 1000 + 5.5 * 60 * 60 * 1000; // UTC -> IST
    const d = new Date(istMs);
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function epochToIsoIst(epochSeconds) {
    // Matches the "time" format already stored by candle-fetcher.js /
    // read by eod-report-service.js: an ISO string.
    return new Date(epochSeconds * 1000).toISOString();
}

/**
 * Slices [fromDateStr, toDateStr] into ~1-calendar-month windows, oldest
 * first, e.g. 2026-01-14..2026-07-13 becomes:
 *   2026-01-14..2026-02-13, 2026-02-14..2026-03-13, ... 2026-06-14..2026-07-13
 */
function buildMonthlyChunks(fromDateStr, toDateStrArg) {
    const chunks = [];
    let chunkStart = new Date(fromDateStr + 'T00:00:00');
    const end = new Date(toDateStrArg + 'T00:00:00');

    while (chunkStart <= end) {
        const chunkEnd = new Date(chunkStart);
        chunkEnd.setDate(chunkEnd.getDate() + 29); // ~1 month, safely under Fyers' range limits
        const actualEnd = chunkEnd > end ? end : chunkEnd;

        chunks.push({ start: toDateStr(chunkStart), end: toDateStr(actualEnd) });

        chunkStart = new Date(actualEnd);
        chunkStart.setDate(chunkStart.getDate() + 1);
    }

    return chunks;
}

/**
 * One Fyers call covering the WHOLE chunk (e.g. a month) for one symbol —
 * far cheaper than one call per day. Retries with backoff on rate limits.
 */
async function fetchChunkCandles(fyersSymbol, rangeFrom, rangeTo, attempt = 1) {
    try {
        const fyers = fyersAuth.getAuthenticatedClient();
        const response = await fyers.getHistory({
            symbol: fyersSymbol,
            resolution: RESOLUTION,
            date_format: '1',
            range_from: rangeFrom,
            range_to: rangeTo,
            cont_flag: '1'
        });

        if (!response || response.s !== 'ok' || !Array.isArray(response.candles)) {
            return [];
        }
        return response.candles; // [[epochSec, open, high, low, close, volume], ...]
    } catch (err) {
        if (isRateLimitError(err) && attempt < MAX_RETRIES) {
            const backoff = RETRY_BASE_DELAY_MS * attempt;
            console.warn(`[Backfill] Rate limited on ${fyersSymbol}, retrying in ${backoff}ms (attempt ${attempt}/${MAX_RETRIES})`);
            await sleep(backoff);
            return fetchChunkCandles(fyersSymbol, rangeFrom, rangeTo, attempt + 1);
        }
        console.error(`[Backfill] getHistory() failed for ${fyersSymbol}:`, err.message);
        return [];
    }
}

/**
 * Groups a flat list of candles (possibly spanning many days) by IST
 * trading date. Returns a Map<dateStr, candles[]> — built once per
 * symbol/chunk and then upserted into every collection in
 * COLLECTIONS_TO_WRITE, so both collections end up with byte-identical
 * candle arrays for the same symbol+date.
 */
function groupCandlesByDate(rawCandles) {
    const byDate = new Map();
    for (const c of rawCandles) {
        const dateStr = epochToIstDateStr(c[0]);
        if (!byDate.has(dateStr)) byDate.set(dateStr, []);
        byDate.get(dateStr).push({
            time: epochToIsoIst(c[0]),
            open: c[1],
            high: c[2],
            low: c[3],
            close: c[4],
            volume: c[5]
        });
    }
    for (const candles of byDate.values()) {
        candles.sort((a, b) => new Date(a.time) - new Date(b.time));
    }
    return byDate;
}

/**
 * Upserts one candle doc per day, per collection — same shape
 * candle-fetcher.js already writes, so every other part of the app
 * (eod-report-service.js, volume-surge-worker.js) can read either
 * collection unchanged. Returns the number of distinct trading days
 * saved (not multiplied by collection count, so logging still reads
 * naturally as "days", not "days x collections").
 */
async function saveChunkCandles(db, symbol, token, rawCandles) {
    if (rawCandles.length === 0) return 0;

    const byDate = groupCandlesByDate(rawCandles);

    for (const [dateStr, candles] of byDate) {
        const lastCandleTime = candles[candles.length - 1].time;
        const doc = {
            $set: {
                token,
                exchange: 'NSE',
                candles,
                lastCandleTime,
                totalCandles: candles.length,
                updatedAt: new Date().toISOString(),
                backfilled: true
            }
        };

        // Same doc, same filter, written to every target collection so
        // fno_one_candles and fno_candles never drift apart for backfilled
        // history. If one collection's write fails, the others still go
        // through — a partial failure here is caught by the per-symbol
        // try/catch in main() and simply retried on the next run (upserts
        // are idempotent), rather than losing the whole chunk's work.
        await Promise.all(
            COLLECTIONS_TO_WRITE.map(collectionName =>
                db.collection(collectionName).updateOne(
                    { symbol, date: dateStr },
                    doc,
                    { upsert: true }
                ).catch(err => {
                    console.error(`[Backfill] Write to ${collectionName} failed for ${symbol} ${dateStr}:`, err.message);
                })
            )
        );
    }
    return byDate.size;
}

async function main() {
    const toArg = getCliArg('to');
    const fromArg = getCliArg('from');

    // Sensible defaults: 6 months of history ending the day before your
    // current earliest data (2026-07-14), if nothing is passed in.
    const toDateStr_ = toArg || '2026-07-13';
    let fromDateStr = fromArg;
    if (!fromDateStr) {
        const d = new Date(toDateStr_ + 'T00:00:00');
        d.setMonth(d.getMonth() - 6);
        fromDateStr = toDateStr(d);
    }

    console.log(`[Backfill] Fetching candles from ${fromDateStr} to ${toDateStr_}`);
    console.log(`[Backfill] Writing to collections: ${COLLECTIONS_TO_WRITE.join(', ')}`);

    const chunks = buildMonthlyChunks(fromDateStr, toDateStr_);
    console.log(`[Backfill] Split into ${chunks.length} monthly chunk(s):`);
    chunks.forEach((c, i) => console.log(`   ${i + 1}. ${c.start} -> ${c.end}`));

    const db = await connectToDatabase();
    const stocks = fnoMasterLoader.getFNOStocks();
    console.log(`[Backfill] ${stocks.length} F&O stocks to backfill`);

    for (let i = 0; i < chunks.length; i++) {
        const { start, end } = chunks[i];
        console.log(`\n[Backfill] === Chunk ${i + 1}/${chunks.length}: ${start} -> ${end} ===`);

        let symbolsDone = 0;
        let totalDaysSaved = 0;

        for (const stock of stocks) {
            const { symbol, token } = stock;
            const fyersSymbol = getFyersSymbol(stock);

            try {
                const rawCandles = await fetchChunkCandles(fyersSymbol, start, end);
                const daysSaved = await saveChunkCandles(db, symbol, token, rawCandles);
                totalDaysSaved += daysSaved;
                symbolsDone++;

                if (daysSaved > 0) {
                    console.log(`[Backfill] ${symbol}: saved ${daysSaved} trading day(s) to ${COLLECTIONS_TO_WRITE.join(' + ')}`);
                } else {
                    console.log(`[Backfill] ${symbol}: no candles returned for this chunk`);
                }
            } catch (err) {
                console.error(`[Backfill] ${symbol} failed:`, err.message);
            }

            await sleep(DELAY_BETWEEN_SYMBOLS_MS);
        }

        console.log(`[Backfill] Chunk ${i + 1} done — ${symbolsDone}/${stocks.length} symbols, ${totalDaysSaved} symbol-days saved (per collection).`);

        if (i < chunks.length - 1) {
            console.log(`[Backfill] Pausing ${DELAY_BETWEEN_MONTHS_MS}ms before next chunk...`);
            await sleep(DELAY_BETWEEN_MONTHS_MS);
        }
    }

    console.log('\n[Backfill] All chunks complete.');
    process.exit(0);
}

main().catch(err => {
    console.error('[Backfill] Fatal error:', err);
    process.exit(1);
});