#!/bin/sh
# Daily Nine-Fifteen order placement (cron every 3 min; market-hours gated inside)
node src/oms/oms-worker.js
