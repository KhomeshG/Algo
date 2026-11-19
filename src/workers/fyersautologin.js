/**
 * Fyers API v3 — automated login using TOTP (no manual OTP/browser step).
 *
 * Replicates the same request sequence the Fyers web login page makes, but
 * calls the endpoints directly instead of driving a browser — which is why
 * it normally doesn't hit the Cloudflare captcha (that's tied to loading the
 * login page itself, not these underlying API calls).
 *
 * Install deps:
 *   npm install axios otplib
 *
 * If any endpoint here starts returning captcha/challenge responses instead
 * of JSON, that means Fyers has locked this path down and you're back to
 * manual login for that session — this script can't (and shouldn't) solve
 * a captcha for you.
 *
 * NOTE ON SECRETS: this file has the config inline as you asked (one
 * worker file, no env vars). That means these credentials live in your
 * repo. Make sure this file/repo is NOT committed to a public remote —
 * add it to .gitignore if the repo is or could become public.
 */

import axios from "axios";
import crypto from "crypto";
import { authenticator } from "otplib";
import { pathToFileURL, fileURLToPath } from "url";
import { dirname, join } from "path";
import fs from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
// This file lives at src/workers/, .env is at the project root — adjust
// this path if your .env lives somewhere else.
const ENV_PATH = join(__dirname, "..", "..", ".env");

const BASE_T1 = "https://api-t1.fyers.in/api/v3";
const BASE_T2 = "https://api-t2.fyers.in/vagator/v2";

const HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "Mozilla/5.0",
};

const b64 = (s) => Buffer.from(s, "utf-8").toString("base64");

const config = {
  // Your personal Fyers login/client ID — the one you type into the
  // Fyers app/website to log in, e.g. "XP27971". NOT your app's client_id.
  fyId: "XP27971",

  // TOTP secret shown when you set up 2FA on Fyers (not the 6-digit code).
  totpSecret: "KV2IKF7Z7KOFH3OWTGGRF6NHAMNW6FZI",

  // Your 4-digit Fyers trading PIN.
  pin: "2023",

  // Your APP's client_id from myapi.fyers.in, e.g. "RA0X7XPTD4".
  // This is plain text — the script hashes it with appSecret itself,
  // so don't paste a pre-computed hash here.
  appId: "RA0X7XPTD4",

  // Your APP's secret key from myapi.fyers.in.
  appSecret: "igWL3OHqxMeP1VwJ",

  // The redirect URI registered for your app.
  redirectUri: "https://www.virtualglobetechnology.com",
};

/**
 * Sets/updates FYERS_ACCESS_TOKEN in the .env file, preserving every
 * other line as-is. Adds the key if it doesn't exist yet.
 */
function updateEnvToken(token) {
  let content = "";
  try {
    content = fs.readFileSync(ENV_PATH, "utf-8");
  } catch {
    // .env doesn't exist yet — we'll create it below.
  }

  const line = `FYERS_ACCESS_TOKEN=${token}`;
  const keyRegex = /^FYERS_ACCESS_TOKEN=.*$/m;

  if (keyRegex.test(content)) {
    content = content.replace(keyRegex, line);
  } else {
    content = content.length && !content.endsWith("\n")
      ? `${content}\n${line}\n`
      : `${content}${line}\n`;
  }

  fs.writeFileSync(ENV_PATH, content, "utf-8");
}

async function getAccessToken() {
  const { fyId, totpSecret, pin, appId, appSecret, redirectUri } = config;

  if (!fyId || !totpSecret || !pin || !appId || !appSecret || !redirectUri) {
    throw new Error(
      "Missing one or more required config fields: fyId, totpSecret, pin, appId, appSecret, redirectUri"
    );
  }

  // Step 1: kick off login with fy_id -> get a request_key
  const r1 = await axios.post(
    `${BASE_T2}/send_login_otp_v2`,
    { fy_id: b64(fyId), app_id: "2" },
    { headers: HEADERS }
  );
  const requestKey1 = r1.data.request_key;

  // Step 2: verify using a freshly generated TOTP code
  const totpCode = authenticator.generate(totpSecret);
  const r2 = await axios.post(
    `${BASE_T2}/verify_otp`,
    { request_key: requestKey1, otp: totpCode },
    { headers: HEADERS }
  );
  const requestKey2 = r2.data.request_key;

  // Step 3: verify PIN -> returns a short-lived bearer token
  const r3 = await axios.post(
    `${BASE_T2}/verify_pin_v2`,
    {
      request_key: requestKey2,
      identity_type: "pin",
      identifier: b64(pin),
    },
    { headers: HEADERS }
  );
  const pinBearerToken = r3.data.data.access_token;

  // Step 4: use that bearer token to request an auth code for your app
  const r4 = await axios.post(
    `${BASE_T1}/token`,
    {
      fyers_id: fyId,
      app_id: appId,
      redirect_uri: redirectUri,
      appType: "200", // must match your app's actual type from myapi.fyers.in/dashboard
      code_challenge: "",
      state: "sample_state",
      scope: "",
      nonce: "",
      response_type: "code",
      create_cookie: true,
    },
    {
      headers: {
        ...HEADERS,
        Authorization: `Bearer ${pinBearerToken}`,
      },
      // Fyers' /token endpoint responds with HTTP 308 on success (it's not
      // a real redirect, just their status code) — without this, axios
      // treats it as an error and throws before we can read the body.
      validateStatus: (status) => status >= 200 && status < 400,
    }
  );
  const redirectUrl = r4.data.Url;
  const authCode = new URL(redirectUrl).searchParams.get("auth_code");

  console.log("Auth code received:", authCode);

  // Step 5: exchange auth_code for the final access_token
  const appIdHash = crypto
    .createHash("sha256")
    .update(`${appId}-200:${appSecret}`)
    .digest("hex");

  const r5 = await axios.post(
    `${BASE_T1}/validate-authcode`,
    {
      grant_type: "authorization_code",
      appIdHash,
      code: authCode,
    },
    { headers: HEADERS }
  );

  return r5.data.access_token;
}

/**
 * WHY RETRIES HELP HERE: Fyers only keeps ONE login handshake "live" per
 * account at a time. If this script is ever run from two places close
 * together (e.g. local + server within the same few seconds), whichever
 * one finishes step 4 (getting an auth_code) last can find that Fyers has
 * already moved on to the OTHER run's session — so its auth_code comes
 * back as "invalid auth code" even though nothing in THIS run was wrong.
 *
 * Because every call to getAccessToken() starts a brand new handshake
 * (new OTP, new request_key chain), simply restarting the whole flow
 * from scratch — not resuming mid-way — is the correct fix, and usually
 * succeeds on the very next attempt once the other run has finished.
 *
 * IMPORTANT: still try not to run this from local AND server at the same
 * time on purpose — pick one place to generate the token and copy the
 * resulting FYERS_ACCESS_TOKEN value to the other .env file instead of
 * logging in twice. This retry is a safety net for accidental overlap,
 * not a reason to rely on running it from both places routinely.
 */
async function getAccessTokenWithRetry(maxAttempts = 3) {
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (attempt > 1) {
        console.log(`[FyersAutoLogin] Retry attempt ${attempt}/${maxAttempts}...`);
        // Small pause so any overlapping run elsewhere has time to finish
        // its own handshake before we start a fresh one.
        await new Promise((r) => setTimeout(r, 3000));
      }
      return await getAccessToken();
    } catch (err) {
      lastErr = err;
      const message = err.response?.data?.message || err.message;
      const isInvalidAuthCode =
        err.response?.data?.code === -1 ||
        /invalid auth code/i.test(message || "");

      console.error(
        `[FyersAutoLogin] Attempt ${attempt}/${maxAttempts} failed:`,
        err.response?.data || err.message
      );

      if (isInvalidAuthCode && attempt < maxAttempts) {
        console.warn(
          "[FyersAutoLogin] 'invalid auth code' usually means this login flow " +
          "overlapped with another one (e.g. local + server running at the " +
          "same time). Retrying with a fresh handshake..."
        );
        continue;
      }

      if (!isInvalidAuthCode) {
        // A different kind of failure (bad TOTP secret, wrong PIN, network
        // issue, etc.) — retrying blindly won't help, fail fast instead.
        break;
      }
    }
  }

  throw lastErr;
}

// ESM equivalent of `require.main === module`: only auto-run when this
// file is executed directly (e.g. `node fyersautologin.js`), not when
// it's imported by another module.
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  getAccessTokenWithRetry()
    .then((token) => {
      updateEnvToken(token);
      console.log("Access token saved to .env as FYERS_ACCESS_TOKEN");
      // Combine with config.appId for use with the Fyers Node SDK, e.g.:
      //   import { fyersModel } from "fyers-api-v3";
      //   const fyers = new fyersModel();
      //   fyers.setAppId(config.appId);
      //   fyers.setAccessToken(token);
    })
    .catch((err) => {
      console.error("Login failed after retries:", err.response?.data || err.message);
      process.exit(1);
    });
}

export { getAccessToken, updateEnvToken };