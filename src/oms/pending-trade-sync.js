// ─────────────────────────────────────────────────────────────────────────
// PENDING TRADE SYNC — local disk "outbox" for trades that were CONFIRMED
// at the broker but could not be saved to MongoDB (e.g. a connection
// timeout right after the order was placed).
//
// Why this needs to live on disk instead of in memory:
// oms-worker.js is a SHORT-LIVED script — it runs one cycle (via cron /
// Task Scheduler) and then calls process.exit(0). An in-memory retry queue
// (like the one used in fyers-socket.js, which stays alive all day) would
// be wiped out the instant this process exits, silently losing the record
// of a real order that was placed with real money.
//
// So instead: the moment a broker order succeeds but the DB write after it
// fails, we append a record here — plain JSON on disk. Every future run of
// this worker (i.e. the next cron tick) calls reconcilePendingTradeSync()
// FIRST, before doing anything else, and keeps retrying just the DB write
// until it succeeds. The broker is never touched again for these records.
// ─────────────────────────────────────────────────────────────────────────

import fs from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PENDING_SYNC_FILE = resolve(__dirname, '../../data/pending-trade-sync.json');

function readAll() {
    try {
        if (!fs.existsSync(PENDING_SYNC_FILE)) return [];
        const raw = fs.readFileSync(PENDING_SYNC_FILE, 'utf8').trim();
        if (!raw) return [];
        return JSON.parse(raw);
    } catch (err) {
        // A corrupt/partially-written file must NEVER crash the worker or
        // cause us to silently drop what's in it. Log loudly and treat as
        // empty for this run — but the raw file on disk isn't touched, so
        // whatever's actually in it is still there for manual recovery.
        console.error('[PendingSync] Failed to read pending-trade-sync.json — leaving file untouched:', err.message);
        return null; // null = "don't know", caller should NOT overwrite the file
    }
}

function writeAll(records) {
    // Write to a temp file then rename — avoids a half-written file if the
    // process dies mid-write (which is exactly the kind of moment this
    // file exists to protect against).
    const tmpFile = `${PENDING_SYNC_FILE}.tmp`;
    fs.mkdirSync(dirname(PENDING_SYNC_FILE), { recursive: true });
    fs.writeFileSync(tmpFile, JSON.stringify(records, null, 2), 'utf8');
    fs.renameSync(tmpFile, PENDING_SYNC_FILE);
}

/**
 * Record a trade (or several, for FIRST15's legs) whose broker order(s)
 * already succeeded but whose DB write just failed. Safe to call multiple
 * times for the same signal — dedupes by signal._id.
 */
export function appendPendingTradeSync({ signalId, sourceCollection, trades, reason }) {
    const existing = readAll();
    if (existing === null) {
        console.error(
            `[PendingSync] ⚠️ Could not append record for signal ${signalId} — ` +
            `existing file unreadable. MANUAL RECOVERY NEEDED for broker order(s): ` +
            trades.map(t => t.entryOrderId).join(', ')
        );
        return;
    }

    const signalIdStr = String(signalId);
    if (existing.some(r => r.signalId === signalIdStr)) {
        console.warn(`[PendingSync] Signal ${signalIdStr} already queued — skipping duplicate append.`);
        return;
    }

    existing.push({
        signalId: signalIdStr,
        sourceCollection,
        trades,
        reason,
        firstFailedAt: new Date().toISOString(),
        attempts: 0,
    });

    writeAll(existing);
    console.error(
        `[PendingSync] Queued signal ${signalIdStr} for background DB reconciliation ` +
        `(broker order(s) already placed: ${trades.map(t => t.entryOrderId).join(', ')})`
    );
}

/** All signal._id values currently stuck waiting on a DB write. */
export function getPendingSignalIds() {
    const existing = readAll();
    if (existing === null) return new Set(); // fail open on read error — don't block new signals over a corrupt file
    return new Set(existing.map(r => r.signalId));
}

/**
 * Try to flush every pending record into MongoDB. NEVER places another
 * broker order — only retries the DB write. Called at the start of every
 * oms-worker.js run, so a stuck record gets retried on every future cron
 * tick until MongoDB is reachable again.
 */
export async function reconcilePendingTradeSync(db, { onReconciled } = {}) {
    const existing = readAll();
    if (existing === null || existing.length === 0) return;

    console.log(`[PendingSync] ${existing.length} trade(s) waiting on DB reconciliation — retrying now…`);

    const stillPending = [];

    for (const record of existing) {
        try {
            await db.collection('trades').insertMany(record.trades);
            await db.collection(record.sourceCollection).updateOne(
                { _id: await toObjectIdIfPossible(record.signalId) },
                { $set: { processed: true, reconciledAt: new Date().toISOString() } }
            );

            console.log(
                `[PendingSync] ✅ Reconciled signal ${record.signalId} — ` +
                `${record.trades.length} trade(s) saved, orderId(s): ${record.trades.map(t => t.entryOrderId).join(', ')}`
            );

            if (onReconciled) {
                try { await onReconciled(record); } catch (_) { /* non-fatal */ }
            }

        } catch (err) {
            record.attempts = (record.attempts ?? 0) + 1;
            console.warn(
                `[PendingSync] Still failing for signal ${record.signalId} ` +
                `(attempt ${record.attempts}):`, err.message
            );
            stillPending.push(record);
        }
    }

    writeAll(stillPending);

    if (stillPending.length) {
        console.warn(`[PendingSync] ${stillPending.length} trade(s) still waiting — will retry next run.`);
    }
}

// MongoDB _id values are ObjectIds, but this file only ever stores/reads
// their string form (round-tripping through JSON) — convert back before
// using one in a query. Falls back to the raw string if it's not a valid
// ObjectId shape, so a signal doc using a non-ObjectId _id still works.
// (Dynamic import, not a static one, so this file doesn't force every
// caller to pull in the mongodb driver just to append a record.)
async function toObjectIdIfPossible(idStr) {
    try {
        const { ObjectId } = await import('mongodb');
        return ObjectId.isValid(idStr) ? new ObjectId(idStr) : idStr;
    } catch (_) {
        return idStr;
    }
}