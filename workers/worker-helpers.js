/**
 * Shared Worker Helpers
 */

import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { MongoClient } from 'mongodb';
import { createHmac } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import dns from 'dns';
import { shoonyaLogin } from '../utilities/shoony-auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../.env') });

if (process.env.MONGODB_URL && process.env.MONGODB_URL.startsWith("mongodb+srv://")) {
  try {
    dns.setServers(["8.8.8.8", "8.8.4.4"]);
  } catch (err) {
    console.warn("Failed to set DNS servers:", err.message);
  }
}

// ============== CONFIG ==============

const MONGODB_URL = process.env.MONGODB_URL || '';
const DB_NAME = process.env.DB_NAME || 'tradebot';
const ANGEL_BASE_URL = 'https://apiconnect.angelone.in';

// Path where Shoonya session is persisted across runs
const SHOONYA_SESSION_FILE = resolve(__dirname, '../shoonya-session.json');

// ============== STATE ==============

let mongoClient = null;
let database = null;
let jwtToken = null;
let feedToken = null;
let jwtExpiry = 0;

// ============== CREDENTIALS ==============

export const getCredentials = () => ({
  apiKey: process.env.ANGEL_API_KEY || '',
  clientId: process.env.ANGEL_CLIENT_ID || '',
  secretKey: process.env.ANGEL_SECRET_KEY || '',
  totpSecret: process.env.ANGEL_TOTP_SECRET || '',
  mpin: process.env.ANGEL_MPIN || '',
});

export const getShoonyaCredentials = () => ({
  uid: process.env.SHOONYA_UID || '',
  password: process.env.SHOONYA_PASSWORD || '',
  totp: process.env.SHOONYA_TOTP_SECRET || '',
  apiKey: process.env.SHOONYA_API_KEY || '',
  clientId: process.env.SHOONYA_CLIENT_ID || '',
  imei: process.env.SHOONYA_IMEI || 'abc1234',
  userAgent: process.env.SHOONYA_USER_AGENT || 'Mozilla/5.0',
  secretCode: process.env.SHOONYA_SECRET_CODE || '',
});

// ============== DATABASE ==============

export const connectToDatabase = async () => {
  if (database) return { db: database, client: mongoClient };
  mongoClient = new MongoClient(MONGODB_URL);
  await mongoClient.connect();
  database = mongoClient.db(DB_NAME);
  console.log('[Worker] Connected to MongoDB');
  return { db: database, client: mongoClient };
};

// ============== TOTP (Angel One) ==============

export const generateTOTP = () => {
  const { totpSecret } = getCredentials();
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
  const counter = Math.floor(Math.floor(Date.now() / 1000) / 30);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', secret);
  hmac.update(counterBuffer);
  const hmacResult = hmac.digest();
  const offset = hmacResult[hmacResult.length - 1] & 0x0f;
  const code =
    ((hmacResult[offset] & 0x7f) << 24) |
    ((hmacResult[offset + 1] & 0xff) << 16) |
    ((hmacResult[offset + 2] & 0xff) << 8) |
    (hmacResult[offset + 3] & 0xff);
  return (code % 1000000).toString().padStart(6, '0');
};

// ============== ANGEL ONE AUTH ==============

export const getAngelHeaders = (credentials) => ({
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'X-UserType': 'USER',
  'X-SourceID': 'WEB',
  'X-ClientLocalIP': '127.0.0.1',
  'X-ClientPublicIP': '127.0.0.1',
  'X-MACAddress': '00:00:00:00:00:00',
  'X-PrivateKey': credentials.apiKey,
});

export const getJWTToken = async () => {
  if (jwtToken && Date.now() < jwtExpiry) return jwtToken;
  const credentials = getCredentials();
  const response = await fetch(`${ANGEL_BASE_URL}/rest/auth/angelbroking/user/v1/loginByPassword`, {
    method: 'POST',
    headers: getAngelHeaders(credentials),
    body: JSON.stringify({
      clientcode: credentials.clientId,
      password: credentials.mpin,
      totp: generateTOTP(),
    }),
  });
  const data = await response.json();
  if (data?.data?.jwtToken) {
    jwtToken = data.data.jwtToken;
    feedToken = data.data.feedToken || '';
    jwtExpiry = Date.now() + 23 * 60 * 60 * 1000;
    console.log('[Worker] Authenticated with Angel One');
    return jwtToken;
  }
  throw new Error(data?.message || 'Failed to authenticate with Angel One');
};

export const getFeedToken = async () => {
  if (!feedToken) await getJWTToken();
  return feedToken;
};

export const getAuthHeaders = async () => {
  const credentials = getCredentials();
  const token = await getJWTToken();
  return { ...getAngelHeaders(credentials), Authorization: `Bearer ${token}` };
};

// ============== SHOONYA SESSION (file-persisted) ==============

/**
 * Reads the persisted session from shoonya-session.json.
 * Returns null if file missing or session expired.
 */
const readPersistedSession = () => {
  try {
    if (!existsSync(SHOONYA_SESSION_FILE)) return null;
    const raw = readFileSync(SHOONYA_SESSION_FILE, 'utf-8');
    const session = JSON.parse(raw);
    // Session valid if expiry hasn't passed
    if (session?.expiry && Date.now() < session.expiry) {
      return session; // { uid, jKey, expiry }
    }
    return null; // expired
  } catch {
    return null;
  }
};

/**
 * Persists session to shoonya-session.json with a 23-hour expiry
 * (Shoonya tokens last 24 h; we refresh 1 h early to be safe).
 */
const persistSession = (uid, jKey) => {
  const session = {
    uid,
    jKey,
    expiry: Date.now() + 23 * 60 * 60 * 1000,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(SHOONYA_SESSION_FILE, JSON.stringify(session, null, 2), 'utf-8');
  console.log('[Worker] Shoonya session saved to shoonya-session.json');
};

/**
 * Clears the persisted session file — forces re-login on next call.
 */
export const clearShoonyaSession = () => {
  try {
    if (existsSync(SHOONYA_SESSION_FILE)) {
      writeFileSync(SHOONYA_SESSION_FILE, JSON.stringify({}), 'utf-8');
    }
  } catch { /* ignore */ }
  console.log('[Worker] Shoonya session cleared');
};

/**
 * Returns a valid { uid, jKey } for Shoonya API calls.
 * - Reads from shoonya-session.json if still valid
 * - Otherwise calls shoonyaLogin() and persists the new session
 */
export const getShoonyaSession = async () => {
  // 1. Try persisted session first
  const cached = readPersistedSession();
  if (cached) {
    console.log('[Worker] Using cached Shoonya session from file');
    return { uid: cached.uid, jKey: cached.jKey };
  }

  // 2. Login fresh using existing shoonyaLogin utility
  console.log('[Worker] Shoonya session expired or missing — logging in...');
  const creds = getShoonyaCredentials();

  const result = await shoonyaLogin({
    uid: creds.uid,
    password: creds.password,
    totp: creds.totp,
    apiKey: creds.apiKey,
    clientId: creds.clientId,
    imei: creds.imei,
    userAgent: creds.userAgent,
    secretCode: creds.secretCode,
  });

  // DEBUG: log full response to identify correct token field
  console.log('[Worker] Shoonya raw login response:', JSON.stringify(result, null, 2));

  // shoonyaLogin returns { loginData, tokenData } when full OAuth flow is used,
  // or just loginData when QuickAuth returns susertoken directly.
  let uid, jKey;

  if (result?.tokenData?.susertoken) {
    // Full OAuth flow (code + GenAcsTok)
    uid = result.loginData?.uid || creds.uid;
    jKey = result.tokenData.susertoken;
  } else if (result?.loginData?.susertoken) {
    // QuickAuth returned token directly
    uid = result.loginData?.uid || creds.uid;
    jKey = result.loginData.susertoken;
  } else if (result?.susertoken) {
    // Fallback: shoonyaLogin returned flat object
    uid = result.uid || creds.uid;
    jKey = result.susertoken;
  } else {
    throw new Error(`[Shoonya] Login failed — no susertoken in response: ${JSON.stringify(result).substring(0, 200)}`);
  }

  // 3. Persist so next run reuses this session
  persistSession(uid, jKey);
  console.log('[Worker] Authenticated with Shoonya');
  return { uid, jKey };
};

// ============== HELPERS ==============

export const ANGEL_BASE = ANGEL_BASE_URL;

export const roundToNearestTick = (price) => Math.round(price * 20) / 20;

export const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export const getTodayDate = () => {
  const now = new Date();
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  return ist.toISOString().split('T')[0];
};

export const toISTDateTime = (timestamp) => {

  return new Date(
    timestamp * 1000
  ).toLocaleString(
    'en-IN',
    {
      timeZone: 'Asia/Kolkata',
      hour12: false
    }
  );
}

export const toISTDate = (timestamp) => {

  const date =
    new Date(
      timestamp * 1000
    );

  return date.toLocaleDateString(
    'en-CA',
    {
      timeZone: 'Asia/Kolkata'
    }
  );
}