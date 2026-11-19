import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Path to the fno-master.json in the parent project's data folder
const fnoDataPath = join(__dirname, '../data/fno-master.json');

let fnoStocksCache = null;
let _fnoData = null;

const getFnoData = () => {
  if (_fnoData) return _fnoData;

  if (!existsSync(fnoDataPath)) {
    console.warn('[FNO Loader] fno-master.json not found at:', fnoDataPath);
    _fnoData = { stocks: [], count: 0, lastUpdated: null, description: '' };
    return _fnoData;
  }

  try {
    _fnoData = require(fnoDataPath);
  } catch (e) {
    console.warn('[FNO Loader] Could not load fno-master.json:', e.message);
    _fnoData = { stocks: [], count: 0, lastUpdated: null, description: '' };
  }

  return _fnoData;
};

export const getFNOStocks = () => {
  if (fnoStocksCache) return fnoStocksCache;
  const data = getFnoData();
  fnoStocksCache = data.stocks || [];
  return fnoStocksCache;
};

export const getFNOStockBySymbol = (symbol) => {
  const stocks = getFNOStocks();
  return stocks.find((s) => s.symbol.toUpperCase() === symbol.toUpperCase()) || null;
};

export const getFNOStockInfo = () => {
  const data = getFnoData();
  return {
    count: data.count,
    lastUpdated: data.lastUpdated,
    description: data.description,
  };
};
export default {
  getFNOStocks,
  getFNOStockBySymbol,
  getFNOStockInfo
};
