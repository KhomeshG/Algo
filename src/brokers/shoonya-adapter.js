import {
    placeShoonyaOrder,
    cancelShoonyaOrder,
    modifyShoonyaOrder,
    getShoonyaOrderBook,
    getShoonyaPositions,
    getShoonyaTradeBook,
    searchShoonyaScrip,
    getShoonyaQuote
} from '../../services/shoonya-api-login-service.js';
import { logger } from '../../utilities/logger.js';

/**
 * Derive Shoonya trading symbol.
 * NSE equity symbols need the "-EQ" suffix unless they are indices.
 */
function getShoonyaTradingSymbol(symbol, exchange = 'NSE') {
    const cleanSymbol = symbol.toUpperCase();
    if (exchange.toUpperCase() === 'NSE' && !cleanSymbol.endsWith('-EQ')) {
        if (cleanSymbol === 'NIFTY' || cleanSymbol === 'BANKNIFTY') {
            return cleanSymbol;
        }
        return `${cleanSymbol}-EQ`;
    }
    return cleanSymbol;
}

// Normalized statuses considered "still open" — used by getOpenOrders()
// (matches the vocabulary in wisdom-adapter.js / angel-adapter.js).
const OPEN_ORDER_STATUSES = ['OPEN', 'PENDING', 'TRIGGER_PENDING'];

// How far beyond the reference LTP an exit's limit price is pushed to make
// it marketable (see placeExitMarketOrder below). 0.5% is enough headroom
// to clear the spread/next few ticks on the liquid NSE cash names this bot
// trades without being large enough to meaningfully worsen the fill price.
const EXIT_MARKETABLE_LIMIT_BUFFER_PERCENT = 0.5;

// NSE cash equity tick size (₹0.05) — the only segment this adapter's
// exits trade today, matching the flat-0.05 convention documented in
// src/brokers/wisdom-adapter.js's getTickSize() for NSECM/BSECM.
const NSE_CASH_TICK_SIZE = 0.05;

function roundToTickSize(price, tickSize = NSE_CASH_TICK_SIZE) {
    // toFixed(2) guards against float artifacts like 1735.4999999999998
    // from the division/multiplication (NSE cash ticks never need more
    // than 2 decimal places).
    return Number((Math.round(price / tickSize) * tickSize).toFixed(2));
}

export class ShoonyaAdapter {

    /**
     * @param {string} [accountId] 'ACC1' (default, your existing account) | 'ACC2' | 'ACC3'.
     *   Every broker call this adapter makes goes through THAT account's own session/credentials.
     */
    constructor(accountId) {
        this.accountId = accountId || 'ACC1';
    }

    // ─── Entry Order ──────────────────────────────────────────────────────────

    /**
     * Place the initial entry order (LIMIT or MARKET).
     */
    async placeEntryOrder({
        symbol,
        side,
        quantity,
        price,
        exchange = 'NSE',
        productType = 'I'
    }) {
        logger.info(`[Shoonya] Entry Order: ${side} ${quantity} ${symbol} @ ${price ?? 'MARKET'}`);

        try {
            const tsym = getShoonyaTradingSymbol(symbol, exchange);
            const trantype = side.toUpperCase() === 'BUY' ? 'B' : 'S';
            const prctyp = price ? 'SL-LMT' : 'MKT';

            const payload = {
                exch: exchange.toUpperCase(),
                tsym,
                qty: quantity.toString(),
                trgprc: price ? price.toString() : '0',
                prc: price ? price.toString() : '0',
                trgprc: price ? price.toString() : '0',
                trantype,
                prd: productType.toUpperCase(),
                prctyp,
                ret: 'DAY',
                ordersource: 'API',
            };

            const result = await placeShoonyaOrder(payload, this.accountId);

            if (result?.stat === 'Ok') {
                logger.info(`[Shoonya] Entry placed. Order ID: ${result.norenordno}`);
                return { success: true, brokerOrderId: result.norenordno };
            }

            logger.error(`[Shoonya] Entry failed: ${result?.emsg ?? 'Unknown'}`);
            return { success: false, error: result?.emsg ?? 'Order placement failed' };

        } catch (error) {
            logger.error('[Shoonya] placeEntryOrder exception:', error.message);
            return { success: false, error: error.message };
        }
    }

    // ─── Exit Market Order ────────────────────────────────────────────────────

    /**
     * Place a MARKET exit order on Shoonya.
     * Called by angel-socket when TARGET_HIT or SL_HIT is detected from the
     * Angel One price feed.
     *
     * @param {object} params
     * @param {string} params.symbol
     * @param {string} params.side       - 'BUY' or 'SELL' (opposite of entry)
     * @param {number} params.quantity
     * @param {string} [params.exchange]
     * @param {string} [params.productType]
     * @returns {{ success: boolean, brokerOrderId?: string, error?: string }}
     */
    async placeExitMarketOrder({
        symbol,
        side,
        quantity,
        price,
        exchange = 'NSE',
        productType = 'I'
    }) {
        logger.info(`[Shoonya] Exit Market Order: ${side} ${quantity} ${symbol}`);

        try {
            const tsym = getShoonyaTradingSymbol(symbol, exchange);
            const trantype = side.toUpperCase() === 'BUY' ? 'B' : 'S';

            // BUG THIS FIXES: prctyp:'MKT' is rejected outright by Shoonya's
            // API-order compliance layer — "ALGO_CHK: MKT Order type not
            // allowed for API order". This is a SEBI algo-trading rule
            // enforced on the exchange/broker side, not something this app
            // can opt out of: orders placed through the API (as opposed to
            // manually in the terminal) must carry an explicit limit price,
            // so a bare MKT type is always refused, on every symbol, every
            // time. That means every exit this branch tried to place failed
            // immediately and kept retrying (see the earlier session's
            // "always send true MKT" fix above — sound reasoning about
            // fill-guarantee, but MKT itself isn't a legal order type here).
            //
            // Fix: send a *marketable* LIMIT order instead — prctyp:'LMT'
            // with the limit price pushed a small buffer beyond the last
            // traded price in the direction that guarantees an immediate
            // match against the opposite book (pay up to buy, accept less
            // to sell). This keeps the "must fill now" guarantee the prior
            // fix was protecting, while staying a legal API order type.
            if (!(price > 0)) {
                // No reference price to build a marketable limit off of —
                // placing prc:'0' would either be rejected the same way or
                // (worse) go through as an unpriced/unintended order.
                // Fail loudly so the caller's existing retry/alert path
                // handles it, instead of guessing a price.
                logger.error(`[Shoonya] Exit failed: no reference price provided for ${symbol} — cannot build marketable limit order`);
                return { success: false, error: 'Exit requires a reference price to compute a marketable limit' };
            }

            const limitPrice = roundToTickSize(
                trantype === 'B'
                    ? price * (1 + EXIT_MARKETABLE_LIMIT_BUFFER_PERCENT / 100)
                    : price * (1 - EXIT_MARKETABLE_LIMIT_BUFFER_PERCENT / 100)
            );

            const prctyp = 'LMT';
            const payload = {
                exch: exchange.toUpperCase(),
                tsym,
                qty: quantity.toString(),
                prc: limitPrice.toString(),
                trgprc: '0',
                trantype,
                prd: productType.toUpperCase(),
                prctyp,
                ret: 'DAY',
                ordersource: 'API',
            };

            const result = await placeShoonyaOrder(payload, this.accountId);

            if (result?.stat === 'Ok') {
                logger.info(`[Shoonya] Exit placed. Order ID: ${result.norenordno} (marketable LMT @ ${limitPrice})`);
                return { success: true, brokerOrderId: result.norenordno };
            }

            logger.error(`[Shoonya] Exit failed: ${result?.emsg ?? 'Unknown'}`);
            return { success: false, error: result?.emsg ?? 'Exit order failed' };

        } catch (error) {
            logger.error('[Shoonya] placeExitMarketOrder exception:', error.message);
            return { success: false, error: error.message };
        }
    }

    // ─── SL-LMT Order ─────────────────────────────────────────────────────────

    /**
     * Place a stop-loss limit order on the broker.
     * Store the returned brokerOrderId as trade.slBrokerOrderId so
     * trailing SL can modify it later.
     *
     * @param {object} params
     * @param {string} params.symbol
     * @param {string} params.side          - exit direction ('SELL' for BUY trade)
     * @param {number} params.quantity
     * @param {number} params.triggerPrice  - price that activates the SL
     * @param {number} params.price         - limit price (slightly below trigger for BUY)
     * @param {string} [params.exchange]
     * @param {string} [params.productType]
     * @returns {{ success: boolean, brokerOrderId?: string, error?: string }}
     */
    async placeSLOrder({
        symbol,
        side,
        quantity,
        price,
        triggerPrice,
        exchange = 'NSE',
        productType = 'I'
    }) {
        logger.info(`[Shoonya] SL Order: ${side} ${quantity} ${symbol} trigger:${triggerPrice} limit:${price}`);

        try {
            const tsym = getShoonyaTradingSymbol(symbol, exchange);
            const trantype = side.toUpperCase() === 'BUY' ? 'B' : 'S';

            const payload = {
                exch: exchange.toUpperCase(),
                tsym,
                qty: quantity.toString(),
                prc: price.toString(),
                trgprc: triggerPrice.toString(),
                trantype,
                prd: productType.toUpperCase(),
                prctyp: 'SL-LMT',
                ret: 'DAY',
                ordersource: 'API',
            };

            const result = await placeShoonyaOrder(payload, this.accountId);

            if (result?.stat === 'Ok') {
                logger.info(`[Shoonya] SL order placed. Order ID: ${result.norenordno}`);
                return { success: true, brokerOrderId: result.norenordno };
            }

            logger.error(`[Shoonya] SL order failed: ${result?.emsg ?? 'Unknown'}`);
            return { success: false, error: result?.emsg ?? 'SL order failed' };

        } catch (error) {
            logger.error('[Shoonya] placeSLOrder exception:', error.message);
            return { success: false, error: error.message };
        }
    }

    // ─── Modify SL Order (Trailing) ───────────────────────────────────────────

    /**
     * Modify an existing SL-LMT order — used by the trailing SL engine
     * in angel-socket.js every time the price extreme improves.
     *
     * @param {object} params
     * @param {string} params.brokerOrderId  - Shoonya norenordno of the SL order
     * @param {number} params.triggerPrice   - new stop trigger
     * @param {number} params.price          - new limit price (slightly worse than trigger)
     * @param {number} [params.quantity]     - optional qty override
     * @returns {{ success: boolean, error?: string }}
     */
    async modifySLOrder({
        brokerOrderId,
        price,
        triggerPrice,
        quantity
    }) {
        logger.info(`[Shoonya] Modify SL ${brokerOrderId} → trigger:${triggerPrice} limit:${price}`);

        try {
            const payload = {
                norenordno: brokerOrderId,
                prctyp: 'SL-LMT',
                prc: price.toString(),
                trgprc: triggerPrice.toString(),
            };

            if (quantity) {
                payload.qty = quantity.toString();
            }

            const result = await modifyShoonyaOrder(payload, this.accountId);

            if (result?.stat === 'Ok') {
                logger.info(`[Shoonya] SL modified: ${brokerOrderId}`);
                return { success: true };
            }

            logger.error(`[Shoonya] SL modify failed: ${result?.emsg ?? 'Unknown'}`);
            return { success: false, error: result?.emsg ?? 'Modification failed' };

        } catch (error) {
            logger.error('[Shoonya] modifySLOrder exception:', error.message);
            return { success: false, error: error.message };
        }
    }

    // ─── Cancel Order ─────────────────────────────────────────────────────────

    async cancelOrder(brokerOrderId) {
        logger.info(`[Shoonya] Cancel: ${brokerOrderId}`);
        try {
            const result = await cancelShoonyaOrder(brokerOrderId, this.accountId);
            if (result?.stat === 'Ok') {
                logger.info(`[Shoonya] Canceled: ${brokerOrderId}`);
                return true;
            }
            logger.error(`[Shoonya] Cancel failed: ${result?.emsg ?? 'Unknown'}`);
            return false;
        } catch (error) {
            logger.error('[Shoonya] cancelOrder exception:', error.message);
            return false;
        }
    }

    // ─── Positions ────────────────────────────────────────────────────────────

    async getPositions() {
        // logger.log('[Shoonya] Fetching positions');
        try {
            const positions = await getShoonyaPositions(this.accountId);
            if (!positions || positions.stat === 'Not_Ok' || !Array.isArray(positions)) {
                return [];
            }
            return positions.map(pos => ({
                symbol: pos.tsym,
                quantity: Number(pos.netqty ?? 0),
                avgPrice: Number(pos.upldprc ?? pos.actbuyavgprc ?? 0),
                ltp: Number(pos.lp ?? 0),
                unrealizedPnl: Number(pos.urmtom ?? 0),
                // Product type Shoonya tags this position with: 'I' = MIS/intraday
                // (what this bot always trades with), 'C' = CNC/delivery holding,
                // 'M' = NRML. Needed so the safety-net check (fyers-socket.js)
                // can ignore manually-held delivery stocks that the bot never
                // placed and has no business flagging as a "mismatch".
                productType: pos.prd ?? null,
            }));
        } catch (error) {
            logger.error('[Shoonya] getPositions exception:', error.message);
            return [];
        }
    }

    // ─── Real Day P&L (broker source of truth) ────────────────────────────────

    /**
     * Ground-truth "what actually happened today" straight from Shoonya's
     * PositionBook — independent of our own DB/websocket. For MIS/intraday,
     * netqty === 0 means the position was actually squared off (by us, by
     * the broker's auto square-off, or manually) and rpnl is the broker's
     * own realized P&L for it. netqty !== 0 means still genuinely open.
     *
     * Use this for EOD reporting instead of trusting local `trades.status`,
     * which only updates if our own tick-listener happened to catch the
     * exit — this call can never silently "miss" a close.
     */
    async getRealDayPositions() {
        try {
            const positions = await getShoonyaPositions(this.accountId);
            if (!positions || positions.stat === 'Not_Ok' || !Array.isArray(positions)) {
                return { closed: [], open: [] };
            }

            const closed = [];
            const open = [];

            for (const pos of positions) {
                const netqty = Number(pos.netqty ?? 0);
                const symbol = pos.tsym;
                const realizedPnl = Number(pos.rpnl ?? 0);
                const unrealizedPnl = Number(pos.urmtom ?? 0);
                // Whichever side had the larger fill qty tells us which
                // direction we originally traded (BUY vs SELL/short).
                // NOTE: for a fully CLOSED position, buyQty and sellQty are
                // always equal (you entered and exited the same quantity),
                // so this comparison is always a tie and always resolves to
                // 'BUY' here — it can only reliably tell BUY from SELL for a
                // still-OPEN position. Callers that need the real
                // originating side for a CLOSED trade (e.g. the EOD report)
                // should prefer their own local trade record's `side` and
                // only fall back to this guess for a symbol with no local
                // record at all (e.g. a manual trade placed outside the bot).
                //
                // IMPORTANT: for a CLOSED position we do NOT know here
                // whether entryPrice should be the buy leg or the sell leg
                // — that depends on the REAL side, which this function
                // can't determine (see note above). Previously this used
                // its own (always-'BUY') guess to label entryPrice/exitPrice,
                // which silently swapped them for every real SELL trade and
                // produced an inverted P/L % downstream. So for CLOSED
                // positions we now return the raw buyAvgPrice/sellAvgPrice
                // and let the caller (which knows the real side) assign
                // entry vs. exit correctly. For OPEN positions the tie-break
                // guess is fine since buyQty/sellQty aren't equal there.
                const buyQty = Number(pos.daybuyqty ?? 0);
                const sellQty = Number(pos.daysellqty ?? 0);
                const buyAvgPrice = Number(pos.daybuyavgprc) || null;
                const sellAvgPrice = Number(pos.daysellavgprc) || null;

                if (netqty === 0 && (buyQty > 0 || sellQty > 0)) {
                    // side/entryPrice/exitPrice intentionally omitted here —
                    // ambiguous without the real originating side. Caller
                    // must derive them from buyAvgPrice/sellAvgPrice + its
                    // own known side.
                    closed.push({ symbol, buyAvgPrice, sellAvgPrice, pnl: realizedPnl });
                } else if (netqty !== 0) {
                    const side = buyQty >= sellQty ? 'BUY' : 'SELL';
                    const entryPrice = Number(side === 'BUY' ? buyAvgPrice : sellAvgPrice) || null;
                    open.push({ symbol, side, quantity: netqty, entryPrice, ltp: Number(pos.lp ?? 0), unrealizedPnl });
                }
            }

            return { closed, open };
        } catch (error) {
            logger.error('[Shoonya] getRealDayPositions exception:', error.message);
            return { closed: [], open: [] };
        }
    }

    /**
     * Raw executed fills straight from Shoonya's TradeBook — the actual
     * broker-side record of what filled (entry AND exit legs), each with
     * its own real fill price. Useful when you want per-fill detail rather
     * than the netted-per-symbol view getRealDayPositions() gives you.
     */
    async getTradeBook() {
        try {
            const trades = await getShoonyaTradeBook(this.accountId);
            if (!trades || trades.stat === 'Not_Ok' || !Array.isArray(trades)) {
                return [];
            }
            return trades.map(t => ({
                symbol: t.tsym,
                side: t.trantype === 'B' ? 'BUY' : 'SELL',
                quantity: Number(t.flqty ?? 0),
                fillPrice: Number(t.flprc ?? 0),
                brokerOrderId: t.norenordno,
                fillTime: t.fltime,
            }));
        } catch (error) {
            logger.error('[Shoonya] getTradeBook exception:', error.message);
            return [];
        }
    }

    // ─── Open Orders ────────────────────────────────────────────────────────

    /**
     * All not-yet-filled orders (entry, SL, anything still working) —
     * normalized so cancel-all-orders.js doesn't need to know Shoonya's
     * field names.
     */
    async getOpenOrders() {
        logger.debug?.('[Shoonya] Fetching open orders');
        try {
            const orderBook = await getShoonyaOrderBook(this.accountId);
            if (!orderBook || orderBook.stat === 'Not_Ok' || !Array.isArray(orderBook)) {
                logger.error(`[Shoonya] Could not fetch order book: ${orderBook?.emsg ?? 'Unknown error'}`);
                return [];
            }

            return orderBook
                .map(o => ({
                    brokerOrderId: o.norenordno,
                    symbol: o.tsym ?? '(unknown symbol)',
                    status: (o.status || 'UNKNOWN').toUpperCase(),
                }))
                .filter(o => OPEN_ORDER_STATUSES.includes(o.status));
        } catch (error) {
            logger.error('[Shoonya] getOpenOrders exception:', error.message);
            return [];
        }
    }

    // ─── Live Quote / LTP ───────────────────────────────────────────────────

    /**
     * Current live last-traded-price for a symbol — used as a pre-order
     * sanity check (e.g. slippage guard) so we never place an order
     * without first seeing where the market actually is right now.
     *
     * @param {object} params
     * @param {string} params.symbol
     * @param {string} [params.exchange]
     * @returns {Promise<number|null>} LTP, or null if it couldn't be fetched
     */
    async getLTP({ symbol, exchange = 'NSE' }) {
        try {
            const tsym = getShoonyaTradingSymbol(symbol, exchange);
            const token = await searchShoonyaScrip(exchange.toUpperCase(), tsym, this.accountId);

            if (!token) {
                logger.warn(`[Shoonya] getLTP: could not resolve scrip token for ${tsym}`);
                return null;
            }

            const quote = await getShoonyaQuote(exchange.toUpperCase(), token, this.accountId);
            const ltp = Number(quote?.lp);

            if (!quote || !Number.isFinite(ltp) || ltp <= 0) {
                logger.warn(`[Shoonya] getLTP: no valid LTP in quote for ${tsym}`);
                return null;
            }

            return ltp;
        } catch (error) {
            logger.error('[Shoonya] getLTP exception:', error.message);
            return null;
        }
    }

    // ─── Order Status ─────────────────────────────────────────────────────────

    async getOrderStatus(brokerOrderId) {
        logger.debug(`[Shoonya] Status check: ${brokerOrderId}`);
        try {
            const orderBook = await getShoonyaOrderBook(this.accountId);
            if (!orderBook || orderBook.stat === 'Not_Ok' || !Array.isArray(orderBook)) {
                return { status: 'UNKNOWN' };
            }

            const order = orderBook.find(o => o.norenordno === brokerOrderId);
            if (!order) {
                logger.warn(`[Shoonya] Order ${brokerOrderId} not in orderbook`);
                return { status: 'UNKNOWN' };
            }

            return {
                status: order.status.toUpperCase(), // COMPLETE|REJECTED|OPEN|PENDING|CANCELED
                filledQty: Number(order.fillshares ?? 0),
                avgPrice: Number(order.avgprc ?? 0),
                rejectionReason: order.rejreason ?? null,
            };
        } catch (error) {
            logger.error('[Shoonya] getOrderStatus exception:', error.message);
            return { status: 'UNKNOWN', error: error.message };
        }
    }
}