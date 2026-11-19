export const OMS_CONFIG = {
    // ------------------------------------------------------------------
    // RUN_NINE_FIFTEEN / RUN_MW_PATTERN — which signal source(s) this
    // run of oms-worker.js picks up. Overridable via env vars so the
    // SAME script can be scheduled twice (e.g. two separate cron/Task
    // Scheduler entries) with two different, fully independent
    // behaviours — no code duplication, no shared balance pool:
    //
    //   9:15 entry (unchanged, no env vars needed):
    //     node src/oms/oms-worker.js
    //
    //   MW pattern entry (separate schedule, separate process):
    //     set OMS_RUN_NINE_FIFTEEN=false&& set OMS_RUN_MW_PATTERN=true&& node src/oms/oms-worker.js
    //     (Linux/Mac: OMS_RUN_NINE_FIFTEEN=false OMS_RUN_MW_PATTERN=true node src/oms/oms-worker.js)
    //
    // Because each is a SEPARATE PROCESS, they never share the same
    // combinedSignals array or split the same BALANCE — each run's
    // TRADING_BALANCE is divided only among ITS OWN signals. The 9:15
    // schedule keeps running exactly as it does today, completely
    // unaffected by the MW schedule existing.
    // ------------------------------------------------------------------
    // Nine-Fifteen-only build: other strategies are hard-disabled.
    RUN_NINE_FIFTEEN: true,
    RUN_MW_PATTERN: false,
    RUN_FIRST15: false,

    // ------------------------------------------------------------------
    // SIGNAL — which side(s) of signals the OMS worker should pick up
    // and place trades for. One of: 'BUY', 'SELL', 'BOTH'.
    // (Matches the "Signal" dropdown in the config UI.)
    // ------------------------------------------------------------------
    SIGNAL: 'SELL',

    // Target % above (BUY) / below (SELL) the entry price at which the
    // trade's target price is set.
    TARGET_PERCENT: 2.75,

    // Stop-loss % below (BUY) / above (SELL) the entry price at which
    // the trade's stop-loss price is set.
    STOP_LOSS_PERCENT: 2,
    // TRAILING_PERCENT: 0.5,

    // Price range — only signals whose stock price falls within
    // [MIN_PRICE, MAX_PRICE] are eligible to be traded.
    MIN_PRICE: 750,
    MAX_PRICE: 2500,

    // Ratio range — only signals whose `ratio` field falls within
    // [MIN_RATIO, MAX_RATIO] are eligible. Leave MAX_RATIO as null
    // (i.e. "Any") for no upper bound. NOTE: mw_patterns signals don't
    // have a `ratio` field (they rank by `confidence` instead), so this
    // range only ever applies to 9:15 signals.
    MIN_RATIO: 4.5,
    MAX_RATIO: 100,

    // Trading balance (₹) available for sizing trades THIS RUN. Split
    // evenly across every signal picked up in THIS run only — see the
    // RUN_NINE_FIFTEEN/RUN_MW_PATTERN comment above for why running the
    // two as separate scheduled processes keeps their balances fully
    // separate rather than sharing this one pool. Overridable via
    // env var (OMS_BALANCE) so a second scheduled entry can use a
    // different amount than the 9:15 entry without editing this file.
    // Quantity for a trade is computed as floor(BALANCE / entryPrice).
    // If that comes out to 0 (balance too small for even 1 unit at
    // entry price), the signal is skipped — there is no static
    // fallback quantity.
    BALANCE: process.env.OMS_BALANCE != null ? Number(process.env.OMS_BALANCE) : 90000,
    // BALANCE: 100,
    TOP_N_PER_SIDE: 10,
    // TRADE_LIMIT_PER_DAY: 5,
    BROKER: 'SHOONYA',

    // ------------------------------------------------------------------
    // MW_PATTERN — settings that apply ONLY to trades coming from the MW
    // pattern strategy (mw_patterns collection). These OVERRIDE the plain
    // TARGET_PERCENT / STOP_LOSS_PERCENT / BALANCE above, but ONLY for MW
    // pattern signals. Nine-fifteen signals never look at this block —
    // they keep using TARGET_PERCENT / STOP_LOSS_PERCENT / BALANCE like
    // before, completely unaffected.
    //
    // Leave any field here as `null` to fall back to the plain (shared)
    // setting above for that field.
    // ------------------------------------------------------------------
    SLIPPAGE_MAX_PERCENT: 0.125,

    MW_PATTERN: {

        // Target % for MW pattern trades. null -> falls back to
        // TARGET_PERCENT above.
        TARGET_PERCENT: 2.75,

        // Stop-loss % for MW pattern trades. A number (e.g. 1) means a
        // flat percent below (BUY) / above (SELL) entry price.
        // null -> use the pattern's own candle-based stop instead of any
        // percentage: the volume-surge candle's high (M) / low (W), as
        // computed by mw-nine-fifteen-neckline-confirmation-worker.js and
        // carried on the signal as signal.stopLoss. (If that value is
        // ever missing/invalid, oms-worker.js falls back to the shared
        // STOP_LOSS_PERCENT above rather than skip the stop entirely.)
        STOP_LOSS_PERCENT: 1,

        // ------------------------------------------------------------
        // MIN_PRICE / MAX_PRICE — price range for MW pattern signals
        // ONLY (compared against the pattern's neckline/resistance
        // price). Separate from the shared MIN_PRICE/MAX_PRICE above,
        // which Nine-Fifteen keeps using. Set either to null to fall
        // back to the shared value for that bound.
        // ------------------------------------------------------------
        MIN_PRICE: 100,
        MAX_PRICE: 5000,

        // ------------------------------------------------------------
        // REQUIRE_VOLUME_CONFIRMATION — the "3 minute volume" check.
        // When true (default), an MW pattern signal is only picked up
        // for trading if its breakout candle ALSO had above-average
        // volume (checked using 3-min candles, flag: volumeConfirmed).
        // Set to false to trade the neckline breakout (status:
        // 'confirmed') even WITHOUT that extra volume check.
        // ------------------------------------------------------------
        REQUIRE_VOLUME_CONFIRMATION: true,
        // REQUIRE_VOLUME_CONFIRMATION: false,

        // ------------------------------------------------------------
        // QUANTITY — pick ONE of the two approaches below:
        //
        // 1) FIXED QUANTITY (simplest — "always trade 1", "always
        //    trade 10", etc.). Set a number here and every MW pattern
        //    trade will use EXACTLY this quantity, regardless of price
        //    or balance. Set to null to disable and use balance-based
        //    sizing (option 2) instead.
        FIXED_QUANTITY: null,
        // FIXED_QUANTITY: 1,
        // FIXED_QUANTITY: 10,

        // 2) BALANCE-BASED SIZING (same style as the shared BALANCE
        //    above, but a separate pool just for MW pattern signals).
        //    Only used when FIXED_QUANTITY is null. Set to null to fall
        //    back to the shared BALANCE above.
        BALANCE: 20000,
        // BALANCE: 20000,

        // ------------------------------------------------------------
        // PATTERN_TYPE — which MW pattern type(s) to trade:
        //   'W'    -> only W patterns (double-bottom, bullish/BUY)
        //   'M'    -> only M patterns (double-top, bearish/SELL)
        //   'BOTH' -> trade both (default)
        // Separate from the shared SIGNAL setting above — lets you run
        // MW pattern trades for only W or only M without touching
        // nine-fifteen at all.
        // ------------------------------------------------------------
        PATTERN_TYPE: 'BOTH'
        // PATTERN_TYPE: 'W',
        // PATTERN_TYPE: 'M',
    },

    // ------------------------------------------------------------------
    // FIRST15 — settings for the "First 15 Minute" (9:15-9:30 AM) ORB
    // breakout strategy (strategy.docx), used ONLY for trades where
    // patternSource === 'FIRST15_ORB'. Nine-Fifteen and MW Pattern never
    // read this block — same "separate block, doesn't touch the others"
    // pattern as MW_PATTERN above.
    //
    // This strategy is long-only (BUY), so it only ever respects the
    // shared SIGNAL setting when SIGNAL is 'BUY' or 'BOTH' — if you set
    // SIGNAL: 'SELL', FIRST15 signals are skipped entirely (nothing to
    // sell in this strategy).
    // ------------------------------------------------------------------
    FIRST15: {

        // Which broker places/exits FIRST15_ORB trades. Independent of
        // the shared BROKER above (which Nine-Fifteen and MW Pattern
        // still use) — set to 'WISDOM', 'SHOONYA', or 'ANGEL'/'ANGELONE'.
        // This strategy is built and tested against Wisdom Capital.
        BROKER: 'WISDOM',

        // ₹ above the qualifying candle's High we place the BUY order
        // at — same convention as the shared ENTRY_PRICE_OFFSET, kept
        // separate so it can be tuned independently for this strategy.
        ENTRY_PRICE_OFFSET: 0,

        // The entry is a TRIGGER order (Stop-Limit), not a plain resting
        // Limit order — it only activates once the market price actually
        // crosses the breakout level (High + ENTRY_PRICE_OFFSET above),
        // exactly like a real "buy on breakout" order should. This ₹
        // amount is added ON TOP of the trigger level to get the actual
        // limit price sent once triggered, so the order can still fill
        // in a fast move instead of missing by a paisa. Keep this small.
        TRIGGER_LIMIT_BUFFER: 0,

        // ------------------------------------------------------------
        // FIXED_QUANTITY — pick ONE of the two sizing approaches below,
        // same idea as MW_PATTERN.FIXED_QUANTITY above:
        //
        // 1) FIXED QUANTITY (simplest). Set a number here and every
        //    FIRST15_ORB entry order uses EXACTLY this quantity,
        //    regardless of price or BALANCE below — the 50/50 split
        //    across the two target legs (1:1 / 1:2) still applies to
        //    this fixed quantity. Set to null to disable and fall back
        //    to BALANCE-based sizing (option 2) instead.
        // ------------------------------------------------------------
        FIXED_QUANTITY: 10,
        // FIXED_QUANTITY: 1,
        // FIXED_QUANTITY: 10,

        // ------------------------------------------------------------
        // TARGET1_EXIT_PERCENT — % of the position sold when target1
        // (1:1) is hit. The rest (100 - this) keeps running toward
        // target2 (1:2), with its stop-loss walked up to entryPrice
        // (breakeven) and then step-trailed — see TRAIL_STEP_PERCENT /
        // TRAIL_LOCK_PERCENT below. Was a fixed 50/50 split before;
        // now fully dynamic. 70 = sell 70% at target1, run the
        // remaining 30% with a trailing stop.
        // ------------------------------------------------------------
        TARGET1_EXIT_PERCENT: 70,
        // TARGET1_EXIT_PERCENT: 50,

        // ------------------------------------------------------------
        // TARGET_LADDER — the live profit-booking plan for FIRST15_ORB,
        // replacing the old fixed 1:1/1:2 target1/target2 system above
        // (TARGET1_EXIT_PERCENT / target1Price / target2Price are now
        // only used by the historical backtest report — see
        // first15-backtest-service.js — NOT by live trading).
        //
        // Each step is a % move above entryPrice. When price reaches
        // that step: the stop-loss is walked up to slPercent (also a %
        // above entryPrice, locking in that much profit) and sellPercent
        // of the ORIGINAL total quantity is sold (0 = just move the SL,
        // sell nothing). Whatever's left after all 4 steps is squared
        // off automatically at market close (see EOD_SQUAREOFF_TIME
        // below and squareOffFirst15AtClose() in fyers-socket.js).
        //
        // The 4 sellPercent values below add up to 95 — the remaining
        // 5% is what rides to the close.
        // ------------------------------------------------------------
        TARGET_LADDER: [
            { targetPercent: 1.75, slPercent: 0.75, sellPercent: 0 },
            { targetPercent: 2, slPercent: 1.25, sellPercent: 70 },
            { targetPercent: 3, slPercent: 1.75, sellPercent: 15 },
            { targetPercent: 4, slPercent: 2.5, sellPercent: 10 },
        ],

        // How long before actual exchange close (15:30 IST) the bot
        // force-exits whatever quantity is still open on a FIRST15
        // trade (the final ~5% that rode past all 4 ladder steps, or
        // the whole position if no step was ever reached). Placed a
        // few minutes early so a MARKET order has time to actually fill
        // before the exchange stops accepting orders — exiting exactly
        // at 15:30 risks the order missing the window entirely.
        EOD_SQUAREOFF_MINUTES_BEFORE_CLOSE: 10,

        // ------------------------------------------------------------
        // Step-trailing stop-loss for the runner (the quantity left
        // after target1). Only kicks in AFTER target1 is hit and the
        // SL has already been walked up to entryPrice (breakeven) —
        // before that, the stop stays the original candle-Low stop.
        //
        // Classic 2-parameter step trail:
        //   for every TRAIL_STEP_PERCENT the price moves up (measured
        //   from entryPrice), the stop-loss is moved up by
        //   TRAIL_LOCK_PERCENT (also measured as a % of entryPrice).
        //
        // e.g. TRAIL_STEP_PERCENT: 0.5, TRAIL_LOCK_PERCENT: 0.5,
        // entryPrice: 1000 -> every ₹5 (0.5%) further gain in price
        // moves the SL up by another ₹5 (0.5%): price 1005 -> SL 1000
        // (still breakeven, first step not yet complete), price 1010
        // -> SL 1005, price 1015 -> SL 1010, etc. The stop only ever
        // moves up, never down, and target2 (1:2) still exits whatever
        // is left if it's reached first.
        // ------------------------------------------------------------
        TRAIL_STEP_PERCENT: 0.5,
        TRAIL_LOCK_PERCENT: 0.5,

        // 2) BALANCE-BASED SIZING (existing behaviour). Only used when
        //    FIXED_QUANTITY is null.
        // Total ₹ balance for FIRST15_ORB signals, split evenly across
        // however many qualify in a given run, THEN split 50/50 again
        // per signal across the two target legs (1:1 and 1:2 — see
        // strategy.docx). Leave null to disable trading entirely (still
        // detects/logs qualifying stocks, just never sizes/places
        // orders for them).
        BALANCE: process.env.FIRST15_BALANCE != null ? Number(process.env.FIRST15_BALANCE) : 50000,

        // Price range — only stocks priced between these two values are
        // eligible. Separate pool from the shared MIN_PRICE/MAX_PRICE
        // above (which apply to Nine-Fifteen/MW), since this strategy
        // scans the full EQ universe rather than just F&O names.
        MIN_PRICE: 0,
        MAX_PRICE: 40000,

        // How many top-ranked (by volumeVsAvgRatio, highest first)
        // qualifying stocks to pick up per run. Same idea as the shared
        // TOP_N_PER_SIDE, kept separate so it can differ for this
        // (BUY-only, much larger universe) strategy.
        TOP_N: null
    }

};