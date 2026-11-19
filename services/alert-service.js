import { sendAlertEmail } from '../utilities/mailer.js';
import { buildAlertEmail, panel, codePanel, dataTable, kvRow } from '../utilities/email-templates.js';
import { logger } from '../utilities/logger.js';
import { connectToDatabase } from '../db/mongodb.js';

// ─────────────────────────────────────────────────────────────────────────
// Every function here is fire-and-forget safe: it NEVER throws. Callers can
// (and should) call these inside a catch block without wrapping them in
// their own try/catch — a failure to send an alert email must never take
// down the actual trading flow.
// ─────────────────────────────────────────────────────────────────────────

function safeSend(promiseFactory, label) {
    Promise.resolve()
        .then(promiseFactory)
        .catch(err => logger.error(`[Alerts] Failed to send "${label}" alert email:`, err.message));
}

function errString(err) {
    if (!err) return 'Unknown error';
    if (typeof err === 'string') return err;
    return err.stack || err.message || JSON.stringify(err);
}

// ─────────────────────────────────────────────────────────────────────────
// Cooldown: even after all retries fail and we send ONE email, if the same
// problem keeps happening on the next cycle (e.g. next login attempt a few
// minutes later), we do NOT want to send another email immediately.
// We remember the last time we emailed about each "key" (e.g. "Shoonya
// login failed") and only allow a new email once COOLDOWN_MS has passed.
// This resets on server restart, which is fine for this use case.
// ─────────────────────────────────────────────────────────────────────────
const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
const lastSentAt = new Map();

function allowedByCooldown(key) {
    const last = lastSentAt.get(key);
    const now = Date.now();
    if (last && (now - last) < COOLDOWN_MS) {
        const minsLeft = Math.ceil((COOLDOWN_MS - (now - last)) / 60000);
        logger.info(`[Alerts] Skipping "${key}" alert — already sent ${Math.round((now - last) / 60000)} min ago. Cooldown ends in ${minsLeft} min.`);
        return false;
    }
    lastSentAt.set(key, now);
    return true;
}

// Persistent once-per-day EOD email guard. This is deliberately stored in
// MongoDB instead of memory so duplicate scheduler triggers are blocked even
// when the bot is running in multiple processes/containers. The _id itself is
// unique, so the insert is an atomic claim. We intentionally claim BEFORE the
// SMTP send: for the EOD report the requirement is at-most-one email, even if
// SMTP returns an ambiguous/network error after accepting the message.
async function claimEodEmail(dateStr) {
    if (!dateStr) return true;

    const db = await connectToDatabase();
    const key = `eod-report:${dateStr}`;

    try {
        await db.collection('email_delivery_dedupe').insertOne({
            _id: key,
            type: 'eod-report',
            dateStr,
            claimedAt: new Date()
        });
        logger.info(`[Alerts] EOD email claim acquired for ${dateStr}.`);
        return true;
    } catch (err) {
        if (err?.code === 11000) {
            logger.warn(`[Alerts] EOD report for ${dateStr} was already claimed — duplicate email blocked.`);
            return false;
        }
        throw err;
    }
}

// ── 1. Login failed (Shoonya / Fyers / Wisdom) ─────────────────────────────
// EMAIL DISABLED (by request): login failures after all retries are almost
// always the broker's own servers being briefly down (e.g. pre-open
// maintenance) — nothing actionable on our end, so this used to just be a
// noisy email. Still logged loudly to the console/log file so it shows up
// if you're actively looking, it's just not emailed anymore.
export function alertLoginFailed(broker, err, extra = {}) {
    logger.error(
        `[Alerts] ${broker} login failed after all retries (email disabled): ${errString(err)}`,
        extra
    );
}

// ── 2. Access token not generated ──────────────────────────────────────────
export function alertAccessTokenFailed(broker, err, extra = {}) {
    if (!allowedByCooldown(`token-failed-${broker}`)) return;
    safeSend(() => sendAlertEmail({
        subject: `🔴 ${broker} Access Token Generation Failed — VGT Trade Bot`,
        html: buildAlertEmail({
            status: 'error',
            badgeLabel: 'Token Failed',
            title: `${broker} Access Token Not Generated`,
            subtitle: `The automated token-refresh step for ${broker} failed. Any API calls relying on this token will fail until it's regenerated.`,
            bodyHtml: [
                panel('Details', [
                    kvRow('Broker', broker),
                    kvRow('Time (IST)', new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })),
                    ...Object.entries(extra).map(([k, v]) => kvRow(k, v))
                ].join('')),
                codePanel('Error', errString(err))
            ].join(''),
            footerNote: 'Action needed: re-run the token refresh script / re-authorize manually.'
        })
    }), `${broker} access token failed`);
}

// ── 3. MongoDB error ────────────────────────────────────────────────────────
export function alertMongoError(context, err) {
    if (!allowedByCooldown(`mongo-error-${context || 'general'}`)) return;
    safeSend(() => sendAlertEmail({
        subject: `🔴 MongoDB Error — VGT Trade Bot`,
        html: buildAlertEmail({
            status: 'error',
            badgeLabel: 'Database Error',
            title: 'MongoDB Connection / Query Error',
            subtitle: `A database operation failed${context ? ` during: ${context}` : ''}. Depending on where this happened, signals, trades, or reports may not have been saved.`,
            bodyHtml: [
                panel('Details', [
                    kvRow('Context', context || 'Not specified'),
                    kvRow('Time (IST)', new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }))
                ].join('')),
                codePanel('Error', errString(err))
            ].join(''),
            footerNote: 'Action needed: check MongoDB Atlas status, connection string, and IP allowlist.'
        })
    }), 'MongoDB error');
}

// ── 4. Wisdom volume surge worker failed ────────────────────────────────────
export function alertWisdomVolumeSurgeFailed(err, extra = {}) {
    if (!allowedByCooldown('wisdom-volume-surge-failed')) return;
    safeSend(() => sendAlertEmail({
        subject: `🔴 Wisdom Volume Surge Worker Failed — VGT Trade Bot`,
        html: buildAlertEmail({
            status: 'error',
            badgeLabel: 'Worker Failed',
            title: 'Wisdom Volume Surge File Did Not Run',
            subtitle: `The 9:15 AM Wisdom volume-surge detection worker did not complete successfully. Today's volume-surge signals may be missing or incomplete.`,
            bodyHtml: [
                panel('Details', [
                    kvRow('Time (IST)', new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })),
                    ...Object.entries(extra).map(([k, v]) => kvRow(k, v))
                ].join('')),
                codePanel('Error', errString(err))
            ].join(''),
            footerNote: 'Action needed: check Wisdom API status and re-run the worker with --date= if needed.'
        })
    }), 'Wisdom volume surge failed');
}

// ── 5. Orders placed digest (send at 9:30 AM IST) ───────────────────────────
/**
 * @param {Array<object>} orders - each: { symbol, signal, entryPrice, quantity, status, orderId, broker, reason }
 */
// Every trade-doc `status` value that means "an entry order genuinely
// went to the broker and is still standing / working" — i.e. NOT
// cancelled, failed, or rejected. Kept as one shared list (instead of
// repeating the PLACED/ORDER_PLACED check in three places, which is how
// this drifted out of sync before) so a status that means "this really
// happened" only ever has to be added here once.
//   PLACED / ORDER_PLACED    — entry order accepted by the broker
//   OPEN                     — cancel-open-orders-worker.js's "already
//                               filled, don't cancel" sync (still a real,
//                               live position)
//   PARTIALLY_CLOSED         — FIRST15's target-1 leg exited, remainder
//                               still open (see fyers-socket.js)
const PLACED_STATUSES = new Set(['PLACED', 'ORDER_PLACED', 'OPEN', 'PARTIALLY_CLOSED']);

function isPlacedStatus(status) {
    return PLACED_STATUSES.has(String(status || '').trim().toUpperCase());
}

export function alertOrdersPlaced(orders = []) {
    const placed = orders.filter(o => isPlacedStatus(o.status));
    const failed = orders.filter(o => !isPlacedStatus(o.status));

    const rows = orders.map(o => ({
        symbol: o.symbol,
        signal: o.signal,
        signalColor: o.signal === 'BUY' ? '#5fd88f' : '#ff8080',
        entryPrice: o.entryPrice != null ? `₹${Number(o.entryPrice).toFixed(2)}` : '-',
        quantity: o.quantity ?? '-',
        broker: o.broker || '-',
        status: (o.status || 'UNKNOWN').toUpperCase(),
        statusColor: isPlacedStatus(o.status) ? '#5fd88f' : '#ff8080',
        orderId: o.orderId || o.reason || '-'
    }));

    // Persistent once-per-day guard. The orders digest must be sent at most
    // once for a trading date, even if the scheduler starts twice, the route
    // triggers it manually, or SMTP reports an ambiguous failure.
    safeSend(async () => {
        const dateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
        const key = `orders-digest:${dateStr}`;

        try {
            const db = await connectToDatabase();
            await db.collection('email_delivery_dedupe').insertOne({
                _id: key,
                type: 'orders-digest',
                dateStr,
                claimedAt: new Date()
            });
            logger.info(`[Alerts] Orders digest claim acquired for ${dateStr}.`);
        } catch (err) {
            if (err?.code === 11000) {
                logger.warn(`[Alerts] Orders digest for ${dateStr} was already claimed — duplicate email blocked.`);
                return;
            }
            throw err;
        }

        return sendAlertEmail({
        subject: orders.length
            ? `📋 Orders Placed Today: ${placed.length}/${orders.length} — 9:30 AM Summary`
            : `📋 No Orders Placed Today — 9:30 AM Summary`,
        html: buildAlertEmail({
            status: failed.length ? 'warning' : 'success',
            badgeLabel: '9:30 AM Orders Summary',
            title: 'Today\u2019s Order Placement Report',
            subtitle: orders.length
                ? `${placed.length} of ${orders.length} signal(s) resulted in a placed order.`
                : 'No signals were processed for order placement today.',
            bodyHtml: [
                panel('Summary', [
                    kvRow('Total signals processed', String(orders.length)),
                    kvRow('Orders placed', String(placed.length), { color: '#5fd88f' }),
                    kvRow('Failed / skipped', String(failed.length), { color: failed.length ? '#ff8080' : undefined })
                ].join('')),
                dataTable('Orders', [
                    { label: 'Symbol', key: 'symbol' },
                    { label: 'Signal', key: 'signal' },
                    { label: 'Entry', key: 'entryPrice', align: 'right' },
                    { label: 'Qty', key: 'quantity', align: 'right' },
                    { label: 'Broker', key: 'broker' },
                    { label: 'Status', key: 'status' },
                    { label: 'Order ID / Reason', key: 'orderId' }
                ], rows, { emptyText: 'No signals were picked up for order placement today.' })
            ].join(''),
            footerNote: 'Sent automatically every trading day at 9:30 AM IST.'
        }),
        // Never retry this digest: if the SMTP server accepted the first
        // message but the client received an ambiguous error, retrying can
        // produce the exact duplicate email this guard is meant to prevent.
        maxAttempts: 1
        });
    }, 'orders placed digest');
}

// ── 6. End of day report (send at 3:10 PM IST) ──────────────────────────────
/**
 * @param {object} report - the object returned by alert-scheduler.js's
 * buildRealEodReport(), built directly from REAL documents in the
 * `trades` collection (real entryPrice/exitPrice/pnl as recorded by the
 * broker websocket) — not a candle-based simulation.
 */
export function alertEodReport(report) {
    const s = report?.summary || {};
    const isProfit = (s.netMoney ?? 0) >= 0;

    // Closed trades — real entryPrice AND real exitPrice, both written
    // straight from the DB.
    const signalRows = [...(report?.successful || []), ...(report?.failedBuy || []), ...(report?.failedSell || [])]
        .map(x => ({
            symbol: x.symbol,
            signal: x.signal,
            signalColor: x.signal === 'BUY' ? '#1e7a42' : '#a32020',
            entry: x.entryPrice != null ? `₹${Number(x.entryPrice).toFixed(2)}` : '-',
            exit: x.exitPrice != null ? `₹${Number(x.exitPrice).toFixed(2)}` : '-',
            profitPercent: x.profitPercent != null ? `${x.profitPercent >= 0 ? '+' : ''}${Number(x.profitPercent).toFixed(2)}%` : '-',
            profitPercentColor: (x.profitPercent ?? 0) >= 0 ? '#1e7a42' : '#a32020'
        }));

    // Still-open positions (order placed, not yet exited when this email
    // ran) — shown separately with a clear reason, instead of a blank
    // dash in the main table.
    const openRows = (report?.stillOpen || []).map(x => ({
        symbol: x.symbol,
        signal: x.signal,
        signalColor: x.signal === 'BUY' ? '#1e7a42' : '#a32020',
        entry: x.entryPrice != null ? `₹${Number(x.entryPrice).toFixed(2)}` : '-',
        status: 'Still open — not exited yet'
    }));

    safeSend(async () => {
        const dateStr = report?.dateStr;
        const claimed = await claimEodEmail(dateStr);
        if (!claimed) return;

        return sendAlertEmail({
        subject: `${isProfit ? '🟢' : '🔴'} EOD Report ${dateStr || ''} — ${isProfit ? '+' : ''}₹${(s.netMoney ?? 0).toFixed?.(2) ?? s.netMoney}`,
        html: buildAlertEmail({
            status: report?.noSignals ? 'info' : (isProfit ? 'success' : 'error'),
            badgeLabel: '3:10 PM End of Day Report',
            title: `End of Day Report — ${report?.dateStr || 'Today'}`,
            subtitle: report?.noSignals
                ? 'No trades were placed today.'
                : `${s.triggeredCount ?? '-'} trade(s) closed. Net P/L: ${isProfit ? '+' : ''}₹${s.netMoney ?? '-'}.`,
            bodyHtml: [
                panel('Summary', [
                    kvRow('Total trades placed', String(s.totalSymbolsProcessed ?? '-')),
                    kvRow('Closed', String(s.triggeredCount ?? '-')),
                    kvRow('Total P/L %', s.totalProfitPercent != null ? `${s.totalProfitPercent}%` : '-'),
                    kvRow('Net P/L (₹)', s.netMoney != null ? `${isProfit ? '+' : ''}₹${s.netMoney}` : '-', { color: isProfit ? '#1e7a42' : '#a32020' })
                ].join('')),
                dataTable('Closed Trades', [
                    { label: 'Symbol', key: 'symbol' },
                    { label: 'Signal', key: 'signal' },
                    { label: 'Entry', key: 'entry', align: 'right' },
                    { label: 'Exit', key: 'exit', align: 'right' },
                    { label: 'P/L %', key: 'profitPercent', align: 'right' }
                ], signalRows, { emptyText: 'No trades closed today.' }),
                ...(openRows.length ? [dataTable('Still Open (not yet exited)', [
                    { label: 'Symbol', key: 'symbol' },
                    { label: 'Signal', key: 'signal' },
                    { label: 'Entry', key: 'entry', align: 'right' },
                    { label: 'Status', key: 'status' }
                ], openRows)] : [])
            ].join(''),
            footerNote: 'Sent automatically every trading day at 3:10 PM IST.'
        }),
        maxAttempts: 1
        });
    }, 'EOD report');
}

// ── 7. Generic catch-all — an order failed to be placed for a reason ───────
//     outside the categories above (crash, unexpected API shape, timeout…)
export function alertOrderNotPlaced(symbol, err, extra = {}) {
    if (!allowedByCooldown(`order-not-placed-${symbol || 'unknown'}`)) return;
    safeSend(() => sendAlertEmail({
        subject: `🔴 Order NOT Placed${symbol ? ` — ${symbol}` : ''} — VGT Trade Bot`,
        html: buildAlertEmail({
            status: 'error',
            badgeLabel: 'Order Not Placed',
            title: `Order Could Not Be Placed${symbol ? ` for ${symbol}` : ''}`,
            subtitle: `An unexpected error prevented this order from being placed. This does not fall under login/token/DB/worker categories — investigate directly.`,
            bodyHtml: [
                panel('Details', [
                    kvRow('Symbol', symbol || 'Not specified'),
                    kvRow('Time (IST)', new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })),
                    ...Object.entries(extra).map(([k, v]) => kvRow(k, v))
                ].join('')),
                codePanel('Error', errString(err))
            ].join(''),
            footerNote: 'Action needed: check worker logs around this time for full context.'
        })
    }), `order not placed${symbol ? ` (${symbol})` : ''}`);
}

// ── 8. Exit order placed at the broker, but the DB write after it failed ───
//     (e.g. Mongo connection timeout right after a real exit executed).
//     This is the dangerous case: money already moved, but our DB doesn't
//     know it yet, so the position needs to be watched until reconciled.
export function alertExitDbSyncFailed(symbol, orderId, err, extra = {}) {
    // No cooldown collapsing across different orderIds — each one is a
    // distinct real-money event that needs its own visibility.
    safeSend(() => sendAlertEmail({
        subject: `🔴 Exit Order Placed But DB Sync Failed — ${symbol} — VGT Trade Bot`,
        html: buildAlertEmail({
            status: 'error',
            badgeLabel: 'DB Sync Failed After Exit',
            title: `Exit Executed at Broker, DB Update Failed — ${symbol}`,
            subtitle: `A real exit order was placed and confirmed by the broker, but the database could not be updated afterward. The bot will keep retrying the DB write in the background WITHOUT placing another broker order. Verify the position manually.`,
            bodyHtml: [
                panel('Details', [
                    kvRow('Symbol', symbol),
                    kvRow('Broker Order ID', orderId || 'Unknown'),
                    kvRow('Time (IST)', new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })),
                    ...Object.entries(extra).map(([k, v]) => kvRow(k, v))
                ].join('')),
                codePanel('Error', errString(err))
            ].join(''),
            footerNote: 'Action needed: check MongoDB connectivity, and confirm the broker position matches what you expect.'
        })
    }), `exit db sync failed (${symbol}/${orderId || 'unknown'})`);
}

// ── 9. Position mismatch — broker's actual position doesn't match what ────
//     our DB thinks it should be. Fired by the periodic position safety
//     check. This is the last line of defense against runaway/duplicate
//     orders from any bug, not just the DB-sync case above.
export function alertPositionMismatch(symbol, brokerQty, expectedQty, autoFlattened, productType) {
    if (!allowedByCooldown(`position-mismatch-${symbol}`)) return;
    safeSend(() => sendAlertEmail({
        subject: `🔴 POSITION MISMATCH — ${symbol} — VGT Trade Bot`,
        html: buildAlertEmail({
            status: 'error',
            badgeLabel: 'Position Mismatch',
            title: `Broker Position Doesn't Match Expected — ${symbol}`,
            subtitle: autoFlattened
                ? `The bot detected a mismatch and automatically placed a correcting order. VERIFY this manually — auto-correction is a safety net, not a substitute for checking.`
                : `The bot detected a mismatch but did NOT auto-correct (alert-only mode). Manual action required.`,
            bodyHtml: [
                panel('Details', [
                    kvRow('Symbol', symbol),
                    kvRow('Broker Net Quantity', brokerQty),
                    kvRow('DB Expected Quantity', expectedQty),
                    // Shown so a future mismatch is diagnosable straight from the
                    // email — this alert now only fires when productType is
                    // confirmed 'I' (intraday), but surfacing it here confirms
                    // that at a glance instead of guessing from the broker terminal.
                    kvRow('Broker Product Type', productType || 'Unknown'),
                    kvRow('Auto-Flattened', autoFlattened ? 'Yes' : 'No'),
                    kvRow('Time (IST)', new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })),
                ].join(''))
            ].join(''),
            footerNote: 'Action needed: log into the broker terminal and confirm the actual position and today\'s order book.'
        })
    }), `position mismatch (${symbol})`);
}

// ── 9b. Exit order was ACCEPTED by the broker, marked CLOSED in the DB, ───
//     but later turned out to have been REJECTED/CANCELED (never actually
//     filled). The bot has automatically fired a corrective MKT exit and
//     reopened the trade in the DB — this is a heads-up, not a call to
//     action, but worth knowing about since it means an exit didn't behave
//     as expected the first time.
export function alertExitOrderRejected(symbol, brokerOrderId, brokerStatus, correctiveAction) {
    if (!allowedByCooldown(`exit-order-rejected-${symbol}`)) return;
    safeSend(() => sendAlertEmail({
        subject: `🟠 Exit Order Rejected After Being Marked Closed — ${symbol} — VGT Trade Bot`,
        html: buildAlertEmail({
            status: 'warning',
            badgeLabel: 'Exit Order Rejected',
            title: `Exit Order Never Filled — ${symbol}`,
            subtitle: `The broker initially accepted this exit order, so the bot marked the trade CLOSED. A follow-up check found the order was actually ${brokerStatus} and never filled. ${correctiveAction}`,
            bodyHtml: [
                panel('Details', [
                    kvRow('Symbol', symbol),
                    kvRow('Broker Order ID', brokerOrderId || 'Unknown'),
                    kvRow('Broker Status', brokerStatus),
                    kvRow('Time (IST)', new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })),
                ].join(''))
            ].join(''),
            footerNote: 'No action needed unless the corrective order above also fails — check the broker terminal if a follow-up POSITION MISMATCH alert arrives.'
        })
    }), `exit order rejected (${symbol})`);
}

// ── 10. Entry order(s) placed at the broker, but the DB write after it ────
//     failed (oms-worker.js). Same category as #8, entry side instead of
//     exit side. The trade is queued locally (pending-trade-sync.js) and
//     retried automatically on the next run — this alert is just visibility.
export function alertEntryDbSyncFailed(symbol, orderIds, err, extra = {}) {
    safeSend(() => sendAlertEmail({
        subject: `🔴 Entry Order Placed But DB Sync Failed — ${symbol} — VGT Trade Bot`,
        html: buildAlertEmail({
            status: 'error',
            badgeLabel: 'DB Sync Failed After Entry',
            title: `Entry Executed at Broker, DB Save Failed — ${symbol}`,
            subtitle: `Real entry order(s) were placed and confirmed by the broker, but saving the trade to the database failed right after. The trade has been queued locally and will be saved automatically once the database is reachable again — no new broker order will be placed for it. Verify the position manually in the meantime.`,
            bodyHtml: [
                panel('Details', [
                    kvRow('Symbol', symbol),
                    kvRow('Broker Order ID(s)', (Array.isArray(orderIds) ? orderIds : [orderIds]).join(', ') || 'Unknown'),
                    kvRow('Time (IST)', new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })),
                    ...Object.entries(extra).map(([k, v]) => kvRow(k, v))
                ].join('')),
                codePanel('Error', errString(err))
            ].join(''),
            footerNote: 'Action needed: check MongoDB connectivity. The next oms-worker run will retry saving this automatically.'
        })
    }), `entry db sync failed (${symbol})`);
}