import { getJWTToken } from '../services/angel-api.service.js';
import { getCredentialsOrEnv } from '../utilities/config-cache.js';
import { getStockBySymbol, getMasterCacheInfo } from '../utilities/stock-master-cache.js';
import { logger } from '../utilities/logger.js';
import fetch from 'node-fetch';

const ANGEL_BASE_URL = 'https://apiconnect.angelone.in';

const placeAngelOrder = async (jwtToken, orderData) => {
  const credentials = getCredentialsOrEnv();

  const response = await fetch(`${ANGEL_BASE_URL}/rest/secure/angelbroking/order/v1/placeOrder`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${jwtToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-UserType': 'USER',
      'X-SourceID': 'WEB',
      'X-ClientLocalIP': '127.0.0.1',
      'X-ClientPublicIP': '127.0.0.1',
      'X-MACAddress': '00:00:00:00:00:00',
      'X-PrivateKey': credentials.apiKey,
    },
    body: JSON.stringify(orderData),
  });

  return response.json();
};

export const placeOrder = async (req, res) => {
  try {
    const { action, symbol, exchange = 'NSE', quantity, price, orderType, productType = 'DELIVERY' } = req.body;

    if (!action || !symbol || !quantity) {
      return res.status(400).json({ error: 'Missing required fields: action, symbol, quantity' });
    }

    if (!['BUY', 'SELL'].includes(action.toUpperCase())) {
      return res.status(400).json({ error: 'Invalid action. Must be BUY or SELL' });
    }

    if (!['LIMIT', 'MARKET', 'SL', 'SL-M'].includes(orderType?.toUpperCase())) {
      return res.status(400).json({ error: 'Invalid orderType. Must be LIMIT, MARKET, SL, or SL-M' });
    }

    const cacheInfo = getMasterCacheInfo();
    if (cacheInfo.isEmpty) {
      return res.status(503).json({
        error: 'Master data not loaded',
        message: 'Please call POST /api/admin/update-master first to load stock data',
      });
    }

    const stock = getStockBySymbol(symbol.toUpperCase(), exchange.toUpperCase());
    if (!stock) {
      return res.status(404).json({
        error: 'Stock not found',
        message: `${symbol} not found in ${exchange}. Use /api/stocks/search to find valid symbols.`,
      });
    }

    logger.info(`[Trade Order] Placing ${action} order for ${symbol} (token: ${stock.token})`);

    const jwtToken = await getJWTToken();

    const orderData = {
      variety: 'NORMAL',
      tradingsymbol: stock.symbol,
      symboltoken: stock.token,
      transactiontype: action.toUpperCase(),
      exchange: exchange.toUpperCase(),
      ordertype: orderType.toUpperCase(),
      producttype: productType.toUpperCase(),
      duration: 'DAY',
      price: orderType.toUpperCase() === 'MARKET' ? '0' : price.toString(),
      squareoff: '0',
      stoploss: '0',
      quantity: quantity.toString(),
    };

    const result = await placeAngelOrder(jwtToken, orderData);

    if (result.status && result.data) {
      logger.info(`[Trade Order] Order placed successfully: ${result.data.orderid}`);
      return res.json({
        success: true,
        orderId: result.data.orderid,
        message: result.message || 'Order placed successfully',
        orderDetails: {
          symbol: stock.symbol,
          name: stock.name,
          action: action.toUpperCase(),
          quantity,
          price: orderType.toUpperCase() === 'MARKET' ? 'MARKET' : price,
          orderType: orderType.toUpperCase(),
          productType: productType.toUpperCase(),
        },
      });
    } else {
      throw new Error(result.message || 'Failed to place order');
    }
  } catch (error) {
    logger.error('[Trade Order] Error:', error.message);
    return res.status(500).json({ error: 'Failed to place order', message: error.message });
  }
};

export const placeBracketOrder = async (req, res) => {
  try {
    const { action, symbol, exchange = 'NSE', quantity, price, stopLossPercent = 0.5, targetPercent = 0.5 } = req.body;

    if (!action || !symbol || !quantity || !price) {
      return res.status(400).json({ error: 'Missing required fields: action, symbol, quantity, price' });
    }

    if (!['BUY', 'SELL'].includes(action.toUpperCase())) {
      return res.status(400).json({ error: 'Invalid action. Must be BUY or SELL' });
    }

    const cacheInfo = getMasterCacheInfo();
    if (cacheInfo.isEmpty) {
      return res.status(503).json({
        error: 'Master data not loaded',
        message: 'Please call POST /api/admin/update-master first to load stock data',
      });
    }

    const stock = getStockBySymbol(symbol.toUpperCase(), exchange.toUpperCase());
    if (!stock) {
      return res.status(404).json({
        error: 'Stock not found',
        message: `${symbol} not found in ${exchange}. Use /api/stocks/search to find valid symbols.`,
      });
    }

    const entryPrice = parseFloat(price);
    const stopLossValue = (entryPrice * stopLossPercent) / 100;
    const targetValue = (entryPrice * targetPercent) / 100;

    logger.info(`[Bracket Order] Placing ${action} bracket order for ${symbol}`);
    logger.info(`[Bracket Order] Entry: ${entryPrice}, SL: ${stopLossValue.toFixed(2)}, Target: ${targetValue.toFixed(2)}`);

    const jwtToken = await getJWTToken();

    const orderData = {
      variety: 'ROBO',
      tradingsymbol: stock.symbol,
      symboltoken: stock.token,
      transactiontype: action.toUpperCase(),
      exchange: exchange.toUpperCase(),
      ordertype: 'LIMIT',
      producttype: 'INTRADAY',
      duration: 'DAY',
      price: entryPrice.toFixed(2),
      squareoff: targetValue.toFixed(2),
      stoploss: stopLossValue.toFixed(2),
      quantity: quantity.toString(),
      trailingStoploss: '0',
    };

    const result = await placeAngelOrder(jwtToken, orderData);

    if (result.status && result.data) {
      logger.info(`[Bracket Order] Order placed successfully: ${result.data.orderid}`);

      const stopLossPrice = action.toUpperCase() === 'BUY' ? entryPrice - stopLossValue : entryPrice + stopLossValue;
      const targetPrice = action.toUpperCase() === 'BUY' ? entryPrice + targetValue : entryPrice - targetValue;

      return res.json({
        success: true,
        orderId: result.data.orderid,
        message: result.message || 'Bracket order placed successfully',
        orderDetails: {
          symbol: stock.symbol,
          name: stock.name,
          action: action.toUpperCase(),
          quantity,
          entryPrice: entryPrice.toFixed(2),
          stopLossPrice: stopLossPrice.toFixed(2),
          targetPrice: targetPrice.toFixed(2),
          stopLossPercent: `${stopLossPercent}%`,
          targetPercent: `${targetPercent}%`,
          productType: 'INTRADAY',
          note: 'Bracket order will auto-exit at stop loss or target.',
        },
      });
    } else {
      throw new Error(result.message || 'Failed to place bracket order');
    }
  } catch (error) {
    logger.error('[Bracket Order] Error:', error.message);
    return res.status(500).json({ error: 'Failed to place bracket order', message: error.message });
  }
};
