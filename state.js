// state.js
// Holds all global cross-module state for this specific worker instance
// Note: orderRegistry has been removed since all global cross-server state is now managed by Topup Central MySQL database.

let nextTopupAllowedAt = new Date(0);
let globalRateLimitActive = false;
let isWorkerShuttingDown = false;
let workerDelayMs = 1000;

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

module.exports = {
    // Topup loops
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
};
