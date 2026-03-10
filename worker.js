require('dotenv').config();
const { runAutomation, initializeBrowserPool } = require('./topup');
const logger = require('./logger');
const state = require('./state');
const { claimVouchers, updateVoucher, reportRateLimit } = require('./centralApi');
const { SERVER_ID } = require('./heartbeat');

const BROWSER_CONCURRENCY = parseInt(process.env.BROWSER_CONCURRENCY || '5', 10);
const AUTOMATION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes max per voucher
let isBrowserPoolInitialized = false;

// Sleep utility
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Timeout wrapper - rejects if a promise takes longer than `ms`
function withTimeout(promise, ms, label = 'Operation') {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function browserWorkerLoop(browserId) {
    console.log(`[Worker ${browserId}] Loop started.`);
    let lastAliveLog = Date.now();

    while (true) {
        if (state.getShuttingDown()) {
            console.log(`[Worker ${browserId}] Shutting down flag detected. Exiting loop.`);
            break;
        }

        try {
            // 1. Check Global Rate Limit
            if (state.getGlobalRateLimitActive()) {
                await sleep(15000);
                continue;
            }

            // 2. Local Delay Tuning
            await sleep(state.getWorkerDelay());

            // 3. Claim Voucher
            // Note: Each virtual worker claims 1 voucher at a time
            const response = await claimVouchers(SERVER_ID, 1);

            if (!response || !response.status || response.claimed_count === 0 || !response.vouchers || response.vouchers.length === 0) {
                // Queue is empty, wait a bit
                if (Date.now() - lastAliveLog > 60000) {
                    console.log(`[Worker ${browserId}] Alive - queue empty, polling...`);
                    lastAliveLog = Date.now();
                }
                await sleep(5000);
                continue;
            }

            const voucher = response.vouchers[0];

            await logger.logInfo(voucher.order_id, `Worker ${browserId} claimed voucher #${voucher.id} (retry: ${voucher.retry_count || 0})`);

            // Track locally for heartbeat & shutdown
            state.addClaimedId(voucher.id);

            // 4. Run Automation (with hard timeout to prevent infinite hangs)
            let result;
            try {
                // Map API object to runAutomation expected object
                result = await withTimeout(
                    runAutomation({
                        id: voucher.id,
                        order_id: voucher.order_id,
                        uid: voucher.player_id,
                        voucher_code: voucher.voucher_code,
                        voucher_denomination: voucher.voucher_denomination,
                        callback_url: voucher.callback_url // New field for pre-check
                    }),
                    AUTOMATION_TIMEOUT_MS,
                    `Automation for voucher ${voucher.id}`
                );
            } catch (autoErr) {
                console.error(`[Worker ${browserId}] Fatal automation error:`, autoErr.message);
                result = { status: 'failed', reason: autoErr.message || 'Fatal Node.js crash during automation' };
            }

            // Fix 4: null means "defer, don't report" (e.g., all proxies on cooldown)
            if (!result) {
                await logger.logWarn(voucher.order_id, `Voucher deferred (null result). Releasing claim.`);
                state.removeClaimedId(voucher.id);
                // Don't call updateVoucher — dead-lock recovery will reset it to pending
                continue;
            }

            const status = result.status || 'failed';
            const reason = result.reason || (status === 'failed' ? 'Automation failed unexpectedly.' : 'Completed');

            await logger.logInfo(voucher.order_id, `Voucher #${voucher.id} ${status}: ${reason}`, {
                voucher_id: voucher.id,
                final_status: status,
                reason: reason
            });

            // 5. Check if THIS worker hit a rate limit (Garena/UniPin block)
            // Fix 5: Only broadcast if we're the FIRST worker to detect it
            if (reason && (reason.toLowerCase().includes('rate limit') || reason.toLowerCase().includes('too many requests'))) {
                if (!state.getGlobalRateLimitActive()) {
                    console.warn(`[Worker ${browserId}] Detected Rate Limit! Broadcasting to central system.`);
                    state.setGlobalRateLimitActive(true);
                    // Report 1 minute cooldown to all servers
                    await reportRateLimit(SERVER_ID, true, 60, `Auto-detected rate limit by ${SERVER_ID}`);
                } else {
                    console.log(`[Worker ${browserId}] Rate limit already flagged by another worker. Skipping broadcast.`);
                }
            }

            // 6. Report Result to Central API
            const updatePayload = {
                voucher_id: voucher.id,
                order_id: voucher.order_id,
                status: status,
                transaction_id: result.transaction_id || null,
                validated_uid: result.validated_uid || null,
                screenshot_base64: null, // Set below
                reason: reason,
                // If it failed due to an invalid ID, don't let it retry
                retry: (status === 'failed' && (!reason || (!reason.toLowerCase().includes('invalid player id') && !reason.toLowerCase().includes('invalid_id'))))
            };

            // Attach JSON log as base64 (replaces screenshot for smart detection)
            // Small pause to let any remaining in-flight log writes for this order
            // finish flushing through the lock queue before we snapshot the file.
            await sleep(300);
            try {
                const logData = await logger.getOrderLogs(voucher.order_id);
                if (logData) {
                    updatePayload.screenshot_base64 = Buffer.from(JSON.stringify(logData)).toString('base64');
                } else if (result.screenshot_base64) {
                    // Fallback to legacy screenshot if log doesn't exist for some reason
                    updatePayload.screenshot_base64 = result.screenshot_base64;
                }
            } catch (logErr) {
                console.error(`[Worker ${browserId}] Failed to read log for order ${voucher.order_id}:`, logErr.message);
                updatePayload.screenshot_base64 = result.screenshot_base64 || null; // Fallback
            }

            try {
                const updateRes = await updateVoucher(SERVER_ID, updatePayload);
                if (updateRes && updateRes.order_finalized) {
                    await logger.logInfo(voucher.order_id, `Order fully complete. Central API sent final callback to WP endpoint.`);
                }
            } catch (postUpdateErr) {
                console.error(`[Worker ${browserId}] Critical error updating voucher status on central API:`, postUpdateErr.message);
                // At this point we did the top-up but couldn't report it.
                // It will sit in 'claimed' state until dead-lock recovery kicks in and resets it to 'pending'.
                // Then another worker will try it and likely get a 'consumed' response.
            }

            // 7. Cleanup
            state.removeClaimedId(voucher.id);

        } catch (error) {
            console.error(`[Worker ${browserId}] Main loop error:`, error);
            await sleep(5000);
        }
    }
}

async function startWorkerLoops() {
    console.log(`Starting ${BROWSER_CONCURRENCY} stateless worker loops...`);

    if (!isBrowserPoolInitialized) {
        await initializeBrowserPool();
        isBrowserPoolInitialized = true;
    }

    // Start all workers
    for (let i = 0; i < BROWSER_CONCURRENCY; i++) {
        // Run in background without awaiting, so they work concurrently
        browserWorkerLoop(i + 1).catch(err => {
            console.error(`Unhandled error in worker loop ${i + 1}:`, err);
        });

        // Fix 7: Stagger worker starts to avoid initial claim burst
        await sleep(2000);
    }
}

module.exports = { startWorkerLoops };