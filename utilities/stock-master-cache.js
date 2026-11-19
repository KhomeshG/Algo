// In-memory cache for Angel One master stock data (NSE Equity only)

const masterCache = {
  data: new Map(), // Key: "SYMBOL-EXCHANGE"
  lastUpdated: 0,
  count: 0,
};

export const setMasterData = (stocks) => {
  masterCache.data.clear();

  stocks.forEach((stock) => {
    const key = `${stock.symbol}-${stock.exchange}`;
    masterCache.data.set(key, stock);
  });

  masterCache.lastUpdated = Date.now();
  masterCache.count = stocks.length;

  console.log(`[Stock Master Cache] Cached ${stocks.length} NSE equity stocks`);
};

export const getStockBySymbol = (symbol, exchange = 'NSE') => {
  const key = `${symbol}-${exchange}`;
  return masterCache.data.get(key) || null;
};

export const searchStocks = (query, limit = 10) => {
  const results = [];
  const queryLower = query.toLowerCase();

  for (const stock of masterCache.data.values()) {
    if (stock.symbol.toLowerCase().includes(queryLower) || stock.name.toLowerCase().includes(queryLower)) {
      results.push(stock);
      if (results.length >= limit) break;
    }
  }

  return results;
};

export const getMasterCacheInfo = () => {
  return {
    count: masterCache.count,
    lastUpdated: masterCache.lastUpdated ? new Date(masterCache.lastUpdated).toISOString() : null,
    isEmpty: masterCache.data.size === 0,
  };
};

export const getAllStocks = () => {
  return Array.from(masterCache.data.values());
};

export const clearMasterCache = () => {
  masterCache.data.clear();
  masterCache.lastUpdated = 0;
  masterCache.count = 0;
  console.log('[Stock Master Cache] Cache cleared');
};