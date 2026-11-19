export function getFyersSymbol(stock) {

    return `NSE:${stock.symbol}-EQ`;
}

export function getAngelToken(stock) {

    return stock.token;
}

/**
 * Angel One SmartAPI trading symbol. NSE equities need the "-EQ" suffix
 * (indices like NIFTY/BANKNIFTY are used as-is), same convention as Shoonya.
 */
export function getAngelTradingSymbol(symbol, exchange = 'NSE') {
    const cleanSymbol = symbol.toUpperCase();
    if (exchange.toUpperCase() === 'NSE' && !cleanSymbol.endsWith('-EQ')) {
        if (cleanSymbol === 'NIFTY' || cleanSymbol === 'BANKNIFTY') {
            return cleanSymbol;
        }
        return `${cleanSymbol}-EQ`;
    }
    return cleanSymbol;
}

export function getShoonyaSymbol(stock) {

    return `${stock.symbol}-EQ`;
}