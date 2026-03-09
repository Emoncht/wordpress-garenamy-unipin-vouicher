require('dotenv').config();
const axios = require('axios');
const logger = require('./logger');

const API_URL = process.env.CENTRAL_API_URL || 'http://localhost/wp-json/topup-central/v1';
const API_KEY = process.env.CENTRAL_API_KEY || 'CHANGE_ME_IN_ADMIN_PANEL';

const apiClient = axios.create({
    baseURL: API_URL,
    headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    },
    timeout: 30000 // 30 second timeout
});

// Helper for retrying failed requests
async function fetchWithRetry(requestFn, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await requestFn();
        } catch (error) {
            const status = error.response ? error.response.status : 'Network Error';
            // Don't retry 400s or 401s, they won't fix themselves
            if (status === 400 || status === 401 || status === 403 || status === 404) {
                throw error;
            }
            if (i === maxRetries - 1) throw error;

            // Exponential backoff
            const delay = Math.pow(2, i) * 1000 + Math.random() * 1000;
            console.warn(`[CentralAPI] Request failed (${status}). Retrying in ${Math.round(delay)}ms...`);
            await new Promise(res => setTimeout(res, delay));
        }
    }
}

/**
 * Claim processing slots from the central queue
 */
async function claimVouchers(serverId, maxVouchers = 1) {
    try {
        const response = await fetchWithRetry(() => apiClient.post('/vouchers/claim', {
            server_id: serverId,
            max_vouchers: maxVouchers
        }));
        return response.data;
    } catch (error) {
        if (error.response && error.response.status === 403) {
            console.error('[CentralAPI] Error claiming vouchers: 403 Forbidden. Is a WAF blocking the worker? Payload:', error.response.data);
        } else {
            console.error(`[CentralAPI] Error claiming vouchers:`, error.message);
        }
        return { status: false, vouchers: [], claimed_count: 0 };
    }
}

/**
 * Report processing results back to central API
 */
async function updateVoucher(serverId, payload) {
    // payload should have: voucher_id, order_id, status, reason, transaction_id, validated_uid, screenshot_base64, retry
    payload.server_id = serverId;
    try {
        const response = await fetchWithRetry(() => apiClient.post('/vouchers/update', payload));
        return response.data;
    } catch (error) {
        console.error(`[CentralAPI] Error updating voucher ${payload.voucher_id}:`, error.message);
        throw error;
    }
}

/**
 * Look up the live status of an order
 */
async function getOrderStatus(orderId) {
    try {
        const response = await fetchWithRetry(() => apiClient.get(`/vouchers/status/${orderId}`));
        return response.data;
    } catch (error) {
        if (error.response && error.response.status === 404) {
            return null; // Order doesn't exist
        }
        console.error(`[CentralAPI] Error fetching order status ${orderId}:`, error.message);
        return null;
    }
}

/**
 * Send server heartbeat to central API
 */
async function sendHeartbeat(serverId, payload) {
    // payload: label, active_voucher_ids, rate_limit_active, uptime_seconds
    payload.server_id = serverId;
    try {
        const response = await fetchWithRetry(() => apiClient.post('/servers/heartbeat', payload), 1); // Only 1 retry for heartbeats
        return response.data;
    } catch (error) {
        console.error(`[CentralAPI] Error sending heartbeat:`, error.message);
        return null;
    }
}

/**
 * Release claimed vouchers gracefully
 */
async function releaseVouchers(serverId, voucherIds, reason = 'Graceful shutdown') {
    try {
        const response = await apiClient.post('/vouchers/release', {
            server_id: serverId,
            voucher_ids: voucherIds,
            reason: reason
        });
        return response.data;
    } catch (error) {
        console.error(`[CentralAPI] Error releasing vouchers:`, error.message);
        throw error;
    }
}

/**
 * Broadcast a global rate limit event
 */
async function reportRateLimit(serverId, active, cooldownSeconds = 35, reason = 'Manual Rate Limit') {
    try {
        const response = await apiClient.post('/settings/rate-limit', {
            server_id: serverId,
            active: active,
            cooldown_seconds: cooldownSeconds,
            reason: reason
        });
        return response.data;
    } catch (error) {
        console.error(`[CentralAPI] Error reporting rate limit:`, error.message);
        throw error;
    }
}

module.exports = {
    claimVouchers,
    updateVoucher,
    getOrderStatus,
    sendHeartbeat,
    releaseVouchers,
    reportRateLimit
};
