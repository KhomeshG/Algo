const configCache = {
  credentials: null,
  cachedAt: 0,
  authToken: null,
  tokenExpiryTime: 0,
  // Shoonya config fields
  shoonyaCredentials: null,
  shoonyaToken: null,
  shoonyaCachedAt: 0,
  // Wisdom (XTS Interactive API) config fields
  wisdomCredentials: null,
  wisdomToken: null,
  wisdomUniqueKey: null,
  wisdomConnectionString: null,
  wisdomCachedAt: 0,
  // Wisdom Marketdata (Binary Marketdata API) — separate login/session
  wisdomMarketdataToken: null,
  wisdomMarketdataCachedAt: 0,
};

const TOKEN_EXPIRY_HOURS = 8; // Token expires after 8 hours

export const setCredentials = (credentials) => {
  configCache.credentials = credentials;
  configCache.cachedAt = Date.now();
  configCache.authToken = null;
  configCache.tokenExpiryTime = 0;
  console.log('[Config Cache] Credentials cached successfully');
};

export const setAuthToken = (token) => {
  configCache.authToken = token;
  configCache.tokenExpiryTime = Date.now() + TOKEN_EXPIRY_HOURS * 60 * 60 * 1000;
  console.log(`[Config Cache] Auth token cached (expires in ${TOKEN_EXPIRY_HOURS} hours)`);
};

export const getAuthToken = () => {
  if (!configCache.authToken) {
    return null;
  }

  // Check if token is expired
  if (Date.now() > configCache.tokenExpiryTime) {
    console.log('[Config Cache] Auth token expired, clearing cache');
    configCache.authToken = null;
    configCache.tokenExpiryTime = 0;
    return null;
  }

  return configCache.authToken;
};

export const isTokenExpired = () => {
  if (!configCache.authToken) {
    return true;
  }
  return Date.now() > configCache.tokenExpiryTime;
};

export const getCredentials = () => {
  if (configCache.credentials) {
    console.log('[Config Cache] Returning cached credentials');
    return configCache.credentials;
  }
  return null;
};

export const clearCredentials = () => {
  configCache.credentials = null;
  configCache.cachedAt = 0;
  configCache.authToken = null;
  configCache.tokenExpiryTime = 0;
  configCache.shoonyaCredentials = null;
  configCache.shoonyaToken = null;
  configCache.shoonyaCachedAt = 0;
  console.log('[Config Cache] Credentials and token cleared - will use environment variables');
};

export const getCredentialsOrEnv = () => {
  // First try to get from cache
  const cachedCreds = getCredentials();
  if (cachedCreds) {
    return cachedCreds;
  }

  // Fall back to environment variables
  console.log('[Config Cache] Using environment variables');
  return {
    apiKey: process.env.ANGEL_API_KEY,
    clientId: process.env.ANGEL_CLIENT_ID,
    secretKey: process.env.ANGEL_SECRET_KEY,
    totpSecret: process.env.ANGEL_TOTP_SECRET,
    mpin: process.env.ANGEL_MPIN,
  };
};

export const setShoonyaCredentials = (credentials) => {
  configCache.shoonyaCredentials = credentials;
  configCache.shoonyaCachedAt = Date.now();
  configCache.shoonyaToken = null;
  console.log('[Config Cache] Shoonya credentials cached successfully');
};

export const setShoonyaToken = (token) => {
  configCache.shoonyaToken = token;
  console.log('[Config Cache] Shoonya token cached successfully');
};

export const getShoonyaToken = () => {

  // console.log('[Config Cache] Retrieving Shoonya token from cache if available', configCache.shoonyaToken, configCache);
  return configCache.shoonyaToken;
};

export const getShoonyaCredentialsOrEnv = () => {
  if (configCache.shoonyaCredentials) {
    console.log('[Config Cache] Returning cached Shoonya credentials');
    return configCache.shoonyaCredentials;
  }

  return {
    uid: process.env.SHOONYA_UID,
    password: process.env.SHOONYA_PASSWORD,
    totp: process.env.SHOONYA_TOTP_SECRET,
    apiKey: process.env.SHOONYA_API_KEY,
    clientId: process.env.SHOONYA_CLIENT_ID,
    secretCode: process.env.SHOONYA_SECRET_CODE,
  };
};

// ─────────────────────────────────────────────────────────────────────────
// Wisdom (Symphony/XTS Interactive API) — order placement session
// ─────────────────────────────────────────────────────────────────────────

export const setWisdomCredentials = (credentials) => {
  configCache.wisdomCredentials = credentials;
  configCache.wisdomCachedAt = Date.now();
  configCache.wisdomToken = null;
  console.log('[Config Cache] Wisdom credentials cached successfully');
};

export const setWisdomToken = (token) => {
  configCache.wisdomToken = token;
  console.log('[Config Cache] Wisdom token cached successfully');
};

export const getWisdomToken = () => {
  return configCache.wisdomToken;
};

export const setWisdomHostLookup = ({ uniqueKey, connectionString }) => {
  configCache.wisdomUniqueKey = uniqueKey;
  configCache.wisdomConnectionString = connectionString;
};

export const getWisdomHostLookup = () => {
  return {
    uniqueKey: configCache.wisdomUniqueKey,
    connectionString: configCache.wisdomConnectionString,
  };
};

export const getWisdomCredentialsOrEnv = () => {
  if (configCache.wisdomCredentials) {
    console.log('[Config Cache] Returning cached Wisdom credentials');
    return configCache.wisdomCredentials;
  }
 
  console.log('[Config Cache] Using environment variables for Wisdom');
  return {
    appKey: process.env.WISDOM_APP_KEY,
    secretKey: process.env.WISDOM_SECRET_KEY,
    clientId: process.env.WISDOM_CLIENT_ID,
    // userID/password/pin are no longer used for login (Wisdom's Interactive
    // API session is opened with just appKey+secretKey — see
    // utilities/wisdom-auth.js). Kept here only in case another feature
    // needs them later.
    userID: process.env.WISDOM_USER_ID,
    password: process.env.WISDOM_PASSWORD,
    pin: process.env.WISDOM_PIN,
  };
};

// ─────────────────────────────────────────────────────────────────────────
// Wisdom Marketdata (Binary Marketdata API) — used only to resolve a
// tradingsymbol into the numeric exchangeInstrumentID the Interactive API
// needs for placing orders. Completely separate login/session from above.
// ─────────────────────────────────────────────────────────────────────────

export const setWisdomMarketdataToken = (token) => {
  configCache.wisdomMarketdataToken = token;
  configCache.wisdomMarketdataCachedAt = Date.now();
  console.log('[Config Cache] Wisdom Marketdata token cached successfully');
};

export const getWisdomMarketdataToken = () => {
  return configCache.wisdomMarketdataToken;
};

export const getWisdomMarketdataCredentialsOrEnv = () => {
  return {
    appKey: process.env.WISDOM_MARKETDATA_APP_KEY,
    secretKey: process.env.WISDOM_MARKETDATA_SECRET_KEY,
  };
};
