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

import { findOpenTradeForPosition, markTradeClosed } from './exit-db-sync.js';

import {
    connectToDatabase
} from '../../db/mongodb.js';

// =====================================================================
// PURPOSE
// =====================================================================
// Manual "kill switch" — market-exits EVERY currently open position on
// the target broker, right now. Reads live positions straight from the
// broker (broker.getPositions()), not just the `trades` collection, so
// it also catches positions the DB might have lost track of.
//
// For each open position it:
//   1. looks up the matching 'OPEN' trade doc in Mongo (by symbol),
//   2. if found and it has a live SL order (trade.slBrokerOrderId),
//      cancels that FIRST — otherwise the SL could fire mid-exit and
//      place a second, opposite order on top of this one,
//   3. places a MARKET exit in the opposite direction of the position
//      (SELL to close a long, BUY to close a short),
//   4. marks the trade doc 'CLOSED' (exit order id, price, pnl), so the
//      broker socket (e.g. wisdom-socket.js) can pick up the fill from
//      there exactly like it does for a normal SL/target exit.
//
// This is the same core logic as exit-position-worker.js (which runs
// this on a schedule); this file is the manual, run-it-yourself version
// — same relationship as cancel-all-orders.js vs
// cancel-open-orders-worker.js.
//
// BROKER-AGNOSTIC: works against WHICHEVER broker adapter is passed to
// getBrokerAdapter() — Wisdom, Shoonya, and Angel all already implement
// getPositions() / placeExitMarketOrder() / cancelOrder() with the same
// normalized shape, so nothing here is Wisdom-specific.
//
// TARGETING A SPECIFIC BROKER (e.g. Wisdom, which uses FIRST15.BROKER —
// a SEPARATE setting from the shared OMS_CONFIG.BROKER, so it won't be
// picked up by default): override it via CLI arg or env var, exactly
// like cancel-all-orders.js:
//
//   node src/oms/exit-all-positions.js WISDOM
//   (or)  EXIT_BROKER=WISDOM node src/oms/exit-all-positions.js
//
// With no override, falls back to OMS_CONFIG.BROKER.
//
// SCHEMA ASSUMPTIONS (matches trade-model.js / exit-position-worker.js):
//   trade.status === 'OPEN'   -> position currently held
//   trade.slBrokerOrderId     -> broker order id of the live SL order
// =====================================================================

const TRADE_COLLECTION = 'trades';

// If true, only logs what WOULD be exited — no real orders sent, no DB writes.
const DRY_RUN = OMS_CONFIG.EXIT_ALL_DRY_RUN ?? false;

const BROKER_NAME = (process.argv[2] || process.env.EXIT_BROKER || OMS_CONFIG.BROKER || '').toUpperCase();

async function exitAllOpenPositions(broker, db) {
    const positions = await broker.getPositions();
    const openPositions = positions.filter(p => p.quantity !== 0);

    console.log('[Exit All] Fetched positions:', positions.length, '| open:', openPositions.length);

    if (!openPositions.length) {
        console.log('[Exit All] No open positions to exit.');
        return;
    }

    console.log(`[Exit All] Found ${openPositions.length} open position(s). Exiting all... (DRY_RUN=${DRY_RUN})`);

    for (const position of openPositions) {
        try {
            // Long (netqty > 0) is closed by SELLing; short (netqty < 0) by BUYing.
            const exitSide = position.quantity > 0 ? 'SELL' : 'BUY';
            const exitQty = Math.abs(position.quantity);

            console.log(`  ${position.symbol}: ${exitSide} ${exitQty} @ MARKET (unrealizedPnl: ${position.unrealizedPnl})`);

            if (DRY_RUN) {
                console.log(`    [DRY_RUN] Would exit ${position.symbol}`);
                continue;
            }

            const trade = await findOpenTradeForPosition(db, TRADE_COLLECTION, position, broker.accountId);

            // Cancel the linked SL order first so it can't fire mid-exit
            // and create a duplicate/opposite order.
            if (trade?.slBrokerOrderId) {
                const slCancelled = await broker.cancelOrder(trade.slBrokerOrderId);
                console.log(`    SL order ${trade.slBrokerOrderId} cancel ${slCancelled ? 'succeeded' : 'failed'}`);
            }

            // Wisdom's ALGO accounts reject true Market (price-0) orders —
            // WisdomAdapter.placeExitMarketOrder needs a referencePrice to
            // build a marketable limit order around. Use the position's
            // live LTP, falling back to its average price. Harmless for
            // Shoonya/Angel, whose adapters accept a real Market order and
            // simply ignore this field.
            const referencePrice = position.ltp || position.avgPrice;

            const exitResult = await broker.placeExitMarketOrder({
                symbol: position.symbol,
                side: exitSide,
                quantity: exitQty,
                referencePrice
            });

            if (!exitResult.success) {
                console.error(`    Exit order FAILED for ${position.symbol}: ${exitResult.error}`);
                continue;
            }

            console.log(`    Exit order placed for ${position.symbol}. Order ID: ${exitResult.brokerOrderId}`);

            if (trade) {
                // Close in DB now: nothing else finalizes 'EXITING', which caused POSITION MISMATCH.
                await markTradeClosed(db, TRADE_COLLECTION, trade, {
                    orderId: exitResult.brokerOrderId,
                    exitPrice: position.ltp || position.avgPrice,
                    reason: 'MANUAL_EXIT_ALL',
                });
                console.log(`DB: trade ${trade._id} marked CLOSED`);
            } else {
                console.warn(`    No matching 'OPEN' trade doc found for ${position.symbol} — position exited on broker but not linked to a trade record.`);
            }

        } catch (err) {
            console.error(`  Error exiting position ${position.symbol}:`, err.message);
        }
    }
}

async function main() {
    console.log(`[Exit All] Targeting broker: ${BROKER_NAME}`);
    const db = await connectToDatabase();
    // Shoonya: exit EVERY enabled account at the same time. Other brokers: single account as before.
    const accountIds = BROKER_NAME === 'SHOONYA' ? enabledAccountIds() : ['ACC1'];
    await Promise.allSettled(accountIds.map(async (id) => {
        console.log(`[Exit All][${id}] starting`);
        await exitAllOpenPositions(getBrokerAdapter(BROKER_NAME, id), db);
    }));
    console.log(`Done — all open ${BROKER_NAME} positions exited (${accountIds.join(', ')}).`);
    process.exit(0);
}

main().catch(err => {
    console.error('[Exit All] Fatal error:', err.message);
    process.exit(1);
});
