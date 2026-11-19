/**
 * nine-fifteen-eod-report-worker.js
 *
 * Manually-triggered script: pulls today's 9:15 AM signals from
 * `mw_volume_surge_patterns`, fetches 3-minute intraday candles from
 * Fyers, and calculates profit/loss % per signal. See
 * ../services/eod-report-service.js for the full logic write-up.
 *
 * Run manually after market close (e.g. after 3:30 PM):
 *   node src/workers/nine-fifteen-eod-report-worker.js
 *
 * Optional: pass a date (YYYY-MM-DD) to run for a day other than today:
 *   node src/workers/nine-fifteen-eod-report-worker.js 2026-07-21
 *
 * Optional: pass a custom target % and/or stoploss % to see, for every
 * triggered signal, whether the best intraday move would have hit your
 * target and/or your stoploss would have been hit before it recovered:
 *   node src/workers/nine-fifteen-eod-report-worker.js 2026-07-21 --target=2 --stoploss=1
 *   node src/workers/nine-fifteen-eod-report-worker.js --target=2 --stoploss=1   (defaults to today)
 *
 * This also generates the web UI available at:
 *   GET  /api/eod-report            (form + results page)
 * so the same report can be run from a browser without SSH access.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { generateEodReport, renderReportText, getTodayDateStr } from '../services/eod-report-service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
    let dateStr = null;
    let target = null;
    let stoploss = null;

    for (const raw of argv) {
        if (!raw) continue;
        const targetMatch = raw.match(/^--target=(.+)$/i);
        const slMatch = raw.match(/^--(?:stoploss|sl)=(.+)$/i);
        if (targetMatch) {
            target = targetMatch[1];
        } else if (slMatch) {
            stoploss = slMatch[1];
        } else if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
            dateStr = raw;
        }
    }

    return { dateStr: dateStr || getTodayDateStr(), target, stoploss };
}

function printGroup(label, group) {
    console.log(`\n${label} (${group.length}):`);
    group.forEach((s, i) => {
        const exitVia = s.exitReason === 'target' ? 'TARGET HIT' : s.exitReason === 'stoploss' ? 'STOPLOSS HIT' : 'EOD (3:06 close)';
        console.log(
            `${i + 1}. ${s.symbol} entry=${s.entryPrice} exit=${s.exitPrice} (${exitVia}) ` +
            `3:06=${s.ltp310 ?? '-'} -> ${s.profitPercent.toFixed(2)}% | ` +
            `best possible=${s.high.toFixed(2)}% worst dip=${s.low.toFixed(2)}%`
        );
    });
}

function printNotEnteredTable(group) {
    console.log(`\nNot entered / no data (${group.length}):`);
    console.log('Rank  Symbol        Signal    Reason');
    group.forEach((f, i) => {
        console.log(`${String(i + 1).padEnd(6)}${f.symbol.padEnd(14)}${f.signal.padEnd(10)}${f.reason}`);
    });
}

async function run() {
    const { dateStr, target, stoploss } = parseArgs(process.argv.slice(2));
    console.log(`[EOD Report] Running for date: ${dateStr}${target !== null ? ` | target=${target}%` : ''}${stoploss !== null ? ` | stoploss=${stoploss}%` : ''}`);

    const report = await generateEodReport({ dateStr, target, stoploss, onLog: msg => console.log(`[EOD Report] ${msg}`) });

    if (report.noSignals) {
        console.log(`[EOD Report] No signals found for ${dateStr}.`);
        process.exit(0);
    }

    // ---- Console summary ----
    console.log(`\nSuccessful (${report.successful.length}):`);
    printGroup('BUY', report.successfulBuy);
    printGroup('SELL', report.successfulSell);

    console.log(`\nFailed (${report.failed.length}):`);
    printGroup('BUY', report.failedBuy);
    printGroup('SELL', report.failedSell);
    if (report.failedNoData.length > 0) {
        printNotEnteredTable(report.failedNoData);
    }

    const s = report.summary;
    console.log(`\nTotal P/L %: ${s.totalProfitPercent.toFixed(2)}%`);
    console.log(`Capital required (1 share/stock, ${s.triggeredCount} triggered): \u20b9${s.totalCapitalRequired.toFixed(2)}`);
    console.log(`Money earned from profitable stocks (${report.successful.filter(x => x.profitPercent >= 0).length}): \u20b9${s.moneyEarned.toFixed(2)}`);
    console.log(`Money lost from losing stocks: \u20b9${s.moneyLost.toFixed(2)}`);
    console.log(`Net: ${s.isNetProfit ? 'PROFIT' : 'LOSS'} of \u20b9${Math.abs(s.netMoney).toFixed(2)} (${s.netReturnPercent.toFixed(2)}% on capital deployed)`);
    if (target !== null) console.log(`Target (${target}%) hit: ${s.targetHitCount} of ${s.triggeredCount}`);
    if (stoploss !== null) console.log(`Stoploss (${stoploss}%) hit: ${s.stoplossHitCount} of ${s.triggeredCount}`);

    // ---- Write a .txt report file, same style as the manual reports ----
    const outDir = path.resolve(__dirname, '../../reports');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `eod-report-${dateStr}.txt`);
    fs.writeFileSync(outPath, renderReportText(report), 'utf8');

    console.log(`\n[EOD Report] Report saved to: ${outPath}`);

    process.exit(0);
}

run().catch(err => {
    console.error('[EOD Report] Fatal error:', err);
    process.exit(1);
});