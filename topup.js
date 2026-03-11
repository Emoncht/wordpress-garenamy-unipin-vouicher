require('dotenv').config();
const { paymentLink, invalidateCachedDatadome } = require("./paymentLink");
const { processUnipinCheckout } = require('./unipinApi');
const logger = require('./logger');
const axios = require('axios');
const { acquireThrottle, isProxyOnCooldown, setProxyCooldown, acquirePlayerLock, setNextTopupAllowedAt, isUnipinProxyActive, activateUnipinProxy } = require('./state');

const fs = require('fs');
const path = require('path');

let cachedProxies = null;

const getProxies = () => {
    if (cachedProxies) return cachedProxies;

    // Priority 1: Read from proxies.txt file (one proxy per line)
    const proxyFilePath = path.join(__dirname, 'proxies.txt');
    try {
        const fileContent = fs.readFileSync(proxyFilePath, 'utf8');
        const proxies = fileContent.split('\n').map(p => p.trim()).filter(p => p.length > 0 && !p.startsWith('#'));
        if (proxies.length > 0) {
            console.log(`[Proxy] Loaded ${proxies.length} proxies from proxies.txt`);
            cachedProxies = proxies;
            return cachedProxies;
        }
    } catch (e) {
        // File doesn't exist, fall through to env var
    }

    // Priority 2: Fallback to ROTATING_PROXIES env var (backward compat)
    const proxyString = process.env.ROTATING_PROXIES;
    if (proxyString) {
        cachedProxies = proxyString.split('|').map(p => p.trim()).filter(p => p.length > 0);
        console.log(`[Proxy] Loaded ${cachedProxies.length} proxies from ROTATING_PROXIES env`);
        return cachedProxies;
    }

    // No proxies configured
    console.warn('[Proxy] No proxies configured. Running without proxy.');
    cachedProxies = [null];
    return cachedProxies;
};

// We keep the "pool" concept so the queue monitor and worker loop don't break,
// but they are now just lightweight virtual "slots" instead of heavy Chrome browsers!
const MAX_CONCURRENT_WORKERS = parseInt(process.env.BROWSER_CONCURRENCY || '5', 10);
const virtualPool = [];

async function initializeBrowserPool() {
    console.log(`Initializing virtual API worker pool with concurrency ${MAX_CONCURRENT_WORKERS}...`);
    virtualPool.length = 0;
    for (let i = 1; i <= MAX_CONCURRENT_WORKERS; i++) {
        virtualPool.push({ browserId: i, inUse: false, voucherId: null, orderId: null, startTime: null });
    }
    console.log(`Virtual API pool initialized.`);
}

function getBrowserPool() {
    return virtualPool;
}

// Dummy functions to satisfy worker.js interface without breaking
async function restartBrowser(browserId) {
    console.log(`[Restart] Virtual slot ${browserId} reset requested by watchdog.`);
    const existing = virtualPool.find(b => b.browserId === browserId);
    if (existing) {
        existing.inUse = false;
        existing.voucherId = null;
        existing.orderId = null;
        existing.startTime = null;
    }
}

async function acquireSlot(voucherId, orderId) {
    const available = virtualPool.find(b => !b.inUse);
    if (!available) return null;
    available.inUse = true;
    available.voucherId = voucherId;
    available.orderId = orderId;
    available.startTime = new Date();
    return available;
}

async function releaseSlot(slotId) {
    const existing = virtualPool.find(b => b.browserId === slotId);
    if (existing) {
        existing.inUse = false;
        existing.voucherId = null;
        existing.orderId = null;
        existing.startTime = null;
    }
}

// Same logic as before, but decoupled from Selenium/Puppeteer
async function checkVoucherStatus(voucher) {
    const orderId = voucher.order_id;
    const callbackUrl = voucher.callback_url; // Use callback_url passed from DB

    try {
        if (!callbackUrl) return { status: 'unknown', reason: 'Missing callbackUrl' };

        let checkUrl = callbackUrl.replace('/orders', '/check');
        if (checkUrl === callbackUrl && callbackUrl.includes('/wp-json/custom-order-plugin/v1')) {
            checkUrl = callbackUrl.substring(0, callbackUrl.indexOf('/v1') + 3) + '/check';
        }

        const response = await axios.post(checkUrl, { order_id: voucher.order_id }, {
            headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.WP_API_KEY },
            timeout: 10000
        });

        const vouchers = response.data?.vouchers || [];
        for (const externalVoucher of vouchers) {
            if ((externalVoucher.voucher_status === 'completed' || externalVoucher.voucher_status === 'consumed') && externalVoucher.voucher_code === voucher.voucher_code) {
                return { status: externalVoucher.voucher_status, transaction_id: externalVoucher.transaction_id };
            }
        }
        if (response.status === 200) return { status: 'pending', reason: 'Voucher not yet processed externally.' };
        return { status: 'unknown', reason: `Check API failed unexpectedly` };
    } catch (error) {
        if (error.response && (error.response.status === 404 || error.response.status === 401)) {
            return { status: 'pending', reason: 'Not tracked or auth failed.' };
        }
        return { status: 'unknown', reason: `Check API failed: ${error.message}` };
    }
}

async function runAutomation(voucher) {
    const orderId = voucher.order_id;
    // Fix 3: Acquire per-player lock to prevent concurrent Garena sessions for the same player
    const releasePlayerLock = await acquirePlayerLock(voucher.uid);

    try {
        await logger.initializeOrderLog(orderId, { voucher_id: voucher.id, player_id: voucher.uid, denomination: voucher.voucher_denomination });

        const proxies = getProxies();
        let lastError = null;

        // Fix 4: Pre-check — if ALL proxies are on cooldown, defer instead of failing
        const availableProxies = proxies.filter(p => !isProxyOnCooldown(p || 'no_proxy'));
        if (availableProxies.length === 0) {
            await logger.logWarn(orderId, 'All proxies are on captcha cooldown. Deferring voucher.');
            return null;  // null signals worker.js to defer, not report failure
        }

        // Randomize proxy array to distribute load evenly across all nodes
        const shuffledProxies = [...proxies].sort(() => 0.5 - Math.random());

        for (const proxy of shuffledProxies) {
            const proxyKey = proxy || 'no_proxy';

            // Skip proxies that are on captcha cooldown
            if (isProxyOnCooldown(proxyKey)) {
                await logger.logWarn(orderId, `Proxy ${proxyKey} is on captcha cooldown. Skipping.`);
                continue;
            }

            // Fix 1: Concurrency-safe throttle (replaces TOCTOU rate limiter)
            await acquireThrottle();

            try {
                // Pre-check state with external server
                const preCheckResult = await checkVoucherStatus(voucher);
                if (preCheckResult.status === 'completed' || preCheckResult.status === 'consumed') {
                    await logger.logInfo(orderId, `Voucher already processed externally. Skipping.`, { external_status: preCheckResult.status });
                    return { status: 'skipped_pre_checked', reason: 'Voucher already completed or consumed.' };
                }
            } catch (e) {
                await logger.logWarn(orderId, 'External pre-check failed. Proceeding with API Topup.', e.message);
            }

            // Acquire a virtual slot to restrict concurrency 
            const slotInfo = await acquireSlot(voucher.id, voucher.order_id);
            if (!slotInfo) {
                await logger.logWarn(orderId, 'No available API slot. Will retry.', { voucher_id: voucher.id });
                return null; // Worker will retry later
            }

            try {
                await logger.logInfo(orderId, `Generating payment link...`, { proxy: proxy ? 'yes' : 'direct' });

                // Step 1: Securely fetch Garena Payment Link URL
                const linkResult = await paymentLink(voucher.uid, proxy, orderId);

                if (linkResult.error) {
                    if (linkResult.error === 'captcha_detected') {
                        invalidateCachedDatadome(proxyKey); // Delete the poisoned datadome cookie!
                        setProxyCooldown(proxyKey); // Put this IP on 5-min cooldown
                        lastError = 'captcha_detected';
                        await logger.logWarn(orderId, `Captcha detected on proxy ${proxyKey}. Token purged. Proxy flagged for 5 min cooldown. Trying next proxy.`);
                        continue;
                    }
                    // Fatal errors that shouldn't be retried on another proxy
                    if (linkResult.error === 'invalid_id' || linkResult.error.includes('Player ID mismatch')) {
                        throw new Error(`Garena rejected player details: ${linkResult.error}`);
                    }

                    // Network or unknown errors from proxy. Log and try next.
                    lastError = linkResult.error;
                    await logger.logWarn(orderId, `Proxy ${proxyKey} failed to generate link: ${linkResult.error}. Trying next proxy.`);
                    continue;
                }

                await logger.logInfo(orderId, 'Payment link OK. Submitting to UniPin...');

                // Ensure voucher PINs are formatted securely
                const voucherParts = voucher.voucher_code.split(' ');
                if (voucherParts.length !== 2) throw new Error('Invalid voucher format. Expected "SERIAL PIN".');
                const pinBlocks = voucherParts[1].split('-');
                if (pinBlocks.length !== 4) throw new Error('Invalid PIN format. Expected "1234-5678-9012-3456".');

                const payloadDetails = {
                    denomination: voucher.voucher_denomination,
                    serial: voucherParts[0],
                    pinBlocks: pinBlocks
                };

                // Step 2: UniPin Checkout with Proxy Fallback Strategy
                // Try direct (free) first. If rate-limited, activate proxy for 60s and retry.
                const useProxyForUnipin = isUnipinProxyActive();
                const unipinProxy = useProxyForUnipin ? proxyKey : null;
                if (useProxyForUnipin) {
                    await logger.logInfo(orderId, 'UniPin routed through proxy (fallback active)');
                }

                let result = await processUnipinCheckout(linkResult.url, payloadDetails, unipinProxy);

                // If direct connection hit rate limit or network error (like timeout), activate proxy fallback and retry immediately
                const isNetworkFailure = result.status === 'failed' && (
                    result.reason === 'RATE_LIMIT_DETECTED' || 
                    (result.reason && result.reason.includes('HTTP API Exception'))
                );

                if (isNetworkFailure && !useProxyForUnipin) {
                    await logger.logWarn(orderId, 'UniPin direct connection failed (Rate Limit / Network Error). Activating proxy fallback for 60s and retrying...');
                    activateUnipinProxy(60000); // 1 minute proxy mode
                    result = await processUnipinCheckout(linkResult.url, payloadDetails, proxyKey);
                }

                // If still rate-limited even through proxy, engage global cooldown
                if (result.status === 'failed' && result.reason === 'RATE_LIMIT_DETECTED') {
                    await logger.logWarn(orderId, 'UniPin 429 persists through proxy. Engaging 35s global cooldown.');
                    setNextTopupAllowedAt(new Date(Date.now() + 35000));
                    lastError = 'RATE_LIMIT_DETECTED';
                    continue;
                }

                await logger.logInfo(orderId, `API native checkout completed`, { result_status: result.status, reason: result.reason });

                // The API doesn't generate screenshots, return null explicitly
                return {
                    status: result.status,
                    reason: result.reason,
                    screenshot_base64: null,
                    validated_uid: linkResult.validated_uid,
                    transaction_id: result.status === 'completed' ? 'API-FAST-TRACK' : null
                };

            } catch (error) {
                await logger.logError(orderId, 'API Checkout Exception', error, { voucher_id: voucher.id });
                return { status: 'failed', reason: error.message, screenshot_base64: null };
            } finally {
                await releaseSlot(slotInfo.browserId);
                await logger.logInfo(orderId, `Virtual Slot ${slotInfo.browserId} released.`);
            }
        }

        return { status: 'failed', reason: `All proxies failed. Last error: ${lastError || 'Rate limits exceeded.'}` };
    } finally {
        releasePlayerLock();
    }
}

module.exports = { runAutomation, initializeBrowserPool, restartBrowser, getBrowserPool };
