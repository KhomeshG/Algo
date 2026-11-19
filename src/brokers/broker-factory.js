import { ShoonyaAdapter } from './shoonya-adapter.js';

// Canonical broker-name normalizer — 'ANGEL' and 'ANGELONE' both resolve
// to the same adapter, so callers doing a safety-guard comparison (see
// assertBrokerMatches below) must compare through this instead of a raw
// string ===, or a config using 'ANGELONE' would falsely fail a check
// written against 'ANGEL'.
function normalizeBrokerName(name) {
    const upper = String(name || '').toUpperCase();
    return upper === 'ANGELONE' ? 'ANGEL' : upper;
}

export function getBrokerAdapter(name, accountId) {

    const brokerName = normalizeBrokerName(name);
    let adapter;

    switch (brokerName) {

        case 'SHOONYA':
            adapter = new ShoonyaAdapter(accountId);
            break;

        default:
            throw new Error(
                `Unsupported broker: ${name}`
            );
    }

    // Tag the instance with the broker it was actually built for, so any
    // caller that received this adapter through several layers of
    // indirection can still verify (see assertBrokerMatches) that it is
    // holding the adapter it thinks it's holding, instead of trusting
    // that every hop in between passed the right config value along.
    adapter.brokerName = brokerName;
    adapter.accountId = (accountId || 'ACC1').toUpperCase();

    // Extra accounts exist for Shoonya only. Refuse (loudly) rather than silently
    // routing an ACC2/ACC3 order to some other broker's single account.
    if (brokerName !== 'SHOONYA' && adapter.accountId !== 'ACC1') {
        throw new Error(`Account ${adapter.accountId} is only supported for SHOONYA (got ${brokerName}).`);
    }
    return adapter;
}

/**
 * Safety guard — throws if `broker` (an adapter returned by
 * getBrokerAdapter) is not actually the broker named by `expectedName`.
 *
 * Why this exists: OMS_CONFIG has TWO independent broker settings
 * (the shared OMS_CONFIG.BROKER for Nine-Fifteen/MW, and
 * OMS_CONFIG.FIRST15.BROKER for the FIRST15_ORB strategy — see
 * oms-config.js). A wrong edit, a stale env var, or a future refactor
 * that accidentally passes the wrong config value into
 * getBrokerAdapter() would otherwise place a REAL order with the WRONG
 * broker/account with no error at all. Call this immediately before
 * every live order placement/exit so that class of mistake fails loudly
 * instead of silently trading on the wrong account.
 */
export function assertBrokerMatches(broker, expectedName, context = '') {
    const expected = normalizeBrokerName(expectedName);
    const actual = normalizeBrokerName(broker?.brokerName);

    if (!actual || actual !== expected) {
        throw new Error(
            `[Broker Safety Guard] Refusing to place order${context ? ` for ${context}` : ''}: ` +
            `expected broker "${expected}" (from OMS config) but got adapter tagged "${actual || 'UNKNOWN'}". ` +
            `This order was blocked before reaching the broker API.`
        );
    }
}

/**
 * Same idea as assertBrokerMatches, for the ACCOUNT: an exit for a trade that was entered on
 * ACC2 must never be sent through ACC1's session (that would open a fresh opposite position
 * on the wrong account instead of closing the real one).
 */
export function assertAccountMatches(broker, expectedAccountId, context = '') {
    const expected = (expectedAccountId || 'ACC1').toUpperCase();
    const actual = (broker?.accountId || 'ACC1').toUpperCase();
    if (actual !== expected) {
        throw new Error(
            `[Account Safety Guard] Refusing to place order${context ? ` for ${context}` : ''}: ` +
            `trade belongs to account "${expected}" but adapter is bound to "${actual}". Blocked before reaching the broker API.`
        );
    }
}
