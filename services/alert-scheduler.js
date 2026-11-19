import cron from 'node-cron';
import { connectToDatabase } from '../db/mongodb.js';
import { alertOrdersPlaced, alertEodReport, alertMongoError } from './alert-service.js';
import { logger } from '../utilities/logger.js';
import { ShoonyaAdapter } from '../src/brokers/shoonya-adapter.js';
import { saveEodDayRecord } from './eod-history-service.js';
import { OMS_CONFIG } from '../src/config/oms-config.js';

const TRADE_COLLECTION = 'trades';

function getTodayIST() {
    // en-CA gives YYYY-MM-DD directly.
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

// Shoonya's own tsym always carries a "-EQ" suffix (e.g. "HINDALCO-EQ"),
// but our local `trades` collection stores the plain symbol we were given
// the signal for (e.g. "HINDALCO" — see signal.symbol in oms-worker.js /
// trade-model.js, and getShoonyaSymbol() in symbol-mapper.js which only
// appends "-EQ" at the moment of placing the broker order). Comparing the
// two directly without stripping the suffix means the lookup below NEVER
// matches, silently falling back to PositionBook's own side guess — which
// is wrong for every closed trade (buyQty === sellQty once a position is
// closed, so `buyQty >= sellQty` always resolves to 'BUY').
function normalizeSymbol(symbol) {
    return (symbol || '').toUpperCase().replace(/-EQ$/, '');
}

/**
 * #6 — 9:30 AM IST: pull every trade created today from the `trades`
 * collection (populated by oms-worker.js) and email a summary of what
 * did/didn't get placed.
 */
async function runOrdersPlacedDigest() {
    logger.info('[Alert Scheduler] Running 9:30 AM orders-placed digest...');
    try {
        const db = await connectToDatabase();
        const todayStr = getTodayIST();
        const startOfDayIST = new Date(`${todayStr}T00:00:00+05:30`).toISOString();

        const trades = await db.collection(TRADE_COLLECTION)
            .find({ createdAt: { $gte: startOfDayIST } })
            .sort({ createdAt: 1 })
            .toArray();

        const orders = trades.map(t => ({
            symbol: t.symbol,
            // FIX: trade docs store the direction as `side` (see
            // trade-model.js createTrade()) — there is no `signal` or
            // `action` field on a trade doc, so the old `t.signal ||
            // t.action` always evaluated to undefined and rendered as "-".
            signal: t.side,
            entryPrice: t.entryPrice,
            quantity: t.quantity,
            // FIX: older trade docs (created before broker.js started
            // stamping it) won't have `t.broker` — fall back to deriving
            // it from patternSource the same way the rest of the system
            // does, so the column never silently shows "-" for a trade
            // that really did go through a known broker.
            broker: t.broker || (t.patternSource === 'FIRST15_ORB'
                ? (OMS_CONFIG.FIRST15?.BROKER ?? OMS_CONFIG.BROKER)
                : OMS_CONFIG.BROKER),
            status: t.status || (t.entryOrderId ? 'PLACED' : 'FAILED'),
            orderId: t.entryOrderId || t.orderId,
            reason: t.error || t.processingError
        }));

        alertOrdersPlaced(orders);
    } catch (err) {
        logger.error('[Alert Scheduler] Orders-placed digest failed:', err.message);
        alertMongoError('9:30 AM orders-placed digest', err);
    }
}

/**
 * Builds the EOD report from Shoonya's OWN broker records — its
 * PositionBook — rather than from the local `trades` collection's
 * `status` field.
 *
 * WHY THE CHANGE: the old version trusted `trades.status === 'CLOSED'`,
 * which is only ever set by our own live-tick websocket listener
 * (src/websocket/shoonya-socket.js) when IT detects a target/SL hit.
 * If that socket drops, restarts, or the position gets squared off by
 * Shoonya itself (or manually) without our listener catching the tick,
 * the local record is stuck "open" forever — even though the position
 * is genuinely closed at the broker. That's why the report kept showing
 * "0 closed" while positions sat as "still open — not exited yet".
 *
 * PositionBook is the broker's own ledger for the day: `netqty === 0`
 * means that symbol is truly flat (closed) for the day, and `rpnl` is
 * Shoonya's own realized P&L for it — no re-derivation needed. This is
 * ground truth regardless of what our own process did or didn't see.
 *
 * The local `trades` collection is only used as a lightweight lookup
 * for anything PositionBook doesn't carry (e.g. our internal exitReason
 * label) — never as the source of truth for open/closed status.
 */
async function buildRealEodReport(dateStr) {
    const db = await connectToDatabase();
    const startOfDayIST = new Date(`${dateStr}T00:00:00+05:30`).toISOString();
    const endOfDayIST = new Date(`${dateStr}T23:59:59+05:30`).toISOString();

    const localTrades = await db.collection(TRADE_COLLECTION)
        .find({ createdAt: { $gte: startOfDayIST, $lte: endOfDayIST } })
        .sort({ createdAt: 1 })
        .toArray();
    const exitReasonBySymbol = new Map(localTrades.map(t => [normalizeSymbol(t.symbol), t.exitReason]));
    // Ground truth for which direction we actually traded: our own
    // `trades` doc's `side` field, set at order-placement time from the
    // real signal (see src/models/trade-model.js). Kept separate from
    // exitReasonBySymbol just for clarity of intent.
    const sideBySymbol = new Map(localTrades.map(t => [normalizeSymbol(t.symbol), t.side]));

    const shoonya = new ShoonyaAdapter();
    const { closed, open } = await shoonya.getRealDayPositions();

    const priced = closed.map(t => {
        // PositionBook's own side guess (shoonya-adapter.js) compares
        // daybuyqty vs daysellqty — but for a CLOSED position both legs
        // filled the SAME quantity, so that comparison is a tie and
        // silently defaults to 'BUY' every time, regardless of which
        // side we actually opened with. Our local trade record knows
        // the real originating side (it's what we told the broker to
        // do), so it always wins when we have it; the broker guess is
        // only a last-resort fallback for a symbol with no local record
        // (e.g. a manual trade placed outside the bot).
        // t.side no longer comes from the adapter for closed positions
        // (it can't reliably tell BUY from SELL once a position is flat —
        // see shoonya-adapter.js). Our local trade record's `side` is the
        // real originating direction; fall back to 'BUY' only if we have
        // no local record at all (e.g. a manual trade placed outside the
        // bot), matching the adapter's old default.
        const side = sideBySymbol.get(normalizeSymbol(t.symbol)) || 'BUY';

        // entryPrice/exitPrice depend on the REAL side, not a guess: for a
        // BUY we entered on the buy leg and exited on the sell leg; for a
        // SELL (short) we entered on the sell leg and exited on the buy
        // leg. Using the wrong leg for either price silently inverts the
        // P/L % (this was the bug that made the EOD email show a loss %
        // for trades Shoonya's own rpnl reported as a profit).
        const entryPrice = side === 'BUY' ? t.buyAvgPrice : t.sellAvgPrice;
        const exitPrice = side === 'BUY' ? t.sellAvgPrice : t.buyAvgPrice;

        const profitPercent = entryPrice
            ? Number((side === 'BUY'
                ? ((exitPrice - entryPrice) / entryPrice) * 100
                : ((entryPrice - exitPrice) / entryPrice) * 100
            ).toFixed(2))
            : null;
        return {
            symbol: t.symbol,
            signal: side,
            entryPrice,
            exitPrice,
            exitReason: exitReasonBySymbol.get(normalizeSymbol(t.symbol)) || null,
            profitPercent,
            pnl: t.pnl // Shoonya's own realized P&L (rpnl) — broker-accurate
        };
    });

    const successful = priced.filter(t => (t.profitPercent ?? 0) >= 0);
    const failedBuy = priced.filter(t => (t.profitPercent ?? 0) < 0 && t.signal === 'BUY');
    const failedSell = priced.filter(t => (t.profitPercent ?? 0) < 0 && t.signal === 'SELL');

    const netMoney = closed.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const totalProfitPercent = priced.reduce((sum, t) => sum + (t.profitPercent || 0), 0);

    const totalSymbolsProcessed = closed.length + open.length;

    return {
        dateStr,
        noSignals: totalSymbolsProcessed === 0,
        successful,
        failedBuy,
        failedSell,
        stillOpen: open.map(t => ({ symbol: t.symbol, signal: t.side, entryPrice: t.entryPrice })),
        summary: {
            totalSymbolsProcessed,
            triggeredCount: closed.length,
            totalProfitPercent: Number(totalProfitPercent.toFixed(2)),
            netMoney: Number(netMoney.toFixed(2))
        }
    };
}

/**
 * #7 — 3:30 PM IST: build today's EOD report from REAL trade records
 * (see buildRealEodReport above) and email it.
 */
async function runEodReportEmail() {
    logger.info('[Alert Scheduler] Running 3:30 PM EOD report email...');
    try {
        const todayStr = getTodayIST();
        const report = await buildRealEodReport(todayStr);

        // Save today's real closed/open trades (with entry, exit, P&L)
        // into the day-wise history collection BEFORE sending the email —
        // Shoonya's PositionBook only shows today's data, so this is the
        // only place this information is ever persisted for later lookup
        // (e.g. "show me yesterday's summary"). See eod-history-service.js.
        try {
            await saveEodDayRecord(report);
        } catch (historyErr) {
            // Never let a history-save failure block today's email — log
            // and continue so the trader still gets notified either way.
            logger.error('[Alert Scheduler] Failed to save EOD day record:', historyErr.message);
        }

        alertEodReport(report);
    } catch (err) {
        logger.error('[Alert Scheduler] EOD report email failed:', err.message);
        alertMongoError('3:30 PM EOD report generation', err);
    }
}

/**
 * Registers both cron jobs. Call once at server startup.
 * Times are IST regardless of the server's own timezone (timezone option
 * below), and only fire Mon–Fri (weekday trading days).
 */
let alertSchedulerStarted = false;

export function startAlertScheduler() {
    if (alertSchedulerStarted) {
        logger.warn('[Alert Scheduler] startAlertScheduler() called more than once — duplicate cron registration blocked.');
        return;
    }
    alertSchedulerStarted = true;
    // 9:30 AM IST, Mon-Fri — moved from 9:15 AM so it fires AFTER
    // oms-worker.js has actually had time to place the day's orders
    // (signals only get confirmed/placed a few minutes after market
    // open), instead of firing before any trades exist.
    cron.schedule('30 9 * * 1-5', runOrdersPlacedDigest, { timezone: 'Asia/Kolkata' });

    // 3:30 PM IST, Mon-Fri — was wrongly set to 11:30 AM (late morning,
    // well before the trading day / exits are done); corrected to the
    // intended afternoon slot.
    cron.schedule('30 15 * * 1-5', runEodReportEmail, { timezone: 'Asia/Kolkata' });

    logger.info('[Alert Scheduler] Registered: orders digest @ 9:30 AM IST, EOD report @ 3:30 PM IST (Mon-Fri).');
}

// Exported for manual testing/triggering, e.g. from a debug route.
export { runOrdersPlacedDigest, runEodReportEmail, buildRealEodReport };