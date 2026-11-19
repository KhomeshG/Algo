/**
 * eod-report-chat-service.js  (Gemini API version)
 *
 * Lets investors ask free-form questions about an already-generated
 * 9:15 EOD report ("which BUY had the best profit%?", "how many hit
 * stoploss?", "why did XYZ fail?", etc).
 *
 * Uses Google's Gemini API (free tier available via Google AI Studio —
 * see the setup steps in the accompanying message for how to get a key).
 *
 * Design:
 *   - Stateless w.r.t. the report itself: the caller (route) sends the
 *     SAME report object the /run endpoint already returned, on every
 *     chat call. We don't persist reports server-side.
 *   - `buildReportContext` trims each signal down to the fields
 *     actually useful for answering questions (candle timestamps and
 *     other noise are dropped), keeping token usage predictable even
 *     on a heavy day.
 *   - Conversation history is passed in from the client (plain
 *     {role, content} text turns) so follow-up questions like "what
 *     about the SELL side?" work. The full report JSON is only
 *     attached to the CURRENT question, not repeated in every history
 *     turn, to avoid re-sending it N times per follow-up.
 *
 * Requires:
 *   npm install @google/genai
 *   GEMINI_API_KEY set in the environment.
 */

import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Flash is free-tier eligible and plenty fast/cheap for "read this JSON
// and answer a question about it" — override via env var if needed.
//
// NOTE: Google retires/renames Gemini model IDs fairly often (gemini-2.5-flash
// itself stopped being issued to new API keys mid-2026). If this starts
// 404ing with "no longer available", check https://ai.google.dev/gemini-api/docs/models
// for the current Flash-tier model ID and update EOD_REPORT_CHAT_MODEL
// (or this default) rather than assuming the code is broken.
const CHAT_MODEL = process.env.EOD_REPORT_CHAT_MODEL || 'gemini-3.5-flash';

// Gemini 3.x models "think" before answering by default, and those
// reasoning tokens are billed against maxOutputTokens ALONGSIDE the
// visible answer (not separately, despite older docs suggesting
// otherwise). With a low token budget the model can burn the whole
// thing on invisible reasoning and get cut off mid-sentence before
// writing anything visible. Two fixes, both applied below:
//   1. Keep thinking effort low — this task (read JSON, answer a
//      question) doesn't need deep reasoning.
//   2. Give a generous token ceiling as a buffer regardless.
const MAX_OUTPUT_TOKENS = 2048;
const THINKING_LEVEL = process.env.EOD_REPORT_CHAT_THINKING_LEVEL || 'low'; // minimal | low | medium | high

// Keep only the last N user/assistant turns of history so a long chat
// session doesn't grow the prompt unboundedly.
const MAX_HISTORY_TURNS = 8;

const SYSTEM_PROMPT = `You are a data-analysis assistant embedded in a stock trading backtesting dashboard ("9:15 Back Testing Report").

You will be given, with the user's question, a JSON object describing backtested results. It comes in one of two shapes:

1. SINGLE-DAY mode ("kind": "day") — one day's report: which volume-surge signals triggered, their entry/exit prices, profit %, whether a target or stoploss was hit, and which signals never triggered or had no data.

2. RANGE mode ("kind": "range") — a week or month simulation: a starting cash balance was split equally across each day's signals and reinvested day to day. You'll get a day-by-day breakdown (date, how many signals triggered, balance at the start/end of that day, P&L, return %) plus overall totals for the whole period.

Rules:
- Answer ONLY using the JSON data provided in the current message (and prior turns of this conversation). Do not use outside knowledge of these stocks, and do not guess numbers that aren't in the data.
- This is a BACKTEST of PAST trading days. Never phrase anything as advice, a recommendation, or a prediction about what to buy/sell next. Describe what the historical data shows, in past tense.
- In RANGE mode, if asked about a specific signal/symbol's entry or exit price, explain that the range summary only has day-level totals, not individual signal details — suggest they switch to that single day for that level of detail.
- If the question can't be answered from the given data (e.g. asks about a symbol that isn't in it, or asks about the future), say so plainly instead of guessing.
- Be concise — a few sentences or a short list is usually enough. Use plain numbers (e.g. "2.34%"), not restated JSON.
- Reply in PLAIN TEXT only — no markdown. That means no **bold**, no *italics*, no # headers, and no "* " bullet markers. If you need a list, put each item on its own line starting with a dash "- " instead of an asterisk.
- If asked for investment advice, gently clarify you can only describe what happened in this backtest, not recommend trades.`;

/**
 * Trims one signal record down to the fields relevant for Q&A.
 */
function trimSignal(r) {
    const out = {
        symbol: r.symbol,
        signal: r.signal,
        ratio: r.ratio,
        entryPrice: r.entryPrice,
        exitPrice: r.exitPrice,
        exitVia: r.exitReason, // 'target' | 'stoploss' | 'eod'
        profitPercent: r.profitPercent,
        bestPossiblePercent: r.high,
        worstDrawdownPercent: r.low,
        ltp310: r.ltp310,
        ltp310Percent: r.ltp310Percent
    };
    if (typeof r.customPercent === 'number') {
        out.customExitLtp = r.ltpCustom;
        out.customExitPercent = r.customPercent;
        out.customExitTime = r.customTimeLabel;
    }
    if (typeof r.reason === 'string') {
        out.reason = r.reason; // present on failed-with-data records, e.g. "negative profit"
    }
    return out;
}

/**
 * Builds the compact context object sent to the model. Mirrors the
 * shape of the full report but leaves out fields the model doesn't
 * need to answer questions.
 */
function buildReportContext(report) {
    if (!report || report.noSignals) {
        return { kind: 'day', date: report?.dateStr ?? null, noSignals: true };
    }

    const failedWithData = (report.failed || []).filter(f => typeof f.profitPercent === 'number');
    const notEntered = report.failedNoData || (report.failed || []).filter(f => typeof f.profitPercent !== 'number');

    return {
        kind: 'day',
        date: report.dateStr,
        filters: {
            target: report.target,
            stoploss: report.stoploss,
            rangeMin: report.rangeMin,
            rangeMax: report.rangeMax,
            signalType: report.signalType,
            ratioMin: report.ratioMin,
            ratioMax: report.ratioMax,
            exitTime: report.exitTime
        },
        summary: report.summary,
        // "successful" = profitable triggered signals, "failedTriggered" =
        // triggered but ended in a loss, "notEntered" = trigger price
        // never hit / no candle data at all. Same buckets the dashboard shows.
        successfulSignals: (report.successful || []).map(trimSignal),
        failedTriggeredSignals: failedWithData.map(trimSignal),
        notEnteredSignals: notEntered.map(f => ({
            symbol: f.symbol,
            signal: f.signal,
            ratio: f.ratio,
            reason: f.reason
        }))
    };
}

/**
 * Builds the compact context object for a week/month/custom-range
 * simulation (the object returned by generateEodReportRange() / GET
 * /api/eod-report/run-range). Deliberately day-level only, not
 * per-signal — a 6-month range can span 100+ trading days, so including
 * every individual signal for every day would blow well past a sane
 * prompt size. Ask a follow-up about one specific day instead if you
 * need that level of detail (switch the dashboard to that single day).
 */
function buildRangeReportContext(range, period) {
    if (!range) {
        return { kind: 'range', noData: true };
    }

    return {
        kind: 'range',
        period, // 'week' | 'month' | 'custom'
        startDate: range.startDate,
        endDate: range.endDate,
        filters: {
            target: range.target,
            stoploss: range.stoploss,
            rangeMin: range.rangeMin,
            rangeMax: range.rangeMax,
            signalType: range.signalType,
            ratioMin: range.ratioMin,
            ratioMax: range.ratioMax,
            exitTime: range.exitTime
        },
        startBalance: range.startBalance,
        endBalance: range.endBalance,
        totalPnl: range.totalPnl,
        totalReturnPercent: range.totalReturnPercent,
        totalDaysChecked: range.totalDaysChecked,
        tradingDaysCount: range.tradingDaysCount,
        profitDays: range.profitDays,
        lossDays: range.lossDays,
        days: (range.days || []).map(d => ({
            date: d.dateStr,
            triggeredCount: d.triggeredCount,
            startBalance: d.startBalance,
            allocated: d.allocated,
            unused: d.unused,
            pnl: d.pnl,
            returnPercent: d.returnPercent,
            endBalance: d.endBalance,
            noSignals: d.noSignals
        }))
    };
}

/**
 * Safety net in case the model ignores the "no markdown" instruction —
 * strips the common offenders (bold/italic asterisks, header hashes,
 * bullet markers) so the chat bubble never shows raw "**text**" etc.
 */
function stripMarkdown(text) {
    return text
        .replace(/\*\*(.*?)\*\*/g, '$1')              // **bold**
        .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1')  // *italic* (not part of **)
        .replace(/^#{1,6}\s*/gm, '')                   // # headers
        .replace(/^\s*[\*•]\s+/gm, '- ');              // "* item" / "• item" -> "- item"
}

/**
 * Trims one MW-backtest trade record down to the fields relevant for Q&A.
 */
function trimMwTrade(t) {
    return {
        symbol: t.symbol,
        type: t.type, // 'W' (buy) | 'M' (sell)
        entryDate: t.entryDate,
        entryPrice: t.entryPrice,
        stopLoss: t.stopLoss,
        target: t.target,
        riskRewardRatio: t.riskRewardRatio,
        volumeRatio: t.volumeMatch?.ratio,
        exitPrice: t.exitPrice,
        exitReason: t.exitReason, // 'target' | 'stoploss' | 'day-close' | 'custom-exit-time' | 'eod'
        qty: t.qty,
        pnl: t.pnl,
        pnlPercent: t.pnlPercent,
        win: t.win
    };
}

/**
 * Builds the compact context object sent to the model for an MW
 * pattern-backtest report (the object returned by runMWBacktest() / GET
 * /api/mw-backtest/run). A full walk-forward run can produce thousands of
 * trades across ~200 symbols and 3 years, so the FULL trade list is never
 * sent — only summary stats, the per-symbol leaderboard (already sorted by
 * P&L), and the best/worst individual trades. Follow-up questions about a
 * specific symbol's full trade history aren't answerable from this context;
 * the assistant is told to say so.
 */
function buildMwBacktestContext(report) {
    if (!report || !Array.isArray(report.trades)) {
        return { kind: 'mw-backtest', noData: true };
    }

    const sortedByPnl = [...report.trades].sort((a, b) => b.pnl - a.pnl);
    const TOP_N = 20;
    const topWinners = sortedByPnl.slice(0, TOP_N).map(trimMwTrade);
    const topLosers = sortedByPnl.slice(-TOP_N).reverse().map(trimMwTrade);

    return {
        kind: 'mw-backtest',
        params: report.params,
        stocksScanned: report.stocksScanned,
        symbolsWithTrades: report.symbolsWithTrades,
        totalTrades: report.trades.length,
        summary: report.summary,
        // Sorted descending by P&L already — top performers.
        perSymbolSummary: (report.perSymbolSummary || []).slice(0, 30),
        skippedSymbolsCount: (report.skippedSymbols || []).length,
        topWinningTrades: topWinners,
        topLosingTrades: topLosers,
        note: 'Only the top/bottom trades and per-symbol totals are included, not every individual trade — if asked about a specific trade not listed here, say the full list is not in the given data.'
    };
}

const MW_BACKTEST_SYSTEM_PROMPT = `You are a data-analysis assistant embedded in a stock trading backtest dashboard ("MW Pattern Backtest").

You will be given, with the user's question, a JSON object describing a walk-forward backtest of a double-bottom (W) / double-top (M) neckline-break strategy across many symbols and a date range. It includes: the search params/filters used, overall summary stats (win rate, P&L, profit factor, drawdown, etc), a per-symbol P&L leaderboard, and the top winning/losing individual trades (NOT every trade — the full trade list can be thousands of rows and isn't included).

Rules:
- Answer ONLY using the JSON data provided in the current message (and prior turns of this conversation). Do not use outside knowledge of these stocks, and do not guess numbers that aren't in the data.
- This is a BACKTEST of PAST/historical data. Never phrase anything as advice, a recommendation, or a prediction about what to buy/sell next. Describe what the historical data shows, in past tense.
- If asked about an individual trade or symbol not present in topWinningTrades/topLosingTrades/perSymbolSummary, say plainly that the full trade list isn't in the given data rather than guessing.
- Be concise — a few sentences or a short list is usually enough. Use plain numbers (e.g. "2.34%"), not restated JSON.
- Reply in PLAIN TEXT only — no markdown. That means no **bold**, no *italics*, no # headers, and no "* " bullet markers. If you need a list, put each item on its own line starting with a dash "- " instead of an asterisk.
- If asked for investment advice, gently clarify you can only describe what happened in this backtest, not recommend trades.`;

/**
 * @param {object} opts
 * @param {object} opts.report - the full MW-backtest report object as
 *        returned by runMWBacktest() / GET /api/mw-backtest/run.
 * @param {string} opts.question - the investor's question
 * @param {{role:'user'|'assistant', content:string}[]} [opts.history] -
 *        prior turns of this chat, oldest first (plain text only, no JSON)
 * @returns {Promise<{answer:string, model:string}>}
 */
export async function askAboutMwBacktestReport({ report, question, history = [] }) {
    if (!question || typeof question !== 'string' || !question.trim()) {
        throw new Error('question is required');
    }
    if (!report) {
        throw new Error('report is required');
    }

    const context = buildMwBacktestContext(report);

    const cleanHistory = (Array.isArray(history) ? history : [])
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
        .slice(-MAX_HISTORY_TURNS * 2);

    const contents = [
        ...cleanHistory.map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content.trim() }]
        })),
        {
            role: 'user',
            parts: [{ text: `Report data (JSON):\n${JSON.stringify(context)}\n\nQuestion: ${question.trim()}` }]
        }
    ];

    const response = await ai.models.generateContent({
        model: CHAT_MODEL,
        contents,
        config: {
            systemInstruction: MW_BACKTEST_SYSTEM_PROMPT,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            thinkingConfig: {
                thinkingLevel: THINKING_LEVEL
            }
        }
    });

    const answer = stripMarkdown((response.text || '').trim());
    const finishReason = response.candidates?.[0]?.finishReason;

    if (finishReason === 'MAX_TOKENS') {
        console.warn(`[MW Backtest Chat] Response hit MAX_TOKENS (thinkingLevel=${THINKING_LEVEL}, maxOutputTokens=${MAX_OUTPUT_TOKENS}). Consider raising MAX_OUTPUT_TOKENS or lowering thinking level further.`);
        if (!answer) {
            return { answer: "Sorry, that question needed more reasoning than the response budget allowed — try asking something more specific, or a shorter follow-up.", model: CHAT_MODEL, truncated: true };
        }
    }

    return { answer, model: CHAT_MODEL, truncated: finishReason === 'MAX_TOKENS' };
}

/**
 * @param {object} opts
 * @param {object} [opts.report] - the full single-day report object as
 *        returned by generateEodReport() / GET /api/eod-report/run.
 *        Provide EITHER this OR opts.range, not both.
 * @param {object} [opts.range] - the range simulation object as returned
 *        by generateEodReportRange() / GET /api/eod-report/run-range
 * @param {string} [opts.period] - 'week' | 'month' | 'custom', required
 *        alongside opts.range so the assistant knows what it's looking at
 * @param {string} opts.question - the investor's question
 * @param {{role:'user'|'assistant', content:string}[]} [opts.history] -
 *        prior turns of this chat, oldest first (plain text only, no JSON)
 * @returns {Promise<{answer:string, model:string}>}
 */
export async function askAboutReport({ report, range, period, question, history = [] }) {
    if (!question || typeof question !== 'string' || !question.trim()) {
        throw new Error('question is required');
    }
    if (!report && !range) {
        throw new Error('either report or range is required');
    }

    const context = range ? buildRangeReportContext(range, period) : buildReportContext(report);

    const cleanHistory = (Array.isArray(history) ? history : [])
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
        .slice(-MAX_HISTORY_TURNS * 2);

    // Gemini's chat turns use role 'user' | 'model' (not 'assistant'),
    // and each turn's text goes in a `parts` array.
    const contents = [
        ...cleanHistory.map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content.trim() }]
        })),
        {
            role: 'user',
            parts: [{ text: `Report data (JSON):\n${JSON.stringify(context)}\n\nQuestion: ${question.trim()}` }]
        }
    ];

    const response = await ai.models.generateContent({
        model: CHAT_MODEL,
        contents,
        config: {
            systemInstruction: SYSTEM_PROMPT,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            thinkingConfig: {
                thinkingLevel: THINKING_LEVEL
            }
        }
    });

    const answer = stripMarkdown((response.text || '').trim());
    const finishReason = response.candidates?.[0]?.finishReason;

    if (finishReason === 'MAX_TOKENS') {
        console.warn(`[EOD Report Chat] Response hit MAX_TOKENS (thinkingLevel=${THINKING_LEVEL}, maxOutputTokens=${MAX_OUTPUT_TOKENS}). Consider raising MAX_OUTPUT_TOKENS or lowering thinking level further.`);
        if (!answer) {
            // Thinking alone consumed the entire budget — nothing visible was written at all.
            return { answer: "Sorry, that question needed more reasoning than the response budget allowed — try asking something more specific, or a shorter follow-up.", model: CHAT_MODEL, truncated: true };
        }
    }

    return { answer, model: CHAT_MODEL, truncated: finishReason === 'MAX_TOKENS' };
}