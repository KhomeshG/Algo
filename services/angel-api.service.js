import { createHmac } from 'crypto';
import { getCredentialsOrEnv } from '../utilities/config-cache.js';
import fetch from 'node-fetch'; // need to install this or use native fetch if node 18+
import { logger } from '../utilities/logger.js';

// Angel One API Base URL
const ANGEL_BASE_URL = 'https://apiconnect.angelone.in';

const angelCache = {
  jwtToken: null,
  tokenExpiry: 0,
};

export const generateTOTP = () => {
  const credentials = getCredentialsOrEnv();
  const totpSecret = credentials.totpSecret;

  if (!totpSecret) {
    throw new Error('TOTP secret is not configured');
  }
  
  // Decode base32 secret
  const base32chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (let i = 0; i < totpSecret.length; i++) {
    const val = base32chars.indexOf(totpSecret.charAt(i).toUpperCase());
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  
  const secret = Buffer.alloc(Math.floor(bits.length / 8));
  for (let i = 0; i < secret.length; i++) {
    secret[i] = parseInt(bits.substr(i * 8, 8), 2);
  }
  
  // Generate TOTP
  const epoch = Math.floor(Date.now() / 1000);
  const counter = Math.floor(epoch / 30);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigInt64BE(BigInt(counter));
  
  const hmac = createHmac('sha1', secret);
  hmac.update(counterBuffer);
  const hmacResult = hmac.digest();
  
  const offset = hmacResult[hmacResult.length - 1] & 0x0f;
  const code = (
    ((hmacResult[offset] & 0x7f) << 24) |
    ((hmacResult[offset + 1] & 0xff) << 16) |
    ((hmacResult[offset + 2] & 0xff) << 8) |
    (hmacResult[offset + 3] & 0xff)
  );
  
  const totp = (code % 1000000).toString().padStart(6, '0');
  return totp;
};

// Retry with exponential backoff for rate limiting
export const fetchWithRetry = async (url, options, maxRetries = 3) => {
  let lastError = null;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      
      // Check if rate limited (429)
      if (response.status === 429 && attempt < maxRetries) {
        const waitTime = Math.pow(2, attempt) * 1000; // Exponential backoff: 1s, 2s, 4s
        logger.info(`[Angel API] Rate limited, retrying in ${waitTime}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }
      
      return response;
    } catch (error) {
      lastError = error;
      
      if (attempt < maxRetries) {
        const waitTime = Math.pow(2, attempt) * 1000;
        logger.info(`[Angel API] Request failed, retrying in ${waitTime}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  
  throw lastError || new Error('Max retries exceeded');
};

// Login and get JWT token with caching
export const getJWTToken = async (forceRefresh = false) => {
  // Return cached token if valid
  if (!forceRefresh && angelCache.jwtToken && Date.now() < angelCache.tokenExpiry) {
    logger.info('[Angel API] Using cached JWT token');
    return angelCache.jwtToken;
  }

  logger.info('[Angel API] Generating new JWT token');
  
  const credentials = getCredentialsOrEnv();
  const totpToken = generateTOTP();

  try {
    const response = await fetchWithRetry(`${ANGEL_BASE_URL}/rest/auth/angelbroking/user/v1/loginByPassword`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-UserType': 'USER',
        'X-SourceID': 'WEB',
        'X-ClientLocalIP': '127.0.0.1',
        'X-ClientPublicIP': '127.0.0.1',
        'X-MACAddress': '00:00:00:00:00:00',
        'X-PrivateKey': credentials.apiKey,
      },
      body: JSON.stringify({
        clientcode: credentials.clientId,
        password: credentials.mpin,
        totp: totpToken,
      }),
    });

    const data = await response.json();

    if (data?.data?.jwtToken) {
      angelCache.jwtToken = data.data.jwtToken;
      angelCache.tokenExpiry = Date.now() + 23 * 60 * 60 * 1000;
      
      logger.info('[Angel API] JWT token generated and cached successfully');
      return angelCache.jwtToken;
    } else {
      throw new Error(data?.message || 'Failed to generate JWT token');
    }
  } catch (error) {
    logger.error('[Angel API] Login error:', error.message);
    throw new Error(`Authentication failed: ${error.message}`);
  }
};

// Standard headers builder used by every secure Angel One call below.
const buildAuthHeaders = (jwtToken, credentials) => ({
  'Authorization': `Bearer ${jwtToken}`,
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'X-UserType': 'USER',
  'X-SourceID': 'WEB',
  'X-ClientLocalIP': '127.0.0.1',
  'X-ClientPublicIP': '127.0.0.1',
  'X-MACAddress': '00:00:00:00:00:00',
  'X-PrivateKey': credentials.apiKey,
});

// ─── Order Placement ────────────────────────────────────────────────────────

/**
 * Place an order via Angel One's SmartAPI.
 * https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/placeOrder
 *
 * @param {object} payload - Angel One order payload (variety, tradingsymbol,
 *   symboltoken, transactiontype, exchange, ordertype, producttype,
 *   duration, price, triggerprice, quantity, ...)
 * @returns {Promise<{status:boolean, message?:string, data?:object}>}
 */
export const placeAngelOrder = async (payload) => {
  const credentials = getCredentialsOrEnv();
  const jwtToken = await getJWTToken();

  try {
    const response = await fetchWithRetry(`${ANGEL_BASE_URL}/rest/secure/angelbroking/order/v1/placeOrder`, {
      method: 'POST',
      headers: buildAuthHeaders(jwtToken, credentials),
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    return data;
  } catch (error) {
    logger.error('[Angel API] placeOrder error:', error.message);
    throw error;
  }
};

/**
 * Modify an existing open order (used by the trailing SL engine).
 * https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/modifyOrder
 */
export const modifyAngelOrder = async (payload) => {
  const credentials = getCredentialsOrEnv();
  const jwtToken = await getJWTToken();

  try {
    const response = await fetchWithRetry(`${ANGEL_BASE_URL}/rest/secure/angelbroking/order/v1/modifyOrder`, {
      method: 'POST',
      headers: buildAuthHeaders(jwtToken, credentials),
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    return data;
  } catch (error) {
    logger.error('[Angel API] modifyOrder error:', error.message);
    throw error;
  }
};

/**
 * Cancel an open order.
 * https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/cancelOrder
 */
export const cancelAngelOrder = async ({ variety = 'NORMAL', orderid }) => {
  const credentials = getCredentialsOrEnv();
  const jwtToken = await getJWTToken();

  try {
    const response = await fetchWithRetry(`${ANGEL_BASE_URL}/rest/secure/angelbroking/order/v1/cancelOrder`, {
      method: 'POST',
      headers: buildAuthHeaders(jwtToken, credentials),
      body: JSON.stringify({ variety, orderid }),
    });

    const data = await response.json();
    return data;
  } catch (error) {
    logger.error('[Angel API] cancelOrder error:', error.message);
    throw error;
  }
};

/**
 * Fetch the live LTP for a single symbol/token — used as a pre-order
 * sanity check (e.g. slippage guard) before placing an entry order.
 * https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/quote
 * @param {string} symboltoken
 * @param {string} [exchange]
 * @returns {Promise<number|null>}
 */
export const getQuoteLTP = async (symboltoken, exchange = 'NSE') => {
  const credentials = getCredentialsOrEnv();
  const jwtToken = await getJWTToken();

  try {
    const response = await fetchWithRetry(`${ANGEL_BASE_URL}/rest/secure/angelbroking/market/v1/quote`, {
      method: 'POST',
      headers: buildAuthHeaders(jwtToken, credentials),
      body: JSON.stringify({
        mode: 'LTP',
        exchangeTokens: { [exchange.toUpperCase()]: [symboltoken] },
      }),
    });

    const data = await response.json();
    const fetched = data?.data?.fetched;
    if (Array.isArray(fetched) && fetched.length > 0) {
      const ltp = parseFloat(fetched[0].ltp);
      return Number.isFinite(ltp) && ltp > 0 ? ltp : null;
    }
    return null;
  } catch (error) {
    logger.error('[Angel API] getQuoteLTP error:', error.message);
    return null;
  }
};

/**
 * Fetch the order book (all orders placed today, with their live status).
 * https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/getOrderBook
 */
export const getAngelOrderBook = async () => {
  const credentials = getCredentialsOrEnv();
  const jwtToken = await getJWTToken();

  try {
    const response = await fetchWithRetry(`${ANGEL_BASE_URL}/rest/secure/angelbroking/order/v1/getOrderBook`, {
      method: 'GET',
      headers: buildAuthHeaders(jwtToken, credentials),
    });

    const data = await response.json();
    return data;
  } catch (error) {
    logger.error('[Angel API] getOrderBook error:', error.message);
    throw error;
  }
};

/**
 * Fetch current positions (RMS position book).
 * https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/getPosition
 */
export const getAngelPositions = async () => {
  const credentials = getCredentialsOrEnv();
  const jwtToken = await getJWTToken();

  try {
    const response = await fetchWithRetry(`${ANGEL_BASE_URL}/rest/secure/angelbroking/order/v1/getPosition`, {
      method: 'GET',
      headers: buildAuthHeaders(jwtToken, credentials),
    });

    const data = await response.json();
    return data;
  } catch (error) {
    logger.error('[Angel API] getPosition error:', error.message);
    throw error;
  }
};

export const fetchOrders = async (jwtToken, startDate, endDate) => {
  const credentials = getCredentialsOrEnv();
  
  const headers = {
    'Authorization': `Bearer ${jwtToken}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': '127.0.0.1',
    'X-ClientPublicIP': '127.0.0.1',
    'X-MACAddress': '00:00:00:00:00:00',
    'X-PrivateKey': credentials.apiKey,
  };

  try {
    const response = await fetchWithRetry(`${ANGEL_BASE_URL}/rest/secure/angelbroking/order/v1/getOrderBook`, {
      method: 'GET',
      headers,
    });

    const data = await response.json();
    return data?.data || [];
  } catch (error) {
    logger.error('[Angel API Orders] Data fetch error:', error.message);
    throw error;
  }
};