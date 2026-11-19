import fetch from 'node-fetch';
import crypto from 'crypto';
import { getShoonyaToken, setShoonyaToken, getShoonyaCredentialsOrEnv } from '../utilities/config-cache.js';
import { shoonyaLogin } from '../utilities/shoony-auth.js';
import { logger } from '../utilities/logger.js';
import { alertLoginFailed } from './alert-service.js';
import { isPrimaryAccount, normalizeAccountId, getAccountCredsFromEnv } from '../src/config/accounts.js';

// ── Multi-account support ────────────────────────────────────────────────
// Every exported function takes an OPTIONAL trailing `accountId` ('ACC1' | 'ACC2' | 'ACC3').
// Omitted / 'ACC1' = the primary account, exactly as before (config-cache token + creds).
// ACC2/ACC3 keep their OWN token, login lock and credentials, so one account's login or
// session expiry can never disturb another account's session.
const _otherTokens = new Map();     // accountId -> susertoken  (non-primary accounts)
const _inflight = new Map();        // accountId -> in-flight login promise (single-flight PER ACCOUNT)
const _blockedUntil = new Map();   // accountId -> epoch ms; credential/lock errors must NOT be retried
const BLOCK_COOLDOWN_MS = 30 * 60 * 1000;
const isFatalLoginError = (msg = '') => /blocked|wrong attempt|invalid (user|password|totp|input)|locked|disabled|incorrect|invalid.*(otp|totp|credential)/i.test(msg);
const credsFor = (accountId) => (isPrimaryAccount(accountId) ? getShoonyaCredentialsOrEnv() : getAccountCredsFromEnv(accountId));
const tokenFor = (accountId) => (isPrimaryAccount(accountId) ? getShoonyaToken() : _otherTokens.get(normalizeAccountId(accountId)));
const storeToken = (accountId, t) => (isPrimaryAccount(accountId) ? setShoonyaToken(t) : _otherTokens.set(normalizeAccountId(accountId), t));

/**
 * Ensures a valid Shoonya session token (susertoken) exists and returns it.
 * Automatically performs quickauth if not logged in.
 * @param {boolean} forceRefresh - If true, ignores cached token and performs fresh login
 * @returns {Promise<string>} The active susertoken
 */
// ─────────────────────────────────────────────────────────────────────────
// Single-flight login lock.
//
// BUG THIS FIXES: at least 4 independent places in this codebase (the
// trading socket, the candle-backfill worker, order placement, and the
// dashboard controller) can each call getActiveShoonyaToken() on their own
// schedule. With no coordination, if the token is missing/expired at the
// same moment for more than one of them (very likely during Shoonya's own
// pre-open maintenance window), EACH caller independently started its own
// full 10-attempt, ~8-9 minute retry marathon and its own login request to
// Shoonya — worsening a real outage with multiple parallel login attempts,
// and (since a NEW login invalidates the account's PREVIOUS session token)
// letting one worker's fresh login silently kick another worker's
// in-flight session out from under it mid-request.
//
// Confirmed symptom: two "Login Failed" emails 1 minute apart (5:38/5:39,
// then again 6:08/6:09) — two separate retry loops that happened to start
// ~1 minute apart both finishing their identical backoff schedule ~1 minute
// apart. A single alert per real outage should only ever be possible if
// there's only ONE retry loop running at a time.
//
// Fix: every caller now shares the SAME in-flight login promise instead of
// starting its own. The first caller to find no valid token kicks off the
// retry loop; every other caller that asks while it's running just awaits
// that same promise and gets the same result — success or failure — rather
// than racing it with a competing login.
// ─────────────────────────────────────────────────────────────────────────
export const getActiveShoonyaToken = async (forceRefresh = false, accountId) => {
  const accKey = normalizeAccountId(accountId);
  let token = tokenFor(accountId);
  if (token && !forceRefresh) {
    return token;
  }

  // Someone else is already logging in (or already retrying through an
  // outage) — piggyback on that single attempt instead of starting a
  // second, competing one. This applies even when THIS caller wanted
  // forceRefresh: a login that's already in flight will produce an equally
  // fresh token, and starting a second concurrent login would just risk
  // invalidating the first one's session right as it completes.
  if (_inflight.has(accKey)) {
    logger.info(`[Shoonya API][${accKey}] Login already in progress elsewhere — waiting for it instead of starting a second one.`);
    return _inflight.get(accKey);
  }

  const until = _blockedUntil.get(accKey) || 0;
  if (Date.now() < until) {
    throw new Error(`[Shoonya][${accKey}] Login suspended for ${Math.ceil((until - Date.now()) / 60000)} more min (account blocked / bad credentials). Fix Shoonya credentials or unblock the account, then restart.`);
  }

  const p = performShoonyaLoginWithRetries(accountId)
    .finally(() => { _inflight.delete(accKey); });
  _inflight.set(accKey, p);
  return p;
};

async function performShoonyaLoginWithRetries(accountId) {
  const accKey = normalizeAccountId(accountId);
  logger.info(`[Shoonya API][${accKey}] Session token not cached or expired. Initiating automatic login...`);
  const creds = credsFor(accountId);
  // console.log('[Shoonya API] Retrieved credentials for auto-login', creds);
  if (!creds || !creds.uid || !creds.password || !creds.totp || !creds.apiKey || !creds.clientId) {
    throw new Error('Shoonya credentials are not configured. Please supply them via environment variables or setup endpoint.');
  }

  // Retry settings: Shoonya's API is known to be briefly unavailable right
  // around market pre-open (6-9 AM IST) during their own maintenance
  // restarts — that window can run longer than a couple of minutes. The
  // old settings (5 attempts, 20s apart = 80s total) gave up well before
  // a typical maintenance window ends, causing false "Login Failed" alerts
  // for a transient issue that would've resolved on its own shortly after.
  //
  // Now: more attempts, with the delay backing off (20s -> 30s -> 45s ...,
  // capped at 60s) instead of a fixed interval — spreads attempts across
  // roughly 8-9 minutes total without hammering Shoonya's servers with a
  // tight retry loop while they're already struggling.
  // An email alert is only sent if ALL attempts fail — not on every single try.
  const MAX_ATTEMPTS = 10;
  const BASE_RETRY_DELAY_MS = 20000;
  const MAX_RETRY_DELAY_MS = 60000;
  let lastErr;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await shoonyaLogin({
        uid: creds.uid,
        password: creds.password,
        totp: creds.totp,
        apiKey: creds.apiKey,
        clientId: creds.clientId,
        imei: crypto.randomUUID(),
        userAgent: 'vgt-trade-bot-oms',
        secretCode: creds.secretCode
      });

      // console.log('[Shoonya API] Login response received', response);
      if (response && response.tokenData && response.tokenData.stat === 'Ok') {
        const susertoken = response.tokenData.susertoken;
        storeToken(accountId, susertoken);
        logger.info(`[Shoonya API][${accKey}] Auto-login successful. Cached new susertoken.`);
        return susertoken;
      } else {
        throw new Error(response?.emsg || 'Shoonya auth request failed');
      }
    } catch (err) {
      lastErr = err;
      logger.error(`[Shoonya API Login] Attempt ${attempt}/${MAX_ATTEMPTS} failed:`, err.message);
      if (isFatalLoginError(err.message)) {
        // Retrying a blocked account / wrong credential only adds more wrong attempts.
        _blockedUntil.set(accKey, Date.now() + BLOCK_COOLDOWN_MS);
        logger.error(`[Shoonya][${accKey}] Fatal credential/lock error — NOT retrying. Cooling down 30 min.`);
        alertLoginFailed(isPrimaryAccount(accountId) ? 'Shoonya' : `Shoonya ${accKey}`, err, { 'Attempts made': String(attempt), Note: 'Fatal, no retry' });
        throw err;
      }
      if (attempt < MAX_ATTEMPTS) {
        const delay = Math.min(BASE_RETRY_DELAY_MS * 1.5 ** (attempt - 1), MAX_RETRY_DELAY_MS);
        logger.info(`[Shoonya API Login] Retrying in ${Math.round(delay / 1000)}s...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  // All attempts failed — send exactly one alert email now.
  logger.error('[Shoonya API Login] All retry attempts failed. Sending alert email.');
  alertLoginFailed(isPrimaryAccount(accountId) ? 'Shoonya' : `Shoonya ${accKey}`, lastErr, { 'Attempts made': String(MAX_ATTEMPTS) });
  throw lastErr;
}

/**
 * Generic fetch request helper to call Shoonya REST endpoints
 * @param {string} endpoint - The target endpoint path (e.g. PlaceOrder)
 * @param {object} payload - The request parameters
 * @returns {Promise<object>} Parsed JSON response
 */
export const fetchShoonya = async (endpoint, payload, accountId) => {
  const token = await getActiveShoonyaToken(false, accountId);
  if (!token) {
    throw new Error('Authentication token is missing. Shoonya REST API cannot be called.');
  }

  const url = `https://api.shoonya.com/NorenWClientAPI/${endpoint}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: `jData=${JSON.stringify(payload)}&jKey=${token}`
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (parseErr) {
      logger.error(`[Shoonya API fetch] Response JSON parse failed for ${endpoint}: ${text}`);
      throw new Error(`Invalid JSON response received from ${endpoint}`);
    }

    // Noren API standard failure check
    if (data && data.stat === 'Not_Ok') {
      // If token is invalid or expired (e.g., session expired), retry once with fresh login
      if (data.emsg && /session|jkey|not logged|user not login|token (expired|invalid)/i.test(data.emsg)) {
        logger.warn('[Shoonya API] Session invalid or expired. Retrying with fresh login...');
        // If another caller already refreshed the token, reuse it — don't force yet
        // another login (each new login invalidates the previous session).
        const latest = tokenFor(accountId);
        const freshToken = (latest && latest !== token) ? latest : await getActiveShoonyaToken(true, accountId);

        const retryResponse = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: `jData=${JSON.stringify(payload)}&jKey=${freshToken}`
        });

        // Same non-JSON-response protection as the initial request below —
        // a naive .json() here would throw the same cryptic
        // "Unexpected token '<'" if the retried call also hits an HTML
        // error page instead of Shoonya's actual API response.
        const retryText = await retryResponse.text();
        try {
          return JSON.parse(retryText);
        } catch (parseErr) {
          logger.error(`[Shoonya API fetch] Retry response JSON parse failed for ${endpoint} (HTTP ${retryResponse.status}): ${retryText.slice(0, 300)}`);
          throw new Error(`Shoonya returned a non-JSON response on retry for ${endpoint} (HTTP ${retryResponse.status}) — broker API/gateway likely unavailable.`);
        }
      }
    }

    return data;
  } catch (error) {
    logger.error(`[Shoonya API fetch] Request error for ${endpoint}:`, error.message);
    throw error;
  }
};

/**
 * Places an entry/exit/regular order on Shoonya
 * @param {object} orderData - Order parameters
 * @returns {Promise<object>} The broker order response
 */
export const placeShoonyaOrder = async (orderData, accountId) => {
  const creds = credsFor(accountId);
  const payload = {
    uid: creds.uid,
    actid: creds.uid,
    ...orderData
  };
  return fetchShoonya('PlaceOrder', payload, accountId);
};

/**
 * Cancels an outstanding open order
 * @param {string} brokerOrderId - Noren order number
 * @returns {Promise<object>} The cancellation response
 */
export const cancelShoonyaOrder = async (brokerOrderId, accountId) => {
  const creds = credsFor(accountId);
  const payload = {
    uid: creds.uid,
    norenordno: brokerOrderId
  };
  return fetchShoonya('CancelOrder', payload, accountId);
};

/**
 * Modifies an open limit/stoploss order
 * @param {object} orderData - Parameters to modify including brokerOrderId
 * @returns {Promise<object>} The modification response
 */
export const modifyShoonyaOrder = async (orderData, accountId) => {
  const creds = credsFor(accountId);
  const payload = {
    uid: creds.uid,
    ...orderData
  };
  return fetchShoonya('ModifyOrder', payload, accountId);
};

/**
 * Fetches account margin/funds info (Noren "Limits" endpoint) — cash
 * available, margin used, etc. Used by the dashboard's Margins panel.
 * @returns {Promise<object>} Limits response
 */
export const getShoonyaLimits = async (accountId) => {
  const creds = credsFor(accountId);
  const payload = {
    uid: creds.uid,
    actid: creds.uid
  };
  return fetchShoonya('Limits', payload, accountId);
};

/**
 * Fetches the entire order book for the logged in user
 * @returns {Promise<Array|object>} Order list
 */
export const getShoonyaOrderBook = async (accountId) => {
  const creds = credsFor(accountId);
  const payload = {
    uid: creds.uid
  };
  return fetchShoonya('OrderBook', payload, accountId);
};

/**
 * Fetches active positions for the logged in user
 * @returns {Promise<Array|object>} Position details
 */
export const getShoonyaPositions = async (accountId) => {
  const creds = credsFor(accountId);
  const payload = {
    uid: creds.uid,
    actid: creds.uid
  }; 
  return fetchShoonya('PositionBook', payload, accountId);
};

/**
 * Fetches the actual executed fills (trade book) for the logged in user —
 * this is the broker's own record of what filled, independent of anything
 * our local websocket/DB thinks happened. Each entry has fields like
 * tsym, trantype (B/S), flqty, flprc, norenordno, fltime.
 * @returns {Promise<Array|object>} Trade/fill list
 */
export const getShoonyaTradeBook = async (accountId) => {
  const creds = credsFor(accountId);
  const payload = {
    uid: creds.uid,
    actid: creds.uid
  };
  return fetchShoonya('TradeBook', payload, accountId);
};

/**
 * Resolves a trading symbol (e.g. "RELIANCE-EQ") to its Shoonya scrip
 * token via SearchScrip. Needed because GetQuotes takes a numeric
 * `token`, not the trading symbol string.
 * @param {string} exch - e.g. 'NSE'
 * @param {string} tsym - Shoonya trading symbol, e.g. 'RELIANCE-EQ'
 * @returns {Promise<string|null>} scrip token, or null if not found
 */
export const searchShoonyaScrip = async (exch, tsym, accountId) => {
  const creds = credsFor(accountId);
  const payload = {
    uid: creds.uid,
    exch,
    stext: tsym
  };
  const result = await fetchShoonya('SearchScrip', payload, accountId);
  if (!result || result.stat !== 'Ok' || !Array.isArray(result.values)) {
    return null;
  }
  // Prefer an exact trading-symbol match; fall back to the first hit.
  const exact = result.values.find(v => v.tsym === tsym);
  return (exact ?? result.values[0])?.token ?? null;
};

/**
 * Fetches the current live quote (including LTP) for a scrip token.
 * @param {string} exch - e.g. 'NSE'
 * @param {string} token - numeric scrip token from searchShoonyaScrip
 * @returns {Promise<object|null>} raw GetQuotes response, or null on failure
 */
export const getShoonyaQuote = async (exch, token, accountId) => {
  const creds = credsFor(accountId);
  const payload = {
    uid: creds.uid,
    exch,
    token
  };
  const result = await fetchShoonya('GetQuotes', payload, accountId);
  if (!result || result.stat !== 'Ok') {
    return null;
  }
  return result;
};