# Nine-Fifteen (single account)

Only the 9:15 volume-surge strategy, on ONE Shoonya account (ACC1).
Multi-account, MW Pattern, First15, Wisdom and Angel brokers are removed.

## Setup
1. `cp .env.example .env` and fill it in. Never commit `.env`.
2. `npm install`

## Daily flow (IST)
| When | Command |
|---|---|
| Morning, before 9:00 | `node src/workers/fyersautologin.js` (or `node refresh-token.js`) |
| Before 9:15 (keep running) | `node src/workers/volume-surge-worker-websocket.js` writes signals to `mw_volume_surge_patterns` |
| Before 9:15 (always on) | `node src/websocket/fyers-socket.js` price feed + exit engine |
| Always on | `npm start` API, Shoonya socket, 9:30 digest and 3:30 EOD emails |
| 9:17 to 9:21 | `node src/oms/oms-worker.js` places entries (cron `*/3 * * * *`) |
| After close | `node src/workers/nine-fifteen-eod-report-worker.js` |

## Support scripts
- `src/workers/fyers-candle-fetcher-worker.js`: daily 3-min candles into `fno_candles` (needed for the 20-candle EMA).
- `src/workers/backfill-fno-candles.js --from= --to=`: history backfill.
- `src/workers/volume-surge-worker.js --date=YYYY-MM-DD`: REST backfill of a missed day.
- `src/oms/exit-all-positions.js`, `cancel-all-orders.js`, `cancel-open-orders-worker.js`, `recovery-worker.js`: safety tools.

Trading settings (target, stop-loss, price/ratio range, balance) live in `src/config/oms-config.js` and can be overridden via Mongo `system_config`.
