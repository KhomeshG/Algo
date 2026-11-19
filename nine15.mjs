/**
 * nine15-copy.mjs  —  copy the "9:15 Breakout" signals onto YOUR Shoonya account
 *
 * FLOW (all times IST)
 *   1. Login to Shoonya (same QuickAuth + GenAcsTok flow as the main bot).
 *   2. Poll MongoDB (mw_volume_surge_patterns) every second. The moment a new
 *      signal appears it is filtered (side / price range / ratio) and a
 *      TRIGGER (SL-LMT) entry order is placed.   Entry = signal.low - 0.20 (SELL)
 *                                                          signal.high + 0.20 (BUY)
 *   3. At CANCEL_TIME (09:21) every still-open entry order is cancelled.
 *   4. For each entry that filled, an OCO pair is placed: TARGET (limit) + STOP-LOSS
 *      (SL-LMT). When one fills, the other is cancelled automatically.
 *   5. Safety: at SQUAREOFF_TIME (15:10) any position still open is closed.
 *
 * WHY "SOFTWARE OCO": Shoonya's public API has no OCO for intraday (MIS) equity.
 * So this script places both exit legs and cancels the other one itself, checking
 * the order book every ~1.5 s. => The script MUST keep running until the trade ends.
 *
 * SAFE BY DEFAULT: DRY_RUN=true  (prints what it would do, sends NO orders).
 *   Set DRY_RUN=false only after a dry run looked right.
 *
 * INSTALL (Android / Termux):
 *   pkg install nodejs
 *   npm install mongodb
 *   termux-wake-lock          # keeps the phone from sleeping
 * RUN:
 *   node nine15-copy.mjs
 *
 * Put your values in a file called  .env  next to this script (see bottom of
 * this file for the template) or export them as environment variables.
 */

import crypto from 'crypto';
import fs from 'fs';
import { MongoClient } from 'mongodb';

// ───────────────────────── .env loader (no dependency) ─────────────────────────
try {
  for (const line of fs.readFileSync(new URL('./.env', import.meta.url), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch { /* no .env file — fine, use real env vars */ }

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const num = (k, d) => Number(env(k, d));
const bool = (k, d) => String(env(k, d)).toLowerCase() === 'true';

// ───────────────────────────────── CONFIG ──────────────────────────────────────
const CFG = {
  // --- Safety ---
  DRY_RUN: bool('DRY_RUN', true),

  // --- Signal filters (same values as the main bot's oms-config.js) ---
  SIGNAL: env('SIGNAL', 'SELL').toUpperCase(),     // 'SELL' | 'BUY' | 'BOTH'
  MIN_PRICE: num('MIN_PRICE', 750),
  MAX_PRICE: num('MAX_PRICE', 2500),
  MIN_RATIO: num('MIN_RATIO', 4.5),
  MAX_RATIO: num('MAX_RATIO', 100),

  // --- Exit levels (% of entry) ---
  TARGET_PERCENT: num('TARGET_PERCENT', 2.75),
  STOP_LOSS_PERCENT: num('STOP_LOSS_PERCENT', 2),

  // --- Sizing (set per account) ---
  USE_SHOONYA_BALANCE: bool('USE_SHOONYA_BALANCE', true), // true = read available balance from Shoonya and split equally across the batch
  BALANCE_USE_PERCENT: num('BALANCE_USE_PERCENT', 90),    // use only this % of the fetched balance (keeps a safety cushion)
  LEVERAGE: num('LEVERAGE', 1),                            // 1 = no leverage (safe). Raise only if you know your MIS leverage.
  CAPITAL_PER_TRADE: num('CAPITAL_PER_TRADE', 0),         // fallback ₹/signal if balance fetch is off or fails (0 = skip trading instead)
  MAX_TRADES: num('MAX_TRADES', 10),                   // top N signals PER SIDE by ratio (sir's TOP_N_PER_SIDE)

  // --- Entry order details ---
  ENTRY_PRICE_OFFSET: num('ENTRY_PRICE_OFFSET', 0.20), // ₹ beyond candle low (SELL) / high (BUY)
  ENTRY_LIMIT_BUFFER: num('ENTRY_LIMIT_BUFFER', 0),    // ₹ worse than trigger for the limit leg (0 = same as main bot)
  SL_LIMIT_BUFFER_PCT: num('SL_LIMIT_BUFFER_PCT', 0.5),// stop-loss limit is this % beyond its trigger so it actually fills

  // --- Schedule (IST, HH:MM or HH:MM:SS) ---
  ENTRY_START: env('ENTRY_START', '09:18:00'),
  CANCEL_TIME: env('CANCEL_TIME', '09:21:00'),
  SQUAREOFF_TIME: env('SQUAREOFF_TIME', '15:10:00'),
  CANCEL_ALL_OPEN: bool('CANCEL_ALL_OPEN', false),     // true = cancel EVERY open order on the account at CANCEL_TIME,
                                                       // false (default) = only orders this script placed

  // --- Polling ---
  COLLECT_MS: num('COLLECT_MS', 35000),               // wait this long after the FIRST signal, then pick top N by ratio (like sir's bot)
  POLL_MS: num('POLL_MS', 1000),
  OCO_POLL_MS: num('OCO_POLL_MS', 1500),

  // --- Mongo ---
  MONGODB_URL: env('MONGODB_URL', ''),
  DB_NAME: env('DB_NAME', 'tradebot'),
  COLLECTION: 'mw_volume_surge_patterns',

  // --- Shoonya credentials ---
  UID: env('SHOONYA_UID', ''),
  PASSWORD: env('SHOONYA_PASSWORD', ''),
  TOTP_SECRET: env('SHOONYA_TOTP_SECRET', ''),
  API_KEY: env('SHOONYA_API_KEY', ''),
  CLIENT_ID: env('SHOONYA_CLIENT_ID', ''),
  SECRET_CODE: env('SHOONYA_SECRET_CODE', ''),

  STATE_FILE: env('STATE_FILE', './nine15-state.json'),
};

const BASE = 'https://api.shoonya.com/NorenWClientAPI';
const TICK = 0.05;

// ───────────────────────────────── helpers ─────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const roundTick = (p) => Number((Math.round(p / TICK) * TICK).toFixed(2));
const fmt = (n) => Number(n).toFixed(2);

function istParts(d = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(d).map((x) => [x.type, x.value])
  );
  return { date: `${p.year}-${p.month}-${p.day}`, secs: +p.hour * 3600 + +p.minute * 60 + +p.second };
}
const toSecs = (hhmmss) => { const [h, m = 0, s = 0] = hhmmss.split(':').map(Number); return h * 3600 + m * 60 + s; };
const nowIST = () => istParts();
const stamp = () => new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata' });
const log = (...a) => console.log(`[${stamp()}]`, ...a);

// ── TOTP (RFC 6238, SHA-1, 30 s, 6 digits) — no external library ──
function base32Decode(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of s.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase()) {
    const v = alphabet.indexOf(c);
    if (v < 0) throw new Error('Invalid base32 TOTP secret');
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
function totp(secret, time = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 1000 / 30)));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 1_000_000).padStart(6, '0');
}

// ───────────────────────────── Shoonya client ──────────────────────────────────
let TOKEN = null;

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain', ...headers }, body });
  const text = await res.text();
  try { return JSON.parse(text); }
  catch { throw new Error(`Non-JSON reply from ${url} (HTTP ${res.status}): ${text.slice(0, 200)}`); }
}

async function login() {
  for (const k of ['UID', 'PASSWORD', 'TOTP_SECRET', 'API_KEY', 'CLIENT_ID', 'SECRET_CODE']) {
    if (!CFG[k]) throw new Error(`Missing Shoonya credential: ${k}`);
  }
  const payload = {
    apkversion: 'W2_20250926',
    uid: CFG.UID,
    pwd: sha256(CFG.PASSWORD),
    factor2: totp(CFG.TOTP_SECRET),
    appkey: CFG.API_KEY,
    imei: crypto.randomUUID(),
    addldivinf: 'nine15-copy',
    source: 'API',
    vc: 'NOREN_API',
    app_key: CFG.CLIENT_ID,
  };
  const step1 = await postJson(`${BASE}/QuickAuth`, `jData=${JSON.stringify(payload)}`);
  if (!step1.code) throw new Error(`Login step 1 failed: ${step1.emsg || JSON.stringify(step1)}`);

  const checksum = sha256(`${CFG.CLIENT_ID}${CFG.SECRET_CODE}${step1.code}`);
  const step2 = await postJson(
    `${BASE}/GenAcsTok`,
    `jData=${JSON.stringify({ code: step1.code, checksum })}`,
    { Authorization: `Bearer ${checksum}` }
  );
  const t = step2.tokenData || step2;
  if (t.stat !== 'Ok' || !t.susertoken) throw new Error(`Login step 2 failed: ${t.emsg || JSON.stringify(step2)}`);
  TOKEN = t.susertoken;
  log('Shoonya login OK');
}

async function api(endpoint, data, retry = true) {
  const payload = { uid: CFG.UID, ...data };
  const out = await postJson(`${BASE}/${endpoint}`, `jData=${JSON.stringify(payload)}&jKey=${TOKEN}`);
  if (out?.stat === 'Not_Ok' && /session|invalid.*(token|key)|not logged/i.test(out.emsg || '') && retry) {
    log('Session expired — logging in again');
    await login();
    return api(endpoint, data, false);
  }
  return out;
}

const tsymOf = (symbol) => (symbol.toUpperCase().endsWith('-EQ') ? symbol.toUpperCase() : `${symbol.toUpperCase()}-EQ`);

async function placeOrder({ symbol, side, qty, prctyp, price, trigger, tag }) {
  const desc = `${side} ${qty} ${symbol} ${prctyp} prc=${price ?? '-'} trg=${trigger ?? '-'} [${tag}]`;
  if (CFG.DRY_RUN) { log(`DRY_RUN would place: ${desc}`); return { ok: true, id: `DRY-${tag}-${symbol}-${Date.now()}` }; }
  const body = {
    actid: CFG.UID, exch: 'NSE', tsym: tsymOf(symbol),
    qty: String(qty), prc: String(price ?? 0), prd: 'I', trantype: side === 'BUY' ? 'B' : 'S',
    prctyp, ret: 'DAY', ordersource: 'API', remarks: tag,
  };
  if (trigger != null) body.trgprc = String(trigger);
  const r = await api('PlaceOrder', body);
  if (r?.stat === 'Ok') { log(`PLACED ${desc} -> #${r.norenordno}`); return { ok: true, id: r.norenordno }; }
  log(`REJECTED ${desc} -> ${r?.emsg || JSON.stringify(r)}`);
  return { ok: false, error: r?.emsg };
}

async function cancelOrder(id) {
  if (CFG.DRY_RUN || String(id).startsWith('DRY-')) { log(`DRY_RUN would cancel #${id}`); return true; }
  const r = await api('CancelOrder', { norenordno: id });
  const ok = r?.stat === 'Ok';
  log(ok ? `Cancelled #${id}` : `Cancel #${id} failed: ${r?.emsg || JSON.stringify(r)}`);
  return ok;
}

async function orderBook() {
  const r = await api('OrderBook', {});
  return Array.isArray(r) ? r : null; // null = couldn't fetch (e.g. "no data" when empty returns Not_Ok)
}

async function getAvailableBalance() {
  const r = await api('Limits', { actid: CFG.UID });
  if (r?.stat !== 'Ok') throw new Error(`Limits failed: ${r?.emsg || JSON.stringify(r)}`);
  const n = (v) => Number(v || 0);
  // Noren Limits fields: cash + payin (+ daycash broker leverage) - payout - marginused
  const avail = n(r.cash) + n(r.payin) + n(r.daycash) - n(r.payout) - n(r.marginused);
  log(`Shoonya balance: cash=${r.cash} payin=${r.payin || 0} daycash=${r.daycash || 0} marginused=${r.marginused || 0} → available ₹${fmt(avail)}`);
  return avail;
}

async function getLTP(symbol) {
  try {
    const s = await api('SearchScrips', { exch: 'NSE', stext: tsymOf(symbol) });
    const token = s?.values?.find((v) => v.tsym === tsymOf(symbol))?.token;
    if (!token) return null;
    const q = await api('GetQuotes', { exch: 'NSE', token });
    const lp = Number(q?.lp);
    return Number.isFinite(lp) && lp > 0 ? lp : null;
  } catch { return null; }
}

const isOpen = (o) => ['OPEN', 'PENDING', 'TRIGGER_PENDING'].includes(String(o.status || '').toUpperCase());
const isDone = (o) => String(o.status || '').toUpperCase() === 'COMPLETE';

// ───────────────────────────────── state ───────────────────────────────────────
// Saved to disk so a restart (phone reboot / crash) never re-enters the same signal.
let STATE = { date: '', seen: [], trades: [] };
function loadState(today) {
  try {
    const s = JSON.parse(fs.readFileSync(CFG.STATE_FILE, 'utf8'));
    if (s.date === today) STATE = s;
  } catch { /* fresh */ }
  STATE.date = today;
}
const saveState = () => fs.writeFileSync(CFG.STATE_FILE, JSON.stringify(STATE, null, 2));

// trade = { signalId, symbol, side, qty, entryPrice, entryOrderId, phase, filledQty, avgPrice,
//           targetId, slId, exitSide, targetPrice, slPrice, result }
// phase: ENTRY_PLACED -> (cancel window) -> OCO_ACTIVE -> CLOSED | NO_FILL

// ─────────────────────────── 1. signals → entry orders ─────────────────────────
function passesFilters(sig) {
  if (CFG.SIGNAL !== 'BOTH' && sig.signal !== CFG.SIGNAL) return false;
  const p = Number(sig.priceAtSignal);
  if (!(p >= CFG.MIN_PRICE && p <= CFG.MAX_PRICE)) return false;
  const r = Number(sig.ratio);
  if (!(r >= CFG.MIN_RATIO && r <= CFG.MAX_RATIO)) return false;
  return Number.isFinite(Number(sig.high)) && Number.isFinite(Number(sig.low));
}

async function handleSignal(sig, allocated) {
  if (STATE.trades.length >= CFG.MAX_TRADES) return;
  if (STATE.trades.some((t) => t.symbol === sig.symbol)) return;

  const isBuy = sig.signal === 'BUY';
  const entry = roundTick(isBuy ? sig.high + CFG.ENTRY_PRICE_OFFSET : sig.low - CFG.ENTRY_PRICE_OFFSET);
  const qty = Math.floor(allocated / entry);
  if (qty <= 0) { log(`Skip ${sig.symbol}: ₹${fmt(allocated)} can't buy 1 @ ${entry}`); return; }

  const limit = roundTick(isBuy ? entry + CFG.ENTRY_LIMIT_BUFFER : entry - CFG.ENTRY_LIMIT_BUFFER);
  log(`SIGNAL ${sig.signal} ${sig.symbol} ratio=${fmt(sig.ratio)} price=${sig.priceAtSignal} → entry ${entry} qty ${qty}`);

  const o = await placeOrder({
    symbol: sig.symbol, side: isBuy ? 'BUY' : 'SELL', qty,
    prctyp: 'SL-LMT', price: limit, trigger: entry, tag: 'N15ENTRY',
  });
  if (!o.ok) return;

  STATE.trades.push({
    signalId: String(sig._id), symbol: sig.symbol, side: isBuy ? 'BUY' : 'SELL', qty,
    entryPrice: entry, entryOrderId: o.id, phase: 'ENTRY_PLACED',
  });
  saveState();
}

async function signalLoop(col) {
  const endSecs = toSecs(CFG.CANCEL_TIME);
  const startSecs = toSecs(CFG.ENTRY_START);
  if (STATE.batchDone) { log('Entry batch already placed earlier today — skipping signal scan.'); return; }
  log(`Watching ${CFG.COLLECTION} for ${CFG.SIGNAL} signals. After the first one, waiting ${CFG.COLLECT_MS / 1000}s, then taking top ${CFG.MAX_TRADES} by ratio.`);

  let firstSeenAt = null;
  while (nowIST().secs < endSecs) {
    const { date: today, secs } = nowIST();
    const date = env('TEST_DATE', '') || today; // TEST_DATE=2026-11-18 lets you dry-run on an older day's signals
    if (secs >= startSecs) {
      try {
        const docs = await col
          .find({
            date,
            ...(CFG.SIGNAL !== 'BOTH' ? { signal: CFG.SIGNAL } : {}),
            priceAtSignal: { $gte: CFG.MIN_PRICE, $lte: CFG.MAX_PRICE },
            ratio: { $gte: CFG.MIN_RATIO, $lte: CFG.MAX_RATIO },
          })
          .sort({ ratio: -1 })
          .limit(200)
          .toArray();

        const eligible = docs.filter(passesFilters);
        if (eligible.length && firstSeenAt === null) {
          firstSeenAt = Date.now();
          log(`First signal seen (${eligible.length} so far). Collecting for ${CFG.COLLECT_MS / 1000}s ...`);
        }

        const waited = firstSeenAt ? Date.now() - firstSeenAt : 0;
        const nearDeadline = secs >= endSecs - 10; // never miss the 9:21 cut-off
        if (firstSeenAt && (waited >= CFG.COLLECT_MS || nearDeadline)) {
          // Same as sir's bot: rank by ratio (highest first), top N PER SIDE.
          const picks = [];
          for (const side of ['SELL', 'BUY']) {
            const top = eligible.filter((d) => d.signal === side).slice(0, CFG.MAX_TRADES);
            log(`${side}: ${top.length} signal(s) in final batch`);
            picks.push(...top);
          }
          if (picks.length) {
            // Balance is split EQUALLY across the signals picked in this batch (like sir's bot).
            let pool = null;
            if (CFG.USE_SHOONYA_BALANCE) {
              try { pool = ((await getAvailableBalance()) * CFG.BALANCE_USE_PERCENT / 100) * CFG.LEVERAGE; }
              catch (e) { log('Balance fetch failed:', e.message); }
            }
            const perTrade = pool != null ? pool / picks.length : CFG.CAPITAL_PER_TRADE;
            if (!(perTrade > 0)) {
              log('!! No usable balance / CAPITAL_PER_TRADE — NOT placing any orders.');
            } else {
              log(`Splitting ₹${fmt(perTrade * picks.length)} across ${picks.length} signal(s) → ₹${fmt(perTrade)} each`);
              for (const sig of picks) { STATE.seen.push(String(sig._id)); await handleSignal(sig, perTrade); }
            }
          }
          STATE.batchDone = true;
          saveState();
          return;
        }
      } catch (e) {
        log('Mongo poll error:', e.message);
      }
    }
    await sleep(CFG.POLL_MS);
  }
  log('No signals passed the filters before the cut-off.');
}

// ─────────────────────────── 2. cancel at 09:21 ────────────────────────────────
async function cancelWindow() {
  log('--- CANCEL TIME: cancelling open orders ---');
  if (CFG.DRY_RUN) {
    for (const t of STATE.trades.filter((x) => x.phase === 'ENTRY_PLACED')) await cancelOrder(t.entryOrderId);
  } else {
    const book = await orderBook();
    if (book) {
      const ownIds = new Set(STATE.trades.map((t) => t.entryOrderId));
      for (const o of book.filter(isOpen)) {
        if (CFG.CANCEL_ALL_OPEN || ownIds.has(o.norenordno)) await cancelOrder(o.norenordno);
      }
    } else {
      // order book unreadable → fall back to cancelling our own entries directly
      for (const t of STATE.trades.filter((x) => x.phase === 'ENTRY_PLACED')) await cancelOrder(t.entryOrderId);
    }
  }
}

// ─────────────────────────── 3. OCO exits ──────────────────────────────────────
async function placeOCO() {
  log('--- placing OCO exits for filled entries ---');
  const book = CFG.DRY_RUN ? [] : (await orderBook()) || [];

  for (const t of STATE.trades.filter((x) => x.phase === 'ENTRY_PLACED')) {
    let filled = t.qty, avg = t.entryPrice;
    if (!CFG.DRY_RUN) {
      const o = book.find((b) => b.norenordno === t.entryOrderId);
      filled = Number(o?.fillshares || 0);
      avg = Number(o?.avgprc || 0) || t.entryPrice;
    }
    if (filled <= 0) { t.phase = 'NO_FILL'; log(`${t.symbol}: entry did not fill`); continue; }

    const isBuy = t.side === 'BUY';
    const exitSide = isBuy ? 'SELL' : 'BUY';
    const target = roundTick(avg * (isBuy ? 1 + CFG.TARGET_PERCENT / 100 : 1 - CFG.TARGET_PERCENT / 100));
    const sl = roundTick(avg * (isBuy ? 1 - CFG.STOP_LOSS_PERCENT / 100 : 1 + CFG.STOP_LOSS_PERCENT / 100));
    const slLimit = roundTick(sl * (isBuy ? 1 - CFG.SL_LIMIT_BUFFER_PCT / 100 : 1 + CFG.SL_LIMIT_BUFFER_PCT / 100));

    log(`${t.symbol}: filled ${filled} @ ${fmt(avg)} → target ${target} | SL trigger ${sl} (limit ${slLimit})`);

    const tg = await placeOrder({ symbol: t.symbol, side: exitSide, qty: filled, prctyp: 'LMT', price: target, tag: 'N15TARGET' });
    const sx = await placeOrder({ symbol: t.symbol, side: exitSide, qty: filled, prctyp: 'SL-LMT', price: slLimit, trigger: sl, tag: 'N15SL' });

    // If the stop-loss leg is rejected we MUST NOT leave a naked position — flatten it.
    if (!sx.ok) {
      log(`${t.symbol}: SL leg rejected — closing position at market-ish price for safety`);
      if (tg.ok) await cancelOrder(tg.id);
      await flatten(t.symbol, exitSide, filled);
      t.phase = 'CLOSED'; t.result = 'SL_REJECTED_FLATTENED';
      continue;
    }
    Object.assign(t, {
      phase: 'OCO_ACTIVE', filledQty: filled, avgPrice: avg, exitSide,
      targetPrice: target, slPrice: sl, targetId: tg.ok ? tg.id : null, slId: sx.id,
    });
  }
  saveState();
}

async function flatten(symbol, side, qty) {
  const ltp = (await getLTP(symbol)) ?? 0;
  if (!ltp) { log(`!! ${symbol}: no LTP — CLOSE THIS POSITION MANUALLY`); return; }
  const px = roundTick(side === 'BUY' ? ltp * 1.005 : ltp * 0.995); // marketable limit (Shoonya rejects pure MKT)
  await placeOrder({ symbol, side, qty, prctyp: 'LMT', price: px, tag: 'N15FLAT' });
}

async function ocoMonitor() {
  const sqSecs = toSecs(CFG.SQUAREOFF_TIME);
  log('Monitoring OCO pairs ...');

  while (STATE.trades.some((t) => t.phase === 'OCO_ACTIVE')) {
    const active = STATE.trades.filter((t) => t.phase === 'OCO_ACTIVE');

    // Hard time stop
    if (nowIST().secs >= sqSecs) {
      log('--- SQUARE-OFF TIME: closing everything still open ---');
      for (const t of active) {
        if (t.targetId) await cancelOrder(t.targetId);
        await cancelOrder(t.slId);
        await flatten(t.symbol, t.exitSide, t.filledQty);
        t.phase = 'CLOSED'; t.result = 'TIME_SQUAREOFF';
      }
      saveState();
      break;
    }

    if (CFG.DRY_RUN) { log('DRY_RUN: OCO monitor skipped (no real orders)'); active.forEach((t) => (t.phase = 'CLOSED')); break; }

    const book = await orderBook();
    if (book) {
      for (const t of active) {
        const tg = t.targetId ? book.find((b) => b.norenordno === t.targetId) : null;
        const sl = book.find((b) => b.norenordno === t.slId);
        const tgFill = Number(tg?.fillshares || 0);
        const slFill = Number(sl?.fillshares || 0);

        if (tgFill > 0 || (tg && isDone(tg))) {
          log(`🎯 ${t.symbol}: TARGET hit → cancelling SL`);
          if (sl && isOpen(sl)) await cancelOrder(t.slId);
          t.phase = 'CLOSED'; t.result = 'TARGET';
        } else if (slFill > 0 || (sl && isDone(sl))) {
          log(`🛑 ${t.symbol}: STOP-LOSS hit → cancelling target`);
          if (tg && isOpen(tg)) await cancelOrder(t.targetId);
          t.phase = 'CLOSED'; t.result = 'STOPLOSS';
        } else if (sl && String(sl.status).toUpperCase() === 'REJECTED') {
          log(`!! ${t.symbol}: SL order REJECTED by exchange — flattening`);
          if (tg && isOpen(tg)) await cancelOrder(t.targetId);
          await flatten(t.symbol, t.exitSide, t.filledQty);
          t.phase = 'CLOSED'; t.result = 'SL_REJECTED_FLATTENED';
        } else if (!sl || (!isOpen(sl) && tg && !isOpen(tg))) {
          // both legs gone with no fill (manually cancelled?) — stop tracking, warn.
          log(`?? ${t.symbol}: both exit legs are gone without a fill — check position manually`);
          t.phase = 'CLOSED'; t.result = 'LEGS_GONE';
        }
      }
      saveState();
    }
    await sleep(CFG.OCO_POLL_MS);
  }
}

// ─────────────────────────────────── main ──────────────────────────────────────
// ─────────────────── PREVIEW MODE (outside market hours) ───────────────────────
// Runs when started after CANCEL_TIME, on a weekend, or with PREVIEW=true.
// Only READS: shows today's signals and what the script WOULD do. Never places orders.
async function previewMode(col) {
  const { date: today } = nowIST();
  let date = env('TEST_DATE', '') || today;
  let docs = await col.find({ date }).sort({ ratio: -1 }).limit(500).toArray();
  log(`PREVIEW MODE — market closed, NO orders will be placed. Signals dated ${date}: ${docs.length} total`);
  if (!docs.length) { log(`No signals for ${date} yet.`); return; }

  const eligible = docs.filter(passesFilters);
  const picks = [];
  for (const side of ['SELL', 'BUY']) {
    if (CFG.SIGNAL !== 'BOTH' && CFG.SIGNAL !== side) continue;
    picks.push(...eligible.filter((d) => d.signal === side).slice(0, CFG.MAX_TRADES));
  }
  log(`${eligible.length} pass your filters (${CFG.SIGNAL}, ₹${CFG.MIN_PRICE}-${CFG.MAX_PRICE}, ratio ${CFG.MIN_RATIO}-${CFG.MAX_RATIO}); top ${picks.length} would be traded`);

  let perTrade = CFG.CAPITAL_PER_TRADE;
  if (CFG.USE_SHOONYA_BALANCE && picks.length && bool('PREVIEW_QTY', false)) {
    try { perTrade = ((await getAvailableBalance()) * CFG.BALANCE_USE_PERCENT / 100) * CFG.LEVERAGE / picks.length; }
    catch (e) { log('Balance unavailable now (', e.message, ') — quantities not shown'); perTrade = 0; }
  }

  console.log('');
  console.table(picks.map((d, i) => {
    const isBuy = d.signal === 'BUY';
    const entry = roundTick(isBuy ? d.high + CFG.ENTRY_PRICE_OFFSET : d.low - CFG.ENTRY_PRICE_OFFSET);
    return {
      '#': i + 1, symbol: d.symbol, side: d.signal, ratio: Number(d.ratio).toFixed(2), price: d.priceAtSignal,
      entry, qty: perTrade > 0 ? Math.floor(perTrade / entry) : '-',
      target: roundTick(entry * (isBuy ? 1 + CFG.TARGET_PERCENT / 100 : 1 - CFG.TARGET_PERCENT / 100)),
      stopLoss: roundTick(entry * (isBuy ? 1 - CFG.STOP_LOSS_PERCENT / 100 : 1 + CFG.STOP_LOSS_PERCENT / 100)),
    };
  }));
}

const isWeekend = () => [0, 6].includes(new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })).getDay());
const previewWanted = () => bool('PREVIEW', false); // time/weekend safety REMOVED

async function main() {
  log(`nine15-copy starting | DRY_RUN=${CFG.DRY_RUN} | side=${CFG.SIGNAL} | balance=${CFG.USE_SHOONYA_BALANCE ? 'from Shoonya' : '₹' + CFG.CAPITAL_PER_TRADE + '/trade'} | top ${CFG.MAX_TRADES}/side`);
  if (!CFG.MONGODB_URL) throw new Error('MONGODB_URL is missing');

  const { date } = nowIST();
  loadState(date);

  const preview = previewWanted() && !env('TEST_DATE', '');
  if (!preview || bool('PREVIEW_QTY', false)) {
    try { await login(); }
    catch (e) { if (!preview) throw e; log('Login failed (', e.message, ') — continuing in preview'); }
  }

  const mongo = new MongoClient(CFG.MONGODB_URL, { serverSelectionTimeoutMS: 10000 });
  await mongo.connect();
  const col = mongo.db(CFG.DB_NAME).collection(CFG.COLLECTION);
  log('MongoDB connected');

  if (preview) { await previewMode(col); await mongo.close(); return; }

  // Wait for entry start
  while (nowIST().secs < toSecs(CFG.ENTRY_START)) await sleep(500);

  if (nowIST().secs < toSecs(CFG.CANCEL_TIME)) await signalLoop(col);
  await mongo.close();

  if (STATE.trades.some((t) => t.phase === 'ENTRY_PLACED')) {
    await cancelWindow();
    await sleep(1500); // let the exchange settle cancels/partial fills
    await placeOCO();
  }
  await ocoMonitor();

  log('===== DAY SUMMARY =====');
  for (const t of STATE.trades) log(`${t.symbol} ${t.side} qty=${t.filledQty ?? 0} → ${t.result || t.phase}`);
  log('Done.');
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });

/* ───────────────────────── .env TEMPLATE (copy to a file named .env) ─────────────
MONGODB_URL=mongodb+srv://USER:PASS@cluster/...      # read-only user is enough
DB_NAME=tradebot

SHOONYA_UID=FAxxxxx
SHOONYA_PASSWORD=xxxx
SHOONYA_TOTP_SECRET=XXXXXXXXXXXXXXXX
SHOONYA_API_KEY=xxxx
SHOONYA_CLIENT_ID=xxxx
SHOONYA_SECRET_CODE=xxxx

USE_SHOONYA_BALANCE=true
BALANCE_USE_PERCENT=90
LEVERAGE=1          # multiplier on balance, e.g. 5 = 5x (MIS leverage)
MAX_TRADES=10
DRY_RUN=true
*/
