// -----------------------------------------------------------------------------
// SINGLE-ACCOUNT BUILD (Nine-Fifteen only)
//
// Only ONE trading account exists: ACC1 = your Shoonya account, configured via
// the normal SHOONYA_* env vars. OMS_ACCOUNTS and SHOONYA2_/SHOONYA3_* are
// ignored on purpose, so a leftover env var can never start a second account.
//
// The exported API is unchanged, so every other file works as before. Trades are
// still tagged accountId "ACC1" and stay compatible with your existing database.
// -----------------------------------------------------------------------------
export const PRIMARY_ACCOUNT_ID = 'ACC1';

export const isPrimaryAccount = () => true;
export const normalizeAccountId = () => PRIMARY_ACCOUNT_ID;

/** Account a trade document belongs to (always ACC1). */
export const tradeAccountId = () => PRIMARY_ACCOUNT_ID;

/** Mongo filter for trades of the account (legacy docs without accountId count as ACC1). */
export function accountTradeFilter() {
    return { $or: [{ accountId: PRIMARY_ACCOUNT_ID }, { accountId: { $exists: false } }, { accountId: null }] };
}

export function getAccountCredsFromEnv() {
    const e = (k) => process.env[`SHOONYA_${k}`];
    return {
        uid: e('UID'), password: e('PASSWORD'), totp: e('TOTP_SECRET'),
        apiKey: e('API_KEY'), clientId: e('CLIENT_ID'), secretCode: e('SECRET_CODE'),
    };
}

/** Optional SHOONYA_BALANCE override for sizing, else null (= use OMS_BALANCE / config). */
export function getAccountBalance() {
    const raw = process.env.SHOONYA_BALANCE;
    const n = raw != null && raw !== '' ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
}

export const enabledAccountIds = () => [PRIMARY_ACCOUNT_ID];
export const allKnownAccountIds = () => [PRIMARY_ACCOUNT_ID];
