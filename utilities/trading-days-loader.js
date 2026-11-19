/**
 * Trading Days Loader
 *
 * Computes NSE trading dates algorithmically: every calendar date EXCEPT
 * Saturdays, Sundays, and known NSE market holidays (see NSE_HOLIDAYS_BY_YEAR
 * below). This replaces the old approach of reading a one-time CSV export
 * (data/nse-trading-days.csv) as an "allow-list" of dates — that CSV was
 * exported for a fixed window (2023 -> 2026-08-31), so any range that
 * extended past its last row (e.g. September 2026 onward) silently came
 * back with ZERO trading days, even though real trading data existed for
 * those dates.
 *
 * The CSV is kept in the repo purely as a RESERVE / cross-check data
 * source — see `getTradingDaysInRangeFromCsv()` — but it is no longer used
 * by default by `getTradingDaysInRange()` / `getAllTradingDays()`.
 *
 * To extend into a new year, add that year's NSE holiday list to
 * NSE_HOLIDAYS_BY_YEAR below (source: NSE's published market holiday
 * calendar). Weekends never need to be listed — they're excluded
 * automatically.
 */

import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSV_PATH = join(__dirname, '../data/nse-trading-days.csv');

// ── NSE market holidays (Capital Market / Equity segment), by year ─────────
// Add a new `<year>: [ ... ]` entry whenever NSE publishes next year's
// calendar. Any year not listed here is treated as "weekends only" —
// i.e. every Mon-Fri is assumed to be a trading day for that year.
const NSE_HOLIDAYS_BY_YEAR = {
    2026: [
        '2026-01-26', // Republic Day
        '2026-03-03', // Holi
        '2026-03-26', // Ram Navami
        '2026-03-31', // Shri Mahavir Jayanti
        '2026-04-03', // Good Friday
        '2026-04-14', // Dr. Baba Saheb Ambedkar Jayanti
        '2026-05-01', // Maharashtra Day
        '2026-05-28', // Bakri Id
        '2026-06-26', // Muharram
        '2026-09-14', // Ganesh Chaturthi
        '2026-10-02', // Mahatma Gandhi Jayanti
        '2026-10-20', // Dussehra
        '2026-11-10', // Diwali Balipratipada
        '2026-11-24', // Prakash Gurpurb Sri Guru Nanak Dev
        '2026-12-25', // Christmas
    ],
};

const NSE_HOLIDAY_SET = new Set(Object.values(NSE_HOLIDAYS_BY_YEAR).flat());

function pad2(n) {
    return String(n).padStart(2, '0');
}

function toDateStr(d) {
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * Generates every trading date in [fromDate, toDate] inclusive by walking
 * calendar days and excluding Saturdays, Sundays, and known holidays.
 * @param {string} fromDate YYYY-MM-DD
 * @param {string} toDate   YYYY-MM-DD
 * @returns {string[]} ascending YYYY-MM-DD
 */
function computeTradingDays(fromDate, toDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
        throw new Error('[Trading Days] fromDate/toDate must be YYYY-MM-DD');
    }

    const out = [];
    const cursor = new Date(`${fromDate}T00:00:00.000Z`);
    const end = new Date(`${toDate}T00:00:00.000Z`);

    while (cursor <= end) {
        const dow = cursor.getUTCDay(); // 0 = Sunday, 6 = Saturday
        const dateStr = toDateStr(cursor);
        if (dow !== 0 && dow !== 6 && !NSE_HOLIDAY_SET.has(dateStr)) {
            out.push(dateStr);
        }
        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    return out;
}

// Fixed epoch start used when callers ask for "all" trading days without a range.
const EPOCH_START = '2000-01-01';

/** Trading dates within [fromDate, toDate] inclusive (weekends + holidays excluded), both YYYY-MM-DD. */
export function getTradingDaysInRange(fromDate, toDate) {
    return computeTradingDays(fromDate, toDate);
}

/** All trading dates from a fixed epoch start through today. Mainly used to find "the last N trading days". */
export function getAllTradingDays() {
    const today = toDateStr(new Date());
    return computeTradingDays(EPOCH_START, today);
}

/** First and last computed trading date (epoch start through today). */
export function getTradingDaysBounds() {
    const all = getAllTradingDays();
    return { first: all[0], last: all[all.length - 1] };
}

/**
 * True if `dateStr` (YYYY-MM-DD) is a trading day — i.e. NOT a Saturday,
 * NOT a Sunday, and NOT a listed NSE holiday.
 *
 * Every live/backfill worker that produces or consumes intraday signals
 * (9:15 AM volume-surge screeners, ORB workers, EOD reports, dashboard
 * refresh jobs, etc.) MUST call this before doing any work for a given
 * date. Without this guard a worker that fires on a Saturday/Sunday (via
 * cron, a manual `--date=` backfill, or a stale scheduler) will either:
 *   - find no fresh broker data and silently reuse/duplicate the last
 *     real trading day's candle for every symbol (producing suspiciously
 *     identical ratios/values across the whole result set), or
 *   - write a bogus "0 signals" / zeroed-out row that looks like real
 *     market data.
 * @param {string} dateStr YYYY-MM-DD
 * @returns {boolean}
 */
export function isTradingDay(dateStr) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        throw new Error('[Trading Days] isTradingDay expects YYYY-MM-DD');
    }

    const dow = new Date(`${dateStr}T00:00:00.000Z`).getUTCDay(); // 0 = Sun, 6 = Sat

    if (dow === 0 || dow === 6) return false;

    return !NSE_HOLIDAY_SET.has(dateStr);
}

/**
 * Compares a set of dates you actually have (e.g. candle.time values
 * sliced to YYYY-MM-DD) against the expected trading days in a range,
 * and returns which expected dates are missing.
 * @param {string[]} haveDates - dates you already have, any format containing YYYY-MM-DD at the start
 * @param {string} fromDate
 * @param {string} toDate
 */
export function findMissingTradingDays(haveDates, fromDate, toDate) {
    const expected = getTradingDaysInRange(fromDate, toDate);
    const haveSet = new Set(haveDates.map(d => String(d).slice(0, 10)));
    return expected.filter(d => !haveSet.has(d));
}

// ── Reserve / cross-check source ────────────────────────────────────────
// The original CSV export (data/nse-trading-days.csv, 2023 -> 2026-08-31)
// is kept as a fallback data source — e.g. for sanity-checking the computed
// list against NSE's own historical export, or if you need the exact
// original rows for dates it actually covers. NOT used by default.
let _csvDates = null;

function loadCsvDates() {
    if (_csvDates) return _csvDates;
    if (!existsSync(CSV_PATH)) return (_csvDates = []);

    const raw = readFileSync(CSV_PATH, 'utf-8').replace(/^\uFEFF/, '');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const header = lines[0].split(',');
    const dateIdx = header.indexOf('date');
    if (dateIdx === -1) return (_csvDates = []);

    _csvDates = lines
        .slice(1)
        .map(line => line.split(',')[dateIdx])
        .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort();

    return _csvDates;
}

/** Reserve/fallback: trading dates within [fromDate, toDate] as recorded in the original CSV export (only covers up to 2026-08-31). */
export function getTradingDaysInRangeFromCsv(fromDate, toDate) {
    return loadCsvDates().filter(d => d >= fromDate && d <= toDate);
}

export default {
    getAllTradingDays,
    getTradingDaysInRange,
    getTradingDaysBounds,
    isTradingDay,
    findMissingTradingDays,
    getTradingDaysInRangeFromCsv,
};