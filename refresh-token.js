/**
 * refresh-token.js
 *
 * Automatically generates a new Fyers access token using the saved refresh token
 * and updates the .env file in-place — no manual browser login needed for 14 days.
 *
 * SETUP:
 *   1. After your first manual login, save your refresh_token in .env:
 *        FYERS_REFRESH_TOKEN=your_refresh_token_here
 *
 *   2. Schedule this script with cron (Linux/Mac) to run at 5:30 AM IST (00:00 UTC):
 *        crontab -e
 *        0 0 * * * cd /path/to/private-trade-bot && node refresh-token.js >> logs/token-refresh.log 2>&1
 *
 *   3. On Windows, use Task Scheduler to run:
 *        node C:\path\to\private-trade-bot\refresh-token.js
 *
 * HOW IT WORKS:
 *   - Reads FYERS_REFRESH_TOKEN from .env
 *   - Calls the Fyers API to exchange it for a new access token
 *   - Updates FYERS_ACCESS_TOKEN and FYERS_REFRESH_TOKEN in your .env file
 *   - After 14 days, the refresh token expires — you'll need to log in manually once
 */

import { createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, '.env');

// ─── Helpers ────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  console.log(`[${ts}] ${msg}`);
}

/**
 * Parse .env file into a key-value map.
 * Preserves comments and blank lines for faithful re-writing.
 */
function parseEnv(content) {
  const map = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    // Strip inline comments after value (e.g. FYERS_PIN=2023 # your pin)
    let value = trimmed.slice(eqIdx + 1).trim();
    const commentIdx = value.indexOf(' #');
    if (commentIdx !== -1) value = value.slice(0, commentIdx).trim();
    // Strip surrounding quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    map[key] = value;
  }
  return map;
}

/**
 * Update one or more keys in the .env file content string.
 * If a key already exists, its value is replaced.
 * If the key doesn't exist, it is appended at the end.
 */
function updateEnvContent(content, updates) {
  let result = content;

  for (const [key, newValue] of Object.entries(updates)) {
    // Match: KEY=anything (including inline comment), possibly with surrounding whitespace
    const regex = new RegExp(`^(${key}\\s*=)(.*)$`, 'm');
    if (regex.test(result)) {
      result = result.replace(regex, `$1${newValue}`);
    } else {
      // Append new key at end (ensure trailing newline)
      if (!result.endsWith('\n')) result += '\n';
      result += `${key}=${newValue}\n`;
    }
  }

  return result;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function refreshFyersToken() {
  log('Starting Fyers token refresh...');

  // 1. Load .env
  if (!existsSync(ENV_PATH)) {
    log(`ERROR: .env file not found at ${ENV_PATH}`);
    process.exit(1);
  }

  const envContent = readFileSync(ENV_PATH, 'utf-8');
  const env = parseEnv(envContent);

  const APP_ID       = env.FYERS_APP_ID;
  const SECRET_KEY   = env.FYERS_SECRET_KEY;
  const PIN          = env.FYERS_PIN;
  const REFRESH_TOKEN = env.FYERS_REFRESH_TOKEN;

  // Validate required fields
  const missing = [];
  if (!APP_ID)        missing.push('FYERS_APP_ID');
  if (!SECRET_KEY)    missing.push('FYERS_SECRET_KEY');
  if (!PIN)           missing.push('FYERS_PIN');
  if (!REFRESH_TOKEN) missing.push('FYERS_REFRESH_TOKEN');

  if (missing.length > 0) {
    log(`ERROR: Missing required .env variables: ${missing.join(', ')}`);
    log('Please ensure FYERS_REFRESH_TOKEN is set after your first manual login.');
    process.exit(1);
  }

  // 2. Generate appIdHash = SHA-256(APP_ID:SECRET_KEY)
  const appIdHash = createHash('sha256')
    .update(`${APP_ID}:${SECRET_KEY}`)
    .digest('hex');

  log(`App ID: ${APP_ID}`);
  log(`Requesting new access token using refresh token...`);

  // 3. Call Fyers refresh-token endpoint
  let data;
  try {
    const response = await fetch('https://api-t1.fyers.in/api/v3/validate-refresh-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        appIdHash,
        refresh_token: REFRESH_TOKEN,
        pin: PIN,
      }),
    });

    data = await response.json();
  } catch (err) {
    log(`ERROR: Network request failed: ${err.message}`);
    process.exit(1);
  }

  // 4. Handle response
  if (data.s === 'ok' || data.access_token) {
    const newAccessToken  = data.access_token;
    const newRefreshToken = data.refresh_token || REFRESH_TOKEN; // Some responses return updated refresh token

    log('SUCCESS: New access token received!');
    log(`Access token (first 30 chars): ${newAccessToken.slice(0, 30)}...`);

    // 5. Update .env in-place
    const updates = {
      FYERS_ACCESS_TOKEN: newAccessToken,
    };
    // Only update refresh token if a new one was returned
    if (data.refresh_token && data.refresh_token !== REFRESH_TOKEN) {
      updates.FYERS_REFRESH_TOKEN = data.refresh_token;
      log('Refresh token also updated (new one received from Fyers).');
    }

    const updatedContent = updateEnvContent(envContent, updates);
    writeFileSync(ENV_PATH, updatedContent, 'utf-8');

    log('.env updated successfully. Your bot will use the new token automatically.');
    log('Next refresh: tomorrow at 5:30 AM IST (if cron is set up).');

  } else if (data.code === 401 || data.message?.toLowerCase().includes('expired')) {
    log('ERROR: Refresh token has EXPIRED (14-day limit reached).');
    log('You need to log in manually once to get a new refresh token.');
    log('Steps:');
    log('  1. Open the Fyers login URL in your browser and authenticate.');
    log('  2. Copy the new refresh_token from the response.');
    log('  3. Set FYERS_REFRESH_TOKEN=<new_token> in your .env file.');
    log('  4. The 14-day cycle resets and this script will work again.');
    process.exit(1);

  } else {
    log(`ERROR: Unexpected response from Fyers API:`);
    log(JSON.stringify(data, null, 2));
    process.exit(1);
  }
}

refreshFyersToken();