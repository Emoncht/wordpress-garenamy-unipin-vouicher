// state.js
// Holds all global cross-module state for this specific worker instance
// Note: orderRegistry has been removed since all global cross-server state is now managed by Topup Central MySQL database.

let nextTopupAllowedAt = new Date(0);
let globalRateLimitActive = false;
let isWorkerShuttingDown = false;
let workerDelayMs = 1000;

// --- Async Throttle Queue (Fix 1) ---
// Guarantees minimum spacing (THROTTLE_MS) between Garena API calls,
// even when multiple async worker loops are running concurrently.
const THROTTLE_MS = 200;
let throttleQueue = Promise.resolve();

/**
 * Each caller awaits this function. It chains onto a shared Promise,
 * ensuring callers are serialized with at least THROTTLE_MS between them.
 * This is atomic because each call captures and replaces `throttleQueue`
 * synchronously (before any await), so the next caller always chains after.
 */
function acquireThrottle() {
    const myTurn = throttleQueue.then(() => {
        return new Promise(resolve => setTimeout(resolve, THROTTLE_MS));
    });
    throttleQueue = myTurn;  // Synchronous assignment — no race possible
    return myTurn;
}

// -- Active Claims (for heartbeat and graceful shutdown) --
const activeClaimedIds = new Set();
function getActiveClaimedIds() {
    return Array.from(activeClaimedIds);
}
function addClaimedId(id) {
    activeClaimedIds.add(id);
}
function removeClaimedId(id) {
    activeClaimedIds.delete(id);
}

// --- Proxy Captcha Cooldown ---
// Key: proxy string (or 'no_proxy'), Value: timestamp when cooldown expires
const proxyCooldownMap = new Map();
const PROXY_CAPTCHA_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

function isProxyOnCooldown(proxyKey) {
    const expiresAt = proxyCooldownMap.get(proxyKey);
    if (!expiresAt) return false;
    if (Date.now() < expiresAt) return true;
    proxyCooldownMap.delete(proxyKey); // expired, clean up
    return false;
}

function setProxyCooldown(proxyKey) {
    proxyCooldownMap.set(proxyKey, Date.now() + PROXY_CAPTCHA_COOLDOWN_MS);
    console.warn(`[Cooldown] Proxy ${proxyKey} is on captcha cooldown for 5 minutes.`);
}

// --- Per-Player-ID Lock (Fix 3) ---
// Prevents two concurrent workers from processing the same player simultaneously.
// Key: player_id string, Value: Promise that resolves when the worker finishes
const playerIdLocks = new Map();

/**
 * Acquires an exclusive lock on a Player ID.
 * If another worker is processing the same player, this waits until they finish.
 * Returns a release function that MUST be called when done.
 */
async function acquirePlayerLock(playerId) {
    // Wait for any existing lock to clear
    while (playerIdLocks.has(playerId)) {
        console.log(`[PlayerLock] Waiting for Player ID ${playerId} to be released by another worker...`);
        await playerIdLocks.get(playerId);
    }

    // Create a new lock — a promise that resolves when we call release()
    let releaseFn;
    const lockPromise = new Promise(resolve => { releaseFn = resolve; });
    playerIdLocks.set(playerId, lockPromise);

    return () => {
        playerIdLocks.delete(playerId);
        releaseFn(); // Unblock any waiting workers
    };
}

module.exports = {
    // Topup loops (concurrency-safe throttle)
    acquireThrottle,
    // Legacy accessors (kept for backward compat / rate-limit cooldown in topup.js)
    getNextTopupAllowedAt: () => nextTopupAllowedAt,
    setNextTopupAllowedAt: (date) => { nextTopupAllowedAt = date; },

    // Central API synced state
    getGlobalRateLimitActive: () => globalRateLimitActive,
    setGlobalRateLimitActive: (isActive) => { globalRateLimitActive = isActive; },

    // Heartbeats
    getActiveClaimedIds,
    addClaimedId,
    removeClaimedId,

    // Shutdown control
    getShuttingDown: () => isWorkerShuttingDown,
    setShuttingDown: (val) => { isWorkerShuttingDown = val; },

    // Delay tuning
    getWorkerDelay: () => workerDelayMs,
    setWorkerDelay: (val) => { workerDelayMs = val; },

    // Proxies
    isProxyOnCooldown,
    setProxyCooldown,

    // Player ID lock
    acquirePlayerLock,
};
