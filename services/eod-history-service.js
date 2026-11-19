/**
 * eod-history-service.js
 *
 * WHY THIS EXISTS: buildRealEodReport() (see alert-scheduler.js) builds
 * the 3:10 PM EOD email straight from Shoonya's live PositionBook —
 * that's the broker's OWN ledger, so it's ground truth for TODAY. But
 * Shoonya's PositionBook only ever shows the CURRENT trading day; it
 * resets every morning. There is no "give me yesterday's PositionBook"
 * API call — once the day rolls over, that data is gone from the broker
 * side forever unless we save it ourselves.
 *
 * This module is that save. Every day, right after the real 3:10 PM EOD
 * report is built (and BEFORE the email is sent, so a failed email never
 * loses the record), we upsert one document per trading day into
 * `EOD_HISTORY_COLLECTION` with every closed trade's entry/exit/P&L, any
 * positions still open at that moment, and the day's summary totals.
 * Later, `getEodHistoryForDate()` / `getEodHistoryRange()` let you pull
 * any past day back out — e.g. "show me yesterday's summary" — without
 * ever touching the broker again.
 *
 * IMPORTANT — write path is intentionally narrow: only
 * `runEodReportEmail()` (the real 3:10 PM cron, which always uses
 * TODAY's date) calls `saveEodDayRecord()`. The manual
 * `/api/eod-report/send-test-email?date=X` route also calls
 * buildRealEodReport(), but for a PAST `date` that function is still
 * only able to read TODAY's live PositionBook from Shoonya (the broker
 * has no past-day position data to give it) — so if that route were
 * allowed to write history too, testing with an old date would silently
 * overwrite a real historical record with today's data mislabeled as
 * that old date. So history is only ever written by the genuine daily
 * run, never by a manual/test call.
 */

import { connectToDatabase } from '../db/mongodb.js';

export const EOD_HISTORY_COLLECTION = 'eod_daily_trade_history';

/**
 * Upserts today's real EOD report (the same object built by
 * buildRealEodReport()) into the day-wise history collection, keyed by
 * dateStr so re-running the same day's report never creates a duplicate
 * — it just refreshes that day's record.
 */
export async function saveEodDayRecord(report) {
    if (!report?.dateStr) return null;

    const db = await connectToDatabase();

    const closedTrades = [
        ...(report.successful || []),
        ...(report.failedBuy || []),
        ...(report.failedSell || [])
    ].map(t => ({
        symbol: t.symbol,
        side: t.signal,
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice,
        exitReason: t.exitReason ?? null,
        profitPercent: t.profitPercent ?? null,
        pnl: t.pnl ?? null
    }));

    const openPositionsAtCapture = (report.stillOpen || []).map(t => ({
        symbol: t.symbol,
        side: t.signal,
        entryPrice: t.entryPrice ?? null
    }));

    const now = new Date().toISOString();

    await db.collection(EOD_HISTORY_COLLECTION).updateOne(
        { dateStr: report.dateStr },
        {
            $set: {
                dateStr: report.dateStr,
                closedTrades,
                openPositionsAtCapture,
                summary: {
                    totalSymbolsProcessed: report.summary?.totalSymbolsProcessed ?? 0,
                    closedCount: report.summary?.triggeredCount ?? 0,
                    openCount: openPositionsAtCapture.length,
                    totalProfitPercent: report.summary?.totalProfitPercent ?? 0,
                    netMoney: report.summary?.netMoney ?? 0
                },
                updatedAt: now
            },
            $setOnInsert: { createdAt: now }
        },
        { upsert: true }
    );

    return { dateStr: report.dateStr, tradeCount: closedTrades.length };
}

/**
 * Fetches the saved day-wise record for one date (e.g. "yesterday's
 * summary"). Returns null if nothing was ever captured for that date
 * (bot wasn't running, or it's a future/non-trading date).
 */
export async function getEodHistoryForDate(dateStr) {
    const db = await connectToDatabase();
    return db.collection(EOD_HISTORY_COLLECTION).findOne(
        { dateStr },
        { projection: { _id: 0 } }
    );
}

/**
 * Fetches every saved day-wise record between startDate and endDate
 * (inclusive, both "YYYY-MM-DD"), oldest first — for a week/month-style
 * history view.
 */
export async function getEodHistoryRange(startDate, endDate) {
    const db = await connectToDatabase();
    return db.collection(EOD_HISTORY_COLLECTION)
        .find(
            { dateStr: { $gte: startDate, $lte: endDate } },
            { projection: { _id: 0 } }
        )
        .sort({ dateStr: 1 })
        .toArray();
}