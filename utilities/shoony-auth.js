import crypto from 'crypto';
import { authenticator } from 'otplib';

const sha256 = (value) => {

    return crypto
        .createHash('sha256')
        .update(value)
        .digest('hex');
};

// ─── Safe JSON parsing for Shoonya's raw HTTP responses ───────────────────
//
// THE BUG THIS FIXES: this file used to call `response.json()` directly on
// both the login and token-exchange calls. Shoonya's API (or a proxy in
// front of it) doesn't always return JSON — during a maintenance restart,
// a rate limit, or a transient gateway hiccup, it can return an HTML error
// page instead (e.g. "<html><h1>502 Bad Gateway</h1>..."). `.json()` then
// throws `SyntaxError: Unexpected token '<' ... is not valid JSON` — a
// message that tells you NOTHING about what actually went wrong (which
// step, what HTTP status, whether it's even worth retrying).
//
// This wraps that: read the body as text first, try to parse it, and if
// that fails, throw an error that actually explains what happened — the
// HTTP status and a preview of the real response — so a login failure
// alert is diagnosable at a glance instead of just showing a parse error.
async function parseShoonyaJson(response, stepLabel) {
    const text = await response.text();
    try {
        return JSON.parse(text);
    } catch (parseErr) {
        const preview = text.slice(0, 300).replace(/\s+/g, ' ').trim();
        throw new Error(
            `Shoonya ${stepLabel} returned a non-JSON response (HTTP ${response.status} ${response.statusText}). ` +
            `This means the broker's API/gateway itself is unavailable or returning an error page — ` +
            `not a credentials or code problem. Response preview: "${preview}"`
        );
    }
}

const shoonyaLogin = async ({
    uid,
    password,
    totp,
    apiKey,
    clientId,
    imei,
    userAgent,
    secretCode
}) => {

    try {

        /**
         * STEP 1
         * Generate password hash
         */
        const hashedPassword = sha256(
            password
        );

        /**
         * STEP 2
         * Generate current OTP
         */
        const otp = authenticator.generate(
            totp
        );

        /**
         * STEP 3
         * QuickAuth
         */
        const loginPayload = {
            apkversion: 'W2_20250926',
            uid,
            pwd: hashedPassword,
            factor2: otp,
            appkey: apiKey,
            imei,
            addldivinf: userAgent,
            source: 'API',
            vc: 'NOREN_API',
            app_key: clientId
        };

        const loginResponse = await fetch(
            'https://api.shoonya.com/NorenWClientAPI/QuickAuth',
            {
                method: 'POST',

                headers: {
                    'Content-Type': 'application/json'
                },

                body:
                    `jData=${JSON.stringify(loginPayload)}`
            }
        );

        const loginData =
            await parseShoonyaJson(loginResponse, 'QuickAuth (step 1/2 of login)');

        /**
         * STEP 4
         * Get code
         */
        const code = loginData.code;

        if (!code) {

            return loginData;
        }

        /**
         * STEP 5
         * Generate checksum
         * sha256(clientId + apiKey + code)
         */
        const checksum = sha256(
            `${clientId}${secretCode}${code}`
        );

        /**
         * STEP 6
         * Generate Access Token
         */
        const tokenPayload = {
            code,
            checksum
        };

        const tokenResponse = await fetch(
            'https://api.shoonya.com/NorenWClientAPI/GenAcsTok',
            {
                method: 'POST',

                headers: {
                    'Content-Type': 'application/json',

                    Authorization:
                        `Bearer ${checksum}`
                },

                body:
                    `jData=${JSON.stringify(tokenPayload)}`
            }
        );

        const tokenData =
            await parseShoonyaJson(tokenResponse, 'GenAcsTok (step 2/2 of login)');

        // Extract cookie headers (e.g. NWC_ID) dynamically
        const cookies = [];
        const loginCookie = loginResponse.headers.get('set-cookie');
        if (loginCookie) cookies.push(loginCookie.split(';')[0]);
        const tokenCookie = tokenResponse.headers.get('set-cookie');
        if (tokenCookie) cookies.push(tokenCookie.split(';')[0]);
        const cookieHeader = cookies.join('; ');

        /**
         * FINAL RESPONSE
         */
        return {
            loginData,
            tokenData,
            cookieHeader
        };

    } catch (error) {

        console.error(
            '[Shoonya Login Error]',
            error.message
        );

        throw error;
    }
};

export {
    shoonyaLogin
};