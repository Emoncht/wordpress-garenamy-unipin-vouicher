require('dotenv').config();
const { runAutomation, initializeBrowserPool, restartBrowser, getBrowserPool } = require('./topup');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const logger = require('./logger');
const { orderRegistry } = require('./state'); // Use in-memory state

const BROWSER_CONCURRENCY = parseInt(process.env.BROWSER_CONCURRENCY || '1', 10);
const screenshotCache = new Map();
let isBrowserPoolInitialized = false;

async function recoverStuckTasks() {
    console.log('[Recovery] Watchdog is checking for stuck tasks...');
    try {
        let stuckCount = 0;
        const now = Date.now();

        for (const [orderId, order] of orderRegistry.entries()) {
            for (const task of order.vouchers) {
                if ((task.status === 'Submitting' || task.status === 'Failed') && task.processing_started_at) {
                    const timeDiff = now - new Date(task.processing_started_at).getTime();
                    if (timeDiff > 3 * 60 * 1000) { // 3 minutes
                        stuckCount++;
                        console.warn(`[Recovery] Stuck task found ${task.id}. Resetting to 'Pending'.`);

                        await logger.logWarn(orderId, 'Task was stuck and recovered by watchdog', {
                            voucher_id: task.id,
                            recovery_reason: 'Task timed out after 3 minutes',
                            previous_status: task.status
                        });

                        task.status = 'Pending';
                        task.reason = 'Task timed out and was recovered by watchdog.';
                    }
                }
            }
        }

        if (stuckCount === 0) {
            // console.log('[Recovery] No stuck tasks found.');
        }
    } catch (error) {
        console.error('[Recovery] Error during task recovery:', error);
    }
}

async function claimNextVoucher(lastOrderId = null) {
    try {
        const now = Date.now();
        const isAvailable = (v) => {
            if (v.retry_count >= 5) return false;
            if (v.status === 'Pending') return true;
            if (v.status === 'Failed') {
                const timeSinceFail = v.failed_at ? (now - new Date(v.failed_at).getTime()) : Number.MAX_SAFE_INTEGER;
                return timeSinceFail > 30000; // 30 seconds
            }
            return false;
        };

        let claimedVoucher = null;

        // 1. Prioritize the last order (sticky)
        if (lastOrderId) {
            const order = orderRegistry.get(lastOrderId);
            if (order) {
                const availableVouchers = order.vouchers.filter(isAvailable);
                if (availableVouchers.length > 0) {
                    claimedVoucher = availableVouchers.find(v => v.status === 'Failed') || availableVouchers[0];
                }
            }
        }

        // 2. If no sticky voucher, try to claim any available new order
        if (!claimedVoucher) {
            let allAvailable = [];
            for (const [oId, order] of orderRegistry.entries()) {
                // Ensure no other voucher in this order is currently 'Submitting'
                const hasSubmitting = order.vouchers.some(v => v.status === 'Submitting');
                if (hasSubmitting) continue;

                const availableInOrder = order.vouchers.filter(isAvailable);
                if (availableInOrder.length > 0) {
                    availableInOrder.forEach(v => allAvailable.push({ voucher: v, orderCreatedAt: order.createdAt }));
                }
            }

            if (allAvailable.length > 0) {
                // Sort by Failed first, then by Order Created At
                allAvailable.sort((a, b) => {
                    if (a.voucher.status === 'Failed' && b.voucher.status !== 'Failed') return -1;
                    if (a.voucher.status !== 'Failed' && b.voucher.status === 'Failed') return 1;
                    return new Date(a.orderCreatedAt) - new Date(b.orderCreatedAt);
                });

                claimedVoucher = allAvailable[0].voucher;
            }
        }

        // 3. Mark as Submitting
        if (claimedVoucher) {
            claimedVoucher.status = 'Submitting';
            claimedVoucher.processing_started_at = new Date();
            return claimedVoucher;
        }

        return null;
    } catch (error) {
        console.error('[Worker] Error claiming next voucher:', error);
        return null;
    }
}

async function sendFailureCallback(voucher, reason, screenshot_base64) {
    const orderId = voucher.order_id;
    const isInvalidId = reason === 'Invalid Player ID';

    await logger.logInfo(orderId, `Order has a ${isInvalidId ? 'invalid ID' : 'failed'} voucher. Sending immediate callback`, {
        voucher_id: voucher.id,
        failure_reason: reason
    });

    try {
        const order = orderRegistry.get(orderId);
        if (!order || !order.callbackUrl) {
            await logger.logError(orderId, 'CRITICAL: No callbackUrl found for failed order', null, { voucher_id: voucher.id });
            return;
        }

        const failurePayload = {
            order_id: voucher.order_id,
            order_status: isInvalidId ? 'invalid_id' : 'failed',
            vouchers: [{
                uid: voucher.uid,
                voucher_code: voucher.voucher_code,
                voucher_denomination: voucher.voucher_denomination,
                status: isInvalidId ? 'invalid_id' : 'Failed',
                reason: reason,
                screenshot: screenshot_base64 || null,
                transaction_id: null,
                validated_uid: null,
                timetaken: 'N/A'
            }]
        };

        try {
            await logger.logInfo(orderId, `Sending ${isInvalidId ? 'invalid_id' : 'failure'} payload to callback URL`, {
                voucher_id: voucher.id,
                callback_url: order.callbackUrl,
                payload: failurePayload
            });
            const response = await axios.post(order.callbackUrl, { result: failurePayload });
            await logger.logInfo(orderId, `Successfully sent ${isInvalidId ? 'invalid_id' : 'failure'} callback`, {
                voucher_id: voucher.id,
                response_data: response.data
            });
        } catch (error) {
            await logger.logError(orderId, `Error sending ${isInvalidId ? 'invalid_id' : 'failure'} callback`, error, {
                voucher_id: voucher.id,
                callback_url: order.callbackUrl,
                response_status: error.response?.status,
                response_data: error.response?.data
            });
        }

    } catch (error) {
        await logger.logError(orderId, 'Error while preparing failure callback', error, { voucher_id: voucher.id });
    }
}


async function checkAndFinalizeOrder(orderId) {
    const order = orderRegistry.get(orderId);
    if (!order) return;

    const vouchers = order.vouchers;
    const hasNonFinalVouchers = vouchers.some(v => v.status === 'Pending' || v.status === 'Submitting' || v.status === 'Failed');
    const hasSuccessfulVouchers = vouchers.some(v => v.status === 'completed' || v.status === 'consumed' || v.status === 'Success' || v.status === 'success');

    const isOrderComplete = hasSuccessfulVouchers && !hasNonFinalVouchers;

    if (isOrderComplete) {
        await logger.logInfo(orderId, 'Order is complete. Sending final callback');

        try {
            if (!order.callbackUrl) {
                await logger.logError(orderId, 'CRITICAL: No callbackUrl found for completed order');
                return;
            }

            const finalPayload = {
                order_id: orderId,
                order_status: 'success',
                vouchers: vouchers.map(v => {
                    let timeTaken = 'N/A';
                    if (v.processing_started_at && v.completed_at) {
                        const startTime = new Date(v.processing_started_at);
                        const endTime = new Date(v.completed_at);
                        const timeDiffSeconds = Math.floor((endTime - startTime) / 1000);

                        if (timeDiffSeconds < 60) {
                            timeTaken = `${timeDiffSeconds} seconds`;
                        } else {
                            timeTaken = `${Math.floor(timeDiffSeconds / 60)} minutes ${timeDiffSeconds % 60} seconds`;
                        }
                    }

                    return {
                        uid: v.uid,
                        voucher_code: v.voucher_code,
                        voucher_denomination: v.voucher_denomination,
                        status: v.status,
                        reason: v.reason,
                        screenshot: screenshotCache.get(v.id) || null,
                        transaction_id: v.transaction_id,
                        validated_uid: v.validated_uid,
                        timetaken: timeTaken
                    };
                })
            };

            let totalTimeTaken = 'N/A';
            if (order.createdAt) {
                const totalTimeSeconds = Math.floor((new Date() - new Date(order.createdAt)) / 1000);
                if (totalTimeSeconds > 0) {
                    totalTimeTaken = totalTimeSeconds < 60 ? `${totalTimeSeconds} seconds` : `${Math.floor(totalTimeSeconds / 60)} minutes ${totalTimeSeconds % 60} seconds`;
                }
            }

            finalPayload.totaltimetaken = totalTimeTaken;

            try {
                await logger.logInfo(orderId, 'Sending final success payload to callback URL', {
                    callback_url: order.callbackUrl,
                    total_vouchers: finalPayload.vouchers.length,
                    total_time_taken: finalPayload.totaltimetaken
                });
                const response = await axios.post(order.callbackUrl, { result: finalPayload });
                await logger.logInfo(orderId, 'Successfully sent final callback', {
                    response_data: response.data
                });

                await logger.finalizeOrderLog(orderId, 'success', {
                    total_vouchers: finalPayload.vouchers.length,
                    total_time_taken: finalPayload.totaltimetaken,
                    callback_sent: true
                });
            } catch (error) {
                await logger.logError(orderId, 'Error sending final callback', error, {
                    callback_url: order.callbackUrl,
                    response_status: error.response?.status,
                    response_data: error.response?.data
                });
            }

            vouchers.forEach(v => screenshotCache.delete(v.id));

            // Delete order from registry once completed
            orderRegistry.delete(orderId);

        } catch (error) {
            await logger.logError(orderId, 'Error in checkAndFinalizeOrder function', error);
        }
    }
}

async function getCallbackUrl(orderId) {
    const order = orderRegistry.get(orderId);
    return order ? order.callbackUrl : null;
}

async function checkRemoteOrderStatus(orderId, voucherCode) {
    const callbackUrl = await getCallbackUrl(orderId);
    if (!callbackUrl) return null;

    let checkUrl = callbackUrl.replace('/orders', '/check');

    if (checkUrl === callbackUrl) {
        if (callbackUrl.includes('/wp-json/custom-order-plugin/v1')) {
            checkUrl = callbackUrl.substring(0, callbackUrl.indexOf('/v1') + 3) + '/check';
        }
    }

    try {
        const response = await axios.post(checkUrl, { order_id: orderId }, {
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': process.env.WP_API_KEY
            }
        });

        if (response.data && response.data.vouchers) {
            const remoteVoucher = response.data.vouchers.find(v => v.voucher_code === voucherCode);
            if (remoteVoucher) {
                return {
                    status: remoteVoucher.voucher_status,
                    screenshot_url: remoteVoucher.screenshot_url
                };
            }
        }
        return null;
    } catch (error) {
        if (error.response && error.response.status === 404) {
            return null;
        }

        // Don't crash processing if WP API fails, just log it and proceed normally
        const errorDetails = {
            status: error.response?.status,
            data: error.response?.data,
            message: error.message
        };
        await logger.logWarn(orderId, `checkRemoteOrderStatus WP API failed, continuing with topup normally.`, errorDetails);

        return null;
    }
}

async function sendProgressCallback(orderId, updatedVoucherId = null) {
    try {
        const order = orderRegistry.get(orderId);
        if (!order || !order.callbackUrl) return;

        const payload = {
            order_id: orderId,
            order_status: 'processing',
            vouchers: order.vouchers.map(v => {
                let timeTaken = 'N/A';
                if (v.processing_started_at && v.completed_at) {
                    const timeDiffSeconds = Math.floor((new Date(v.completed_at) - new Date(v.processing_started_at)) / 1000);
                    timeTaken = timeDiffSeconds < 60 ? `${timeDiffSeconds} seconds` : `${Math.floor(timeDiffSeconds / 60)} minutes ${timeDiffSeconds % 60} seconds`;
                }

                return {
                    uid: v.uid,
                    voucher_code: v.voucher_code,
                    voucher_denomination: v.voucher_denomination,
                    status: v.status,
                    reason: v.reason,
                    screenshot: screenshotCache.get(v.id) || null,
                    transaction_id: v.transaction_id,
                    validated_uid: v.validated_uid,
                    timetaken: timeTaken
                };
            })
        };

        await axios.post(order.callbackUrl, { result: payload });

        if (updatedVoucherId) {
            await logger.logInfo(orderId, 'Sent incremental progress update to WP', { voucher_id: updatedVoucherId });
        }
    } catch (error) {
        await logger.logError(orderId, `Failed to send progress callback`, error, {
            callback_url: order?.callbackUrl,
            response_status: error.response?.status,
            response_data: error.response?.data
        });
    }
}

async function browserWorkerLoop(browserId) {
    let lastOrderId = null;

    while (true) {
        try {
            const voucher = await claimNextVoucher(lastOrderId);

            if (voucher) {
                await logger.logInfo(voucher.order_id, `Browser ${browserId} claimed voucher for processing`, {
                    voucher_id: voucher.id,
                    browser_id: browserId
                });

                let result = null;

                try {
                    const remoteStatus = await checkRemoteOrderStatus(voucher.order_id, voucher.voucher_code);
                    if (remoteStatus && (remoteStatus.status === 'completed' || remoteStatus.status === 'consumed')) {
                        await logger.logInfo(voucher.order_id, `Voucher already processed remotely. Skipping automation.`, {
                            voucher_id: voucher.id,
                            remote_status: remoteStatus.status
                        });

                        voucher.status = remoteStatus.status;
                        voucher.screenshotUrl = remoteStatus.screenshot_url || null;
                        voucher.completed_at = new Date();

                        result = {
                            status: 'skipped_pre_checked',
                            reason: 'Already processed remotely',
                            screenshot_base64: null
                        };
                    }
                } catch (checkError) {
                    await logger.logError(voucher.order_id, 'Error checking remote order status', checkError, { voucher_id: voucher.id });
                }

                if (!result) {
                    result = await runAutomation(voucher);
                }

                if (result) {
                    if (result.status === 'skipped_pre_checked') {
                        await logger.logInfo(voucher.order_id, 'Voucher was pre-checked. Checking order status', { voucher_id: voucher.id });
                    } else {
                        const status = result.status || 'failed';
                        const reason = result.reason || (status === 'failed' ? 'Automation failed unexpectedly.' : 'Unknown outcome.');

                        await logger.logInfo(voucher.order_id, `Voucher processing completed with status: ${status}`, {
                            voucher_id: voucher.id,
                            final_status: status,
                            reason: reason,
                            transaction_id: result.transaction_id,
                            validated_uid: result.validated_uid
                        });

                        if (status === 'failed') {
                            voucher.status = 'Failed';
                            voucher.reason = reason;
                            voucher.retry_count = (voucher.retry_count || 0) + 1;
                            voucher.failed_at = new Date();
                            await sendFailureCallback(voucher, reason, result.screenshot_base64);
                        } else if (status === 'Failed' && reason === 'Invalid Player ID') {
                            voucher.retry_count = (voucher.retry_count || 0) + 1;
                            await logger.logInfo(voucher.order_id, 'Invalid Player ID detected. Sending callback and deleting order/vouchers', {
                                voucher_id: voucher.id,
                                reason: reason
                            });

                            try {
                                await sendFailureCallback(voucher, 'Invalid Player ID', result.screenshot_base64);
                                orderRegistry.delete(voucher.order_id);
                                continue;
                            } catch (deleteError) {
                                await logger.logError(voucher.order_id, 'Failed to delete order and vouchers', deleteError, {
                                    voucher_id: voucher.id,
                                    order_id: voucher.order_id
                                });
                                voucher.status = 'Failed';
                                voucher.reason = reason;
                                voucher.retry_count = (voucher.retry_count || 0) + 1;
                                voucher.failed_at = new Date();
                            }
                        } else {
                            voucher.status = status;
                            voucher.reason = reason;
                            voucher.validated_uid = result.validated_uid || null;
                            voucher.transaction_id = result.transaction_id || null;
                            voucher.completed_at = new Date();
                        }

                        if (result.screenshot_base64) {
                            screenshotCache.set(voucher.id, result.screenshot_base64);
                            await logger.logInfo(voucher.order_id, 'Screenshot cached', { voucher_id: voucher.id });
                        }

                        await sendProgressCallback(voucher.order_id, voucher.id);
                    }
                }

                await checkAndFinalizeOrder(voucher.order_id);
                lastOrderId = voucher.order_id;

                if (result && (result.status === 'completed' || result.status === 'consumed' || result.status === 'success')) {
                    await logger.logInfo(voucher.order_id, 'Waiting 1 second cooldown before next topup to avoid rate limits', {
                        voucher_id: voucher.id,
                        browser_id: browserId
                    });
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }

            } else {
                if (lastOrderId) {
                    lastOrderId = null;
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

        } catch (error) {
            console.error(`[Worker] Critical error in browser ${browserId} loop:`, error);
            if (lastOrderId) {
                await logger.logError(lastOrderId, `Critical error in browser ${browserId} loop`, error, { browser_id: browserId });
                lastOrderId = null;
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
}

async function startWorkerLoops() {
    console.log('--- Worker Process Started ---');
    await recoverStuckTasks();
    setInterval(recoverStuckTasks, 60000);

    await initializeBrowserPool();
    isBrowserPoolInitialized = true;
    console.log('--- Browser Pool Initialized ---');

    for (let browserId = 1; browserId <= BROWSER_CONCURRENCY; browserId++) {
        browserWorkerLoop(browserId);
        console.log(`[Worker] Started worker loop for Browser ${browserId}`);
    }
}

module.exports = { startWorkerLoops };