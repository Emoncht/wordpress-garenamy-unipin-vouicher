require('dotenv').config();
const { paymentLink, invalidateCachedDatadome } = require("./paymentLink");
const { processUnipinCheckout } = require('./unipinApi');
const logger = require('./logger');
const axios = require('axios');
const { acquireThrottle, isProxyOnCooldown, setProxyCooldown, acquirePlayerLock, setNextTopupAllowedAt } = require('./state');

const getProxies = () => {
    const proxyString = process.env.ROTATING_PROXIES;
    if (!proxyString) return [null];
    return proxyString.split('|').map(p => p.trim()).filter(p => p.length > 0);
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
    try {
        const order = orderRegistry.get(voucher.order_id);
        if (!order || !order.callbackUrl) return { status: 'unknown', reason: 'Missing callbackUrl' };

        let checkUrl = order.callbackUrl.replace('/orders', '/check');
        if (checkUrl === order.callbackUrl && order.callbackUrl.includes('/wp-json/custom-order-plugin/v1')) {
            checkUrl = order.callbackUrl.substring(0, order.callbackUrl.indexOf('/v1') + 3) + '/check';
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
        await logger.initializeOrderLog(orderId, { voucher_id: voucher.id, player_id: voucher.uid, voucher_code: voucher.voucher_code, voucher_denomination: voucher.voucher_denomination });

        const proxies = getProxies();
        let lastError = null;

        // Fix 4: Pre-check — if ALL proxies are on cooldown, defer instead of failing
        const availableProxies = proxies.filter(p => !isProxyOnCooldown(p || 'no_proxy'));
        if (availableProxies.length === 0) {
            await logger.logWarn(orderId, 'All proxies are on captcha cooldown. Deferring voucher.');
            return null;  // null signals worker.js to defer, not report failure
        }

        for (const proxy of proxies) {
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
                await logger.logInfo(orderId, `Generating payment link via API...`, { proxy: proxy || 'none' });

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
                    throw new Error(`Garena Link Gen Failed: ${linkResult.error}`);
                }

                await logger.logInfo(orderId, 'Payment link generated successfully. Proceeding to UniPin native API submission...', { payment_url: linkResult.url });

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

                // Step 2: Execute blazing-fast pure HTTP API UniPin Topup
                const result = await processUnipinCheckout(linkResult.url, payloadDetails, proxyKey);

                if (result.status === 'failed' && result.reason === 'RATE_LIMIT_DETECTED') {
                    await logger.logWarn(orderId, 'UniPin HTTP 429 Rate Limit Detected. Engaging 35s cooldown.');
                    setNextTopupAllowedAt(new Date(Date.now() + 35000));
                    lastError = 'RATE_LIMIT_DETECTED';
                    continue; // Try next proxy / loop
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

        return { status: 'Failed', reason: 'All proxies failed or rate limits exceeded.' };
    } finally {
        releasePlayerLock();
    }
}

module.exports = { runAutomation, initializeBrowserPool, restartBrowser, getBrowserPool };
