// Shared helpers for the "exit everything" scripts so the DB always ends up
// matching the broker (fixes POSITION MISMATCH after the 3:05 PM exit).

import { accountTradeFilter } from '../config/accounts.js';

const OPEN_STATUSES = ['OPEN', 'ORDER_PLACED', 'PARTIALLY_CLOSED', 'EXITING'];

// Same idea as canonicalSymbol() in fyers-socket.js: broker gives "TCS-EQ",
// DB may hold "TCS" / "NSE:TCS-EQ" — compare on the bare name.
export function canonical(sym) {
    return String(sym ?? '')
        .toUpperCase()
        .replace(/^[A-Z]+:/, '')
        .replace(/-(EQ|BE|BZ|BL|SM)$/, '')
        .trim();
}

// Finds the still-open trade doc for a broker position (any open-like status,
// symbol format tolerant, same direction as the position).
export async function findOpenTradeForPosition(db, collection, position, accountId) {
    const wantSide = position.quantity > 0 ? 'BUY' : 'SELL';
    const candidates = await db.collection(collection)
        .find({ status: { $in: OPEN_STATUSES }, ...accountTradeFilter(accountId) })   // only THIS account's trades
        .toArray();
    const key = canonical(position.symbol);
    const matches = candidates.filter(t => canonical(t.symbol) === key);
    return matches.find(t => t.side === wantSide) ?? matches[0] ?? null;
}

// Marks the trade CLOSED (same fields the sockets write on a normal exit).
export async function markTradeClosed(db, collection, trade, { orderId, exitPrice, reason }) {
    const qty = trade.remainingQuantity ?? trade.quantity ?? 0;
    const pnl = (trade.entryPrice != null && exitPrice != null)
        ? (trade.side === 'BUY' ? exitPrice - trade.entryPrice : trade.entryPrice - exitPrice) * qty
        : null;
    const now = new Date().toISOString();
    await db.collection(collection).updateOne(
        { _id: trade._id },
        {
            $set: {
                status: 'CLOSED',
                exitOrderId: orderId,
                exitPrice: exitPrice ?? null,
                exitReason: reason,
                remainingQuantity: 0,
                ...(pnl != null ? { pnl: parseFloat(pnl.toFixed(2)) } : {}),
                closedAt: now,
                updatedAt: now,
            },
        }
    );
}

// Cleans up trades that are still "open" in the DB after the exit has run
// (e.g. BDL stuck in ORDER_PLACED since 30-10: entry never triggered/was never
// tracked, so nothing ever closed or cancelled it, and it later caused
// POSITION MISMATCH). Call it AFTER the exit step, when the broker is flat.
// Only touches trades whose symbol has NO live broker position.
export async function reconcileStaleTrades(db, collection, broker, positions = [], accountId = broker?.accountId) {
    const livePos = new Set(
        positions.filter(p => p.quantity !== 0).map(p => canonical(p.symbol))
    );
    const stale = await db.collection(collection)
        .find({ status: { $in: ['ORDER_PLACED', 'OPEN', 'PARTIALLY_CLOSED', 'EXITING'] }, ...accountTradeFilter(accountId) })
        .toArray();

    for (const t of stale) {
        try {
            if (livePos.has(canonical(t.symbol))) continue; // still really held — leave it

            let entryStatus = 'UNKNOWN';
            if (t.entryOrderId) {
                entryStatus = (await broker.getOrderStatus(t.entryOrderId))?.status ?? 'UNKNOWN';
                // Entry still live at broker (never triggered) — kill it so it can't fill later.
                if (['OPEN', 'PENDING', 'TRIGGER_PENDING'].includes(entryStatus)) {
                    await broker.cancelOrder(t.entryOrderId);
                    entryStatus = 'CANCELLED';
                }
            }

            const now = new Date().toISOString();
            if (entryStatus === 'COMPLETE') {
                // Entry filled, broker now flat -> it was squared off. Close it.
                await db.collection(collection).updateOne({ _id: t._id }, { $set: {
                    status: 'CLOSED', exitReason: 'RECONCILED_FLAT', remainingQuantity: 0,
                    closedAt: now, updatedAt: now } });
            } else {
                // Never filled (cancelled / rejected / not found) -> cancelled.
                await db.collection(collection).updateOne({ _id: t._id }, { $set: {
                    status: 'CANCELLED', cancelReason: `RECONCILED_${entryStatus}`,
                    remainingQuantity: 0, cancelledAt: now, updatedAt: now } });
            }
            console.log(`[Reconcile] ${t.symbol} (${t._id}) ${t.status} -> ${entryStatus === 'COMPLETE' ? 'CLOSED' : 'CANCELLED'}`);
        } catch (err) {
            console.error(`[Reconcile] ${t.symbol}:`, err.message);
        }
    }
}
