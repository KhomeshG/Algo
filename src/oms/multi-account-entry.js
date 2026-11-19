// Places ONE signal's entry order on several accounts IN PARALLEL (never one after another).
//
// Safety rules:
//  * Every account is attempted independently — one account failing/timing out never blocks
//    or cancels the others (Promise.allSettled).
//  * If at least one account got an order, the result is "placed" — the caller must treat the
//    signal as processed (retrying would double-order the accounts that already succeeded).
//  * If NO account got an order, the first error is thrown so the existing retry path runs.
//
// placeFn(signal, allocatedBalance, accountId) -> trade | null   (oms-worker's processSignal)
export async function placeEntryAcrossAccounts({ signal, accountIds, allocatedFor, placeFn, log = console }) {
    const started = Date.now();
    const settled = await Promise.allSettled(
        accountIds.map((id) => placeFn(signal, allocatedFor(id), id))
    );

    const trades = [];
    const failures = [];
    settled.forEach((r, i) => {
        const accountId = accountIds[i];
        if (r.status === 'fulfilled') {
            if (r.value) trades.push(r.value);
            else log.log(`[OMS][${accountId}] ${signal.symbol}: skipped (could not size / filtered) — no order placed on this account.`);
        } else {
            failures.push({ accountId, error: r.reason });
            log.error(`[OMS][${accountId}] ${signal.symbol}: entry FAILED — ${r.reason?.message || r.reason}`);
        }
    });

    log.log(`[OMS] ${signal.symbol}: ${trades.length}/${accountIds.length} account(s) placed in ${Date.now() - started}ms (parallel)`);

    if (!trades.length && failures.length) throw failures[0].error;
    return { trades, failures };
}

/** Log in every account at once (before any order), with a time limit; returns the ready ids. */
export async function prepareAccounts({ accountIds, getToken, timeoutMs = 45000, log = console }) {
    const withTimeout = (p) => Promise.race([
        p, new Promise((_, rej) => setTimeout(() => rej(new Error(`login timed out after ${timeoutMs / 1000}s`)), timeoutMs)),
    ]);
    const res = await Promise.allSettled(accountIds.map((id) => withTimeout(getToken(id))));
    const ready = [], notReady = [];
    res.forEach((r, i) => {
        if (r.status === 'fulfilled' && r.value) ready.push(accountIds[i]);
        else { notReady.push({ accountId: accountIds[i], error: r.reason?.message || 'no token' }); }
    });
    for (const n of notReady) log.error(`[OMS][${n.accountId}] NOT READY this cycle (${n.error}) — it will be skipped for this signal batch.`);
    return { ready, notReady };
}
