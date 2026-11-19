import express from 'express';
import {
    generateEodReport, generateEodReportRange, renderReportText, renderReportExcel,
    getTodayDateStr, getWeekRange, getMonthRange
} from '../src/services/eod-report-service.js';
import { askAboutReport } from '../src/services/eod-report-chat-service.js';
import { runEodReportEmail, buildRealEodReport } from '../services/alert-scheduler.js';
import { getEodHistoryForDate, getEodHistoryRange, saveEodDayRecord } from '../services/eod-history-service.js';

const router = express.Router();

function parseNumericParam(value) {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    return Number.isNaN(n) ? null : n;
}

function parseBooleanParam(value) {
    return value === 'true' || value === '1' || value === 'on';
}

// GET /api/eod-report - renders the report dashboard (form + results shell).
// The page itself calls /api/eod-report/run via fetch() to load data, so
// this route just needs to render the shell with today's date pre-filled.
router.get('/', (req, res) => {
    res.render('eod-report', {
        defaultDate: getTodayDateStr()
    });
});

// GET /api/eod-report/run?date=YYYY-MM-DD&target=2&stoploss=1
// Returns the full report as JSON. Used by the dashboard's fetch() call,
// and usable directly as an API by anything else (Postman, scripts, etc).
router.get('/run', async (req, res) => {
    try {
        const dateStr = req.query.date || getTodayDateStr();
        const target = parseNumericParam(req.query.target);
        const stoploss = parseNumericParam(req.query.stoploss);
        const rangeMin = parseNumericParam(req.query.rangeMin);
        const rangeMax = parseNumericParam(req.query.rangeMax);
        const signalType = req.query.signalType || null;
        const ratioMin = parseNumericParam(req.query.ratioMin);
        const ratioMax = parseNumericParam(req.query.ratioMax);
        const exitTime = req.query.exitTime || null;
        const balance = parseNumericParam(req.query.balance);
        const trailingSL = parseBooleanParam(req.query.trailingSL);
        const trailingPercent = parseNumericParam(req.query.trailingPercent);
        const broker = req.query.broker || null;
        const topN = parseNumericParam(req.query.topN);

        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
            return res.status(400).json({ success: false, message: 'date must be in YYYY-MM-DD format' });
        }

        const report = await generateEodReport({ dateStr, target, stoploss, rangeMin, rangeMax, signalType, ratioMin, ratioMax, exitTime, balance, trailingSL, trailingPercent, broker, topN });
        return res.json({ success: true, report });
    } catch (err) {
        console.error('[EOD Report Route] Failed to generate report:', err);
        return res.status(500).json({ success: false, message: err.message || 'Failed to generate report' });
    }
});

// GET /api/eod-report/run-range?period=week|month&date=YYYY-MM-DD&balance=100000&target=2&stoploss=1
//     or ?period=custom&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&balance=100000
// Simulates investing `balance` over a date range, re-splitting the
// (running) balance equally across every signal each trading day and
// carrying the resulting balance into the next day. `period=week`/`month`
// derive the range from whatever week/month `date` falls in; `period=custom`
// lets the caller pick ANY start/end date directly (any past week, month,
// quarter, or arbitrary stretch of trading days). Returns a day-by-day
// breakdown plus the overall starting/ending balance and return %.
router.get('/run-range', async (req, res) => {
    try {
        const period = (req.query.period || 'week').toLowerCase();
        const balance = parseNumericParam(req.query.balance) ?? 100000;
        const target = parseNumericParam(req.query.target);
        const stoploss = parseNumericParam(req.query.stoploss);
        const rangeMin = parseNumericParam(req.query.rangeMin);
        const rangeMax = parseNumericParam(req.query.rangeMax);
        const signalType = req.query.signalType || null;
        const ratioMin = parseNumericParam(req.query.ratioMin);
        const ratioMax = parseNumericParam(req.query.ratioMax);
        const exitTime = req.query.exitTime || null;
        const trailingSL = parseBooleanParam(req.query.trailingSL);
        const trailingPercent = parseNumericParam(req.query.trailingPercent);
        const broker = req.query.broker || null;
        const topN = parseNumericParam(req.query.topN);

        if (period !== 'week' && period !== 'month' && period !== 'custom') {
            return res.status(400).json({ success: false, message: 'period must be week, month, or custom' });
        }
        if (!balance || balance <= 0) {
            return res.status(400).json({ success: false, message: 'balance must be a positive number' });
        }

        let start, end;

        if (period === 'custom') {
            start = req.query.startDate;
            end = req.query.endDate;
            if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
                return res.status(400).json({ success: false, message: 'startDate and endDate must be in YYYY-MM-DD format' });
            }
            if (start > end) {
                return res.status(400).json({ success: false, message: 'startDate must be on or before endDate' });
            }
        } else {
            const dateStr = req.query.date || getTodayDateStr();
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
                return res.status(400).json({ success: false, message: 'date must be in YYYY-MM-DD format' });
            }
            const r = period === 'week' ? getWeekRange(dateStr) : getMonthRange(dateStr);
            start = r.start;
            end = r.end;
        }

        const result = await generateEodReportRange({
            startDate: start, endDate: end, balance,
            target, stoploss, rangeMin, rangeMax, signalType, ratioMin, ratioMax, exitTime, trailingSL, trailingPercent,
            broker, topN
        });

        return res.json({ success: true, period, result });
    } catch (err) {
        console.error('[EOD Report Route] Failed to generate range report:', err);
        return res.status(500).json({ success: false, message: err.message || 'Failed to generate range report' });
    }
});

// GET /api/eod-report/download?date=YYYY-MM-DD&target=2&stoploss=1&rangeMin=100&rangeMax=500&format=txt|xlsx
// Same data as /run, returned as a downloadable file. `format` defaults
// to `txt` (plain text); pass `format=xlsx` for an Excel workbook.
router.get('/download', async (req, res) => {
    try {
        const dateStr = req.query.date || getTodayDateStr();
        const target = parseNumericParam(req.query.target);
        const stoploss = parseNumericParam(req.query.stoploss);
        const rangeMin = parseNumericParam(req.query.rangeMin);
        const rangeMax = parseNumericParam(req.query.rangeMax);
        const signalType = req.query.signalType || null;
        const ratioMin = parseNumericParam(req.query.ratioMin);
        const ratioMax = parseNumericParam(req.query.ratioMax);
        const exitTime = req.query.exitTime || null;
        const balance = parseNumericParam(req.query.balance);
        const trailingSL = parseBooleanParam(req.query.trailingSL);
        const trailingPercent = parseNumericParam(req.query.trailingPercent);
        const broker = req.query.broker || null;
        const topN = parseNumericParam(req.query.topN);
        const format = (req.query.format || 'txt').toLowerCase();

        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
            return res.status(400).json({ success: false, message: 'date must be in YYYY-MM-DD format' });
        }
        if (format !== 'txt' && format !== 'xlsx') {
            return res.status(400).json({ success: false, message: 'format must be txt or xlsx' });
        }

        const report = await generateEodReport({ dateStr, target, stoploss, rangeMin, rangeMax, signalType, ratioMin, ratioMax, exitTime, balance, trailingSL, trailingPercent, broker, topN });

        if (format === 'xlsx') {
            const buffer = renderReportExcel(report);
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename="eod-report-${dateStr}.xlsx"`);
            return res.send(buffer);
        }

        const text = renderReportText(report);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="eod-report-${dateStr}.txt"`);
        return res.send(text);
    } catch (err) {
        console.error('[EOD Report Route] Failed to generate report download:', err);
        return res.status(500).json({ success: false, message: err.message || 'Failed to generate report' });
    }
});

// POST /api/eod-report/chat
// Body: { report: <the report object from /run>, question: string, history?: [{role, content}] }
// Lets investors ask free-form questions about an already-generated
// report ("which BUY had the best profit%?", "how many hit stoploss?").
// Assumes the app has JSON body parsing (express.json()) enabled globally;
// if it doesn't, add `express.json()` as middleware before this route.
router.post('/chat', async (req, res) => {
    try {
        const { report, range, period, question, history } = req.body || {};

        if (!report && !range) {
            return res.status(400).json({ success: false, message: 'report or range is required — send whichever the dashboard is currently showing' });
        }
        if (range && !period) {
            return res.status(400).json({ success: false, message: 'period is required alongside range (week/month/custom)' });
        }
        if (!question || typeof question !== 'string' || !question.trim()) {
            return res.status(400).json({ success: false, message: 'question is required' });
        }

        const { answer } = await askAboutReport({
            report: report || null,
            range: range || null,
            period: period || null,
            question,
            history: Array.isArray(history) ? history : []
        });

        return res.json({ success: true, answer });
    } catch (err) {
        console.error('[EOD Report Route] Chat failed:', err);
        return res.status(500).json({ success: false, message: err.message || 'Failed to answer question' });
    }
});

// GET /api/eod-report/send-test-email?date=YYYY-MM-DD
// Manually fires the SAME 3:10 PM EOD report email logic, right now,
// for testing. Does not wait for the cron schedule. Uses OMS_CONFIG's
// real trading conditions (target/stoploss/price range/ratio range/
// balance/broker/top N) so the numbers match what the bot would
// actually have traded, not every raw signal.
router.get('/send-test-email', async (req, res) => {
    try {
        // runEodReportEmail() always uses today's date internally, so if a
        // specific date is requested we just call generateEodReport +
        // send directly here instead, applying the same OMS_CONFIG filters.
        const dateStr = req.query.date;
        if (dateStr) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
                return res.status(400).json({ success: false, message: 'date must be in YYYY-MM-DD format' });
            }
            const { alertEodReport } = await import('../services/alert-service.js');
            const report = await buildRealEodReport(dateStr);
            alertEodReport(report);
        } else {
            await runEodReportEmail();
        }
        return res.json({ success: true, message: 'Test EOD report email triggered — check your inbox in a few seconds.' });
    } catch (err) {
        console.error('[EOD Report Route] Failed to send test email:', err);
        return res.status(500).json({ success: false, message: err.message || 'Failed to send test email' });
    }
});

// GET /api/eod-report/capture-history
// Safety net for a missed 3:10 PM auto-capture: builds TODAY's real EOD
// report straight from Shoonya's live PositionBook (same as the 3:10 PM
// cron) and upserts it into `eod_daily_trade_history` right now — no
// email sent. Deliberately always uses TODAY's date, never a `date`
// query param: Shoonya's PositionBook only ever holds today's data, so
// (like the real cron) this can only ever capture today. If a record
// already exists for today it's safely overwritten with the latest
// numbers (saveEodDayRecord upserts by dateStr). Best used late in the
// day, after most/all positions have closed.
router.get('/capture-history', async (req, res) => {
    try {
        const dateStr = getTodayDateStr();
        const report = await buildRealEodReport(dateStr);
        const result = await saveEodDayRecord(report);
        return res.json({ success: true, message: `Captured today's (${dateStr}) history.`, result });
    } catch (err) {
        console.error('[EOD Report Route] Manual history capture failed:', err);
        return res.status(500).json({ success: false, message: err.message || 'Failed to capture history' });
    }
});

// GET /api/eod-report/history?date=YYYY-MM-DD
// Returns the SAVED day-wise record (real closed trades with entry/exit/
// P&L, still-open positions, and summary) for one past date — pulled
// from `eod_daily_trade_history`, NOT from Shoonya (Shoonya only ever
// shows today's PositionBook, so this is the only way to see a day
// after it's over). Returns success:false with a null record if that
// day was never captured (bot wasn't running, market holiday, etc).
router.get('/history', async (req, res) => {
    try {
        const dateStr = req.query.date;
        if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
            return res.status(400).json({ success: false, message: 'date is required, in YYYY-MM-DD format' });
        }
        const record = await getEodHistoryForDate(dateStr);
        return res.json({ success: true, record: record || null });
    } catch (err) {
        console.error('[EOD Report Route] Failed to fetch EOD history:', err);
        return res.status(500).json({ success: false, message: err.message || 'Failed to fetch EOD history' });
    }
});

// GET /api/eod-report/history-range?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
// Same as /history but returns every saved day-wise record in the range,
// oldest first — for a week/month view built from real captured data.
router.get('/history-range', async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
            return res.status(400).json({ success: false, message: 'startDate and endDate are required, in YYYY-MM-DD format' });
        }
        if (startDate > endDate) {
            return res.status(400).json({ success: false, message: 'startDate must be on or before endDate' });
        }
        const records = await getEodHistoryRange(startDate, endDate);
        return res.json({ success: true, records });
    } catch (err) {
        console.error('[EOD Report Route] Failed to fetch EOD history range:', err);
        return res.status(500).json({ success: false, message: err.message || 'Failed to fetch EOD history range' });
    }
});

export default router;