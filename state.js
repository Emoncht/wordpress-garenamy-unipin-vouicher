// state.js
// Holds all global cross-module state

const orderRegistry = new Map();
// Key: orderId (string)
// Value: {
//   callbackUrl: string,
//   createdAt: Date,
//   vouchers: [{
//     id: string (uuid),
//     order_id: string,
//     uid: string,           // player ID
//     voucher_code: string,
//     voucher_denomination: string,
//     status: 'Pending' | 'Submitting' | 'completed' | 'consumed' | 'Failed',
//     reason: string | null,
//     retry_count: number,
//     screenshot_base64: string | null,
//     screenshot_url: string | null,
//     transaction_id: string | null,
//     validated_uid: string | null,
//     processing_started_at: Date | null,
//     completed_at: Date | null,
//     failed_at: Date | null,
//   }]
// }

let nextTopupAllowedAt = new Date(0);
let rateLimitActive = false;

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
    orderRegistry,
    getNextTopupAllowedAt: () => nextTopupAllowedAt,
    setNextTopupAllowedAt: (date) => { nextTopupAllowedAt = date; },
    getRateLimitActive: () => rateLimitActive,
    setRateLimitActive: (isActive) => { rateLimitActive = isActive; },
    isProxyOnCooldown,
    setProxyCooldown,
};
