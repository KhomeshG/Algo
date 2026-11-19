// ─────────────────────────────────────────────────────────────────────────
// LIVE PRICE BRIDGE
//
// fyers-socket.js already receives real, tick-by-tick prices from Fyers'
// market-data websocket for every symbol it's watching (every open trade,
// across all 3 strategies — Fyers is the shared market-data source; Wisdom/
// Shoonya are only used for order execution). Those ticks already live in
// that process's memory; the problem was only that the dashboard's web
// server (server.js) is a SEPARATE process and had no way to read them.
//
// Since both processes run on the same AWS box, the fix is a small
// localhost-only HTTP endpoint — no new broker connections, and it never
// touches order placement or the exit-decision logic at all. It is purely
// read-only: fyers-socket.js writes ticks into a Map as it always did for
// its own SL/target checks; this just also lets another process peek at
// that Map's current values.
//
// SECURITY: bound to 127.0.0.1 only (see the .listen() call in
// fyers-socket.js) — never reachable from outside this machine, only from
// another process on the same host.
// ─────────────────────────────────────────────────────────────────────────

export const LIVE_PRICE_PORT = Number(process.env.FYERS_LIVE_PRICE_PORT) || 4501;
export const LIVE_PRICE_URL = `http://127.0.0.1:${LIVE_PRICE_PORT}/live-prices`;

// A tick is only trusted if it arrived recently — if fyers-socket.js is
// down/restarting/disconnected, its last-known prices could be stale. Past
// this age we fall back to the broker's own LTP instead of showing a
// frozen Fyers price as if it were current.
export const LIVE_PRICE_MAX_AGE_MS = 15_000;

/**
 * Fetch the current live-price map from fyers-socket.js. Returns {} (never
 * throws) if that process isn't running, hasn't started its HTTP server
 * yet, or the request times out — callers should treat an empty result as
 * "no live overlay available, use the broker's own LTP instead."
 */
export async function fetchLivePrices(timeoutMs = 200) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(LIVE_PRICE_URL, { signal: controller.signal });
        if (!res.ok) return {};
        const json = await res.json();
        return json && typeof json === 'object' ? json : {};
    } catch (_) {
        // Fyers worker not running, still starting up, or a slow tick —
        // this is an expected, non-fatal condition, not an error to log
        // loudly on every single poll.
        return {};
    } finally {
        clearTimeout(timer);
    }
}