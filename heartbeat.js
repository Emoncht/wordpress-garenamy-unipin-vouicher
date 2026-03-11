const { sendHeartbeat, releaseVouchers } = require('./centralApi');
const state = require('./state');

const SERVER_ID = process.env.SERVER_ID || (() => {
    if (process.env.RAILWAY_ENVIRONMENT) return `railway-${process.pid}`;
    if (process.env.RENDER) return `render-${process.pid}`;
    if (process.env.HEROKU_APP_ID) return `heroku-${process.pid}`;
    if (process.env.VERCEL) return `vercel-${process.pid}`;
    if (process.env.AWS_EXECUTION_ENV) return `aws-${process.pid}`;

    // Hostinger and generic cPanel VPS tend to be harder to detect securely, 
    // but they often set specific PWD or USER variables.
    const user = process.env.USER || process.env.USERNAME || 'unknown';
    const pwd = process.env.PWD || process.cwd();

    if (pwd.includes('hostinger') || user.includes('hostinger')) return `hostinger-${process.pid}`;

    // Fallback to local machine or unknown VPS
    return `server-${require('os').hostname()}-${process.pid}`;
})();
const HEARTBEAT_INTERVAL_MS = 30000; // 30 seconds

let heartbeatTimer = null;
let isShuttingDown = false;

async function startHeartbeatLoop() {
    console.log(`[Heartbeat] Starting loop for SERVER_ID: ${SERVER_ID}`);

    // Run immediately initially
    await performHeartbeat();

    // Then interval
    heartbeatTimer = setInterval(performHeartbeat, HEARTBEAT_INTERVAL_MS);
}

async function performHeartbeat() {
    if (isShuttingDown) return;

    const activeIds = state.getActiveClaimedIds();
    const rateLimitActive = state.getGlobalRateLimitActive();

    const payload = {
        label: `Node.js Worker [${require('os').hostname()}]`,
        active_voucher_ids: activeIds,
        rate_limit_active: rateLimitActive,
        uptime_seconds: process.uptime(),
        active_workers: state.getActiveWorkerCount()
    };

    try {
        const response = await sendHeartbeat(SERVER_ID, payload);

        if (response && response.status && response.config) {
            // Check global rate limit flag
            const centralRateLimit = response.config.global_rate_limit_active;

            if (centralRateLimit !== rateLimitActive) {
                if (centralRateLimit) {
                    console.warn(`[Heartbeat] Central API indicates ACTIVE global rate limit! Pausing workers.`);
                } else {
                    console.log(`[Heartbeat] Central API indicates global rate limit lifted. Resuming.`);
                }
                state.setGlobalRateLimitActive(centralRateLimit);
            }

            // Sync other configs later (e.g., batch sizing, delay MS)
            if (response.config.min_delay_ms) {
                state.setWorkerDelay(response.config.min_delay_ms);
            }

            if (response.config.scaling) {
                state.setScalingConfig({
                    minWorkers: response.config.scaling.min_workers,
                    maxWorkers: response.config.scaling.max_workers,
                    scaleThreshold: response.config.scaling.scale_threshold
                });
            }
        }
    } catch (error) {
        console.error('[Heartbeat] Loop error:', error.message);
    }
}

async function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n[GracefulShutdown] Received ${signal}. Starting shutdown process...`);

    if (heartbeatTimer) clearInterval(heartbeatTimer);

    // Stop worker loops
    state.setShuttingDown(true);

    const activeIds = state.getActiveClaimedIds();

    if (activeIds.length > 0) {
        console.log(`[GracefulShutdown] Releasing ${activeIds.length} claimed vouchers back to the queue...`);
        try {
            await releaseVouchers(SERVER_ID, activeIds, `Graceful shutdown (${signal})`);
            console.log('[GracefulShutdown] Vouchers released successfully.');
        } catch (err) {
            console.error('[GracefulShutdown] Failed to release vouchers:', err.message);
        }
    } else {
        console.log('[GracefulShutdown] No active vouchers to release.');
    }

    console.log('[GracefulShutdown] Ready to exit.');
    process.exit(0);
}

function setupShutdownHandlers() {
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    // Do NOT capture uncaughtException to shut down gracefully—crashing is better for fast docker restarts. Let PM2 handle it.
}

module.exports = {
    SERVER_ID,
    startHeartbeatLoop,
    setupShutdownHandlers
};
