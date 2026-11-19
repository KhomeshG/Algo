export function createTrade({
    signal,
    quantity,
    entryPrice,
    stopLossPrice,
    targetPrice,
    patternSource,
    broker,
    accountId
}) {
    return {
        signalId: signal._id,

        symbol: signal.symbol,
        token: signal.token,

        // Which broker/account this trade was actually routed to
        // (OMS_CONFIG.BROKER or OMS_CONFIG.FIRST15.BROKER, whichever
        // applies) — stored on the doc itself so anything reading trades
        // later (e.g. the 9:30 AM orders digest) has ground truth instead
        // of having to re-derive it from patternSource + current config.
        broker: broker || null,

        // Which of your trading accounts (ACC1/ACC2/ACC3) holds this trade. Exits, cancels and
        // the position safety check all use it to talk to the RIGHT account. Old trades have no
        // accountId and are treated as ACC1.
        accountId: accountId || 'ACC1',

        side: signal.signal,

        quantity,

        entryPrice,

        stopLossPrice,

        currentSL: stopLossPrice,

        targetPrice,

        highestPrice: entryPrice,

        pnl: 0,

        status: 'ENTRY_PENDING',
        trailingPercent: 0.5, // default trailing percent
        patternSource: patternSource || signal.patternSource || 'UNKNOWN',

        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
}