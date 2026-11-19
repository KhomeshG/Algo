import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../.env') });

import {
    OMS_CONFIG
} from '../config/oms-config.js';

import {
    getBrokerAdapter
} from '../brokers/broker-factory.js';

import { enabledAccountIds } from '../config/accounts.js';

import {
    connectToDatabase
} from '../../db/mongodb.js';

// =====================================================================
// PURPOSE
// =====================================================================
// Cancel every open/pending order (entry orders, SL orders, anything
// not yet filled) — pulled straight from the broker's own order book
// via broker.getOpenOrders(), which each adapter (Wisdom/Shoonya/Angel)
// normalizes into the same plain shape: { brokerOrderId, symbol, status }.
//
// BROKER-AGNOSTIC: whichever broker is set in OMS_CONFIG.BROKER
// ('WISDOM' | 'SHOONYA' | 'ANGEL'/'ANGELONE') is the one this actually
// talks to — there's no per-broker branching here at all. Change
// OMS_CONFIG.BROKER and this script follows automatically.
//
// DB SYNC: after a successful cancel, the trade doc whose entryOrderId
// matches the cancelled broker order id is updated to status:
// 'Cancelled'. If an order was an SL/other leg (no trade has that as
// its entryOrderId), nothing is updated — that's expected, not an error.
// =====================================================================

const TRADE_COLLECTION = 'trades';

// If true, only logs what WOULD be cancelled — no real orders sent, no DB writes.
const DRY_RUN = false;

async function cancelAllOpenOrders(broker, db) {
    const openOrders = await broker.getOpenOrders();
    console.log('[Cancel Orders] Fetched open orders:', openOrders.length);

    if (!openOrders.length) {
        console.log('[Cancel Orders] No open orders to cancel.');
        return;
    }

    console.log(`[Cancel Orders] Found ${openOrders.length} open order(s). Cancelling all... (DRY_RUN=${DRY_RUN})`);

    for (const order of openOrders) {
        const { brokerOrderId: orderId, symbol } = order;

        if (DRY_RUN) {
            console.log(`  [DRY_RUN] Would cancel ${symbol} (${orderId})`);
            continue;
        }

        try {
            const cancelled = await broker.cancelOrder(orderId);

            if (!cancelled) {
                console.error(`  Failed to cancel ${symbol} (${orderId})`);
                continue;
            }

            console.log(`  Cancelled ${symbol} (${orderId})`);

            const updateResult = await db.collection(TRADE_COLLECTION).updateOne(
                { entryOrderId: orderId, status: { $nin: ['CLOSED', 'PARTIALLY_CLOSED'] } }, // FIX: never overwrite a closed trade
                {
                    $set: {
                        status: 'Cancelled',
                        updatedAt: new Date().toISOString()
                    }
                }
            );

            if (updateResult.matchedCount > 0) {
                console.log(`    DB: trade with entryOrderId ${orderId} marked Cancelled`);
            } else {
                console.log(`    DB: no trade found with entryOrderId ${orderId} (likely an SL/other order leg — not an entry)`);
            }
        } catch (err) {
            console.error(`  Error cancelling ${symbol} (${orderId}):`, err.message);
        }
    }
}

async function main() {
    const db = await connectToDatabase();
    // Cancel open orders on EVERY enabled account at the same time (ACC1 only unless OMS_ACCOUNTS is set).
    const accountIds = String(OMS_CONFIG.BROKER).toUpperCase() === 'SHOONYA' ? enabledAccountIds() : ['ACC1'];
    await Promise.allSettled(accountIds.map(async (id) => {
        console.log(`[Cancel Orders][${id}] starting`);
        await cancelAllOpenOrders(getBrokerAdapter(OMS_CONFIG.BROKER, id), db);
    }));
    console.log('Done — all open orders cancelled.');
    process.exit(0);
}

main();