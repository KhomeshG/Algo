import {
    connectToDatabase
} from '../../db/mongodb.js';

import {
    OMS_CONFIG
} from '../config/oms-config.js';

import {
    getBrokerAdapter
} from '../brokers/broker-factory.js';

// =====================================================================
// PURPOSE
// =====================================================================
// This worker looks at trades whose ENTRY order was placed but never
// got filled (or SL-triggered), and cancels them on the broker if
// they've been sitting open too long. Run this on a schedule (e.g.
// every 1-2 min via cron) alongside oms-worker.js.
//
// NOTE ON SCHEMA ASSUMPTIONS:
// I don't have trade-model.js in front of me, so this assumes
// createTrade() sets `status: 'PENDING_ENTRY'` when a trade is created
// and that `entryOrderId` / `createdAt` are stored on the trade doc
// (both are true based on oms-worker.js). Adjust CANCELLABLE_TRADE_STATUSES
// and the field names below if your actual model differs.
// =====================================================================

const TRADE_COLLECTION = 'trades';

// Broker order statuses (from ShoonyaAdapter.getOrderStatus) that mean
// "still live on the exchange, not filled/rejected/cancelled yet".
const OPEN_BROKER_STATUSES = ['OPEN', 'PENDING', 'TRIGGER_PENDING'];

// Only cancel an order once it's been open at least this many minutes.
// Prevents cancelling an order the instant it's placed.
const ORDER_CANCEL_TIMEOUT_MINUTES = OMS_CONFIG.ORDER_CANCEL_TIMEOUT_MINUTES ?? 5;

// Trade statuses that mean "entry order placed, not yet confirmed filled".
// Adjust to match whatever createTrade() actually sets.
const CANCELLABLE_TRADE_STATUSES = OMS_CONFIG.CANCELLABLE_TRADE_STATUSES ?? [
    'PENDING_ENTRY',
    'ENTRY_PLACED'
];

async function main() {

    const db = await connectToDatabase();
    // Each trade is cancelled through the account it was placed on (ACC1 for older trades).
    const brokers = new Map();
    const brokerFor = (t) => {
        const id = t.accountId || 'ACC1';
        if (!brokers.has(id)) brokers.set(id, getBrokerAdapter(OMS_CONFIG.BROKER, id));
        return brokers.get(id);
    };

    try {
        const candidates = await db.collection(TRADE_COLLECTION)
            .find({
                status: { $in: CANCELLABLE_TRADE_STATUSES },
                entryOrderId: { $exists: true, $ne: null }
            })
            .toArray();

        if (!candidates.length) {
            console.log('No open entry orders to check for cancellation.');
            return;
        }

        console.log(`Checking ${candidates.length} open order(s) for cancellation... (timeout=${ORDER_CANCEL_TIMEOUT_MINUTES}m)`);

        for (const trade of candidates) {
            try {
                const broker = brokerFor(trade);
                const ageMinutes = (Date.now() - new Date(trade.createdAt).getTime()) / 60000;

                if (ageMinutes < ORDER_CANCEL_TIMEOUT_MINUTES) {
                    console.log(`  Skip ${trade.symbol} (${trade.entryOrderId}) — only ${ageMinutes.toFixed(1)}m old`);
                    continue;
                }

                const orderStatus = await broker.getOrderStatus(trade.entryOrderId);

                // Filled in the meantime — don't cancel, just sync status
                // so it stops showing up as a cancel candidate.
                if (orderStatus.status === 'COMPLETE') {
                    await db.collection(TRADE_COLLECTION).updateOne(
                        { _id: trade._id },
                        {
                            $set: {
                                status: 'OPEN',
                                entryFilledAt: new Date().toISOString(),
                                entryFillPrice: orderStatus.avgPrice
                            }
                        }
                    );
                    console.log(`  ${trade.symbol}: entry already filled — marked OPEN instead of cancelling.`);
                    continue;
                }

                // Already rejected/cancelled/unknown on broker side — sync, nothing to cancel.
                if (!OPEN_BROKER_STATUSES.includes(orderStatus.status)) {
                    await db.collection(TRADE_COLLECTION).updateOne(
                        { _id: trade._id },
                        {
                            $set: {
                                status: orderStatus.status,
                                updatedAt: new Date().toISOString(),
                                rejectionReason: orderStatus.rejectionReason ?? null
                            }
                        }
                    );
                    console.log(`  ${trade.symbol}: broker status is ${orderStatus.status} — synced, nothing to cancel.`);
                    continue;
                }

                // Still genuinely open on the broker and past the timeout — cancel it.
                const cancelled = await broker.cancelOrder(trade.entryOrderId);

                if (cancelled) {
                    await db.collection(TRADE_COLLECTION).updateOne(
                        { _id: trade._id },
                        {
                            $set: {
                                status: 'CANCELLED',
                                cancelledAt: new Date().toISOString()
                            }
                        }
                    );
                    console.log(`  Cancelled stale order for ${trade.symbol} (${trade.entryOrderId})`);
                } else {
                    console.error(`  Failed to cancel order for ${trade.symbol} (${trade.entryOrderId})`);
                }

            } catch (err) {
                console.error(`  Error processing trade ${trade._id}:`, err.message);
            }
        }

    } finally {
        process.exit(0);
    }
}

main();