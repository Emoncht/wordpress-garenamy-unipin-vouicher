const fs = require('fs').promises;
const path = require('path');

class OrderLogger {
    constructor() {
        this.logsDir = path.join(__dirname, 'Logs');
        this.fileLocks = new Map(); // added async lock map
        this.ensureLogsDirectory();
    }

    async acquireTaskLock(key) {
        // Wait for previous lock on this key to resolve
        while (this.fileLocks.has(key)) {
            await this.fileLocks.get(key);
        }

        let releaseLock;
        const lockPromise = new Promise(resolve => { releaseLock = resolve; });
        this.fileLocks.set(key, lockPromise);

        return () => {
            this.fileLocks.delete(key);
            releaseLock();
        };
    }

    async ensureLogsDirectory() {
        try {
            await fs.access(this.logsDir);
        } catch (error) {
            await fs.mkdir(this.logsDir, { recursive: true });
            console.log(`Created Logs directory at: ${this.logsDir}`);
        }
    }

    getLogFilePath(orderId) {
        return path.join(this.logsDir, `${orderId}.json`);
    }

    async initializeOrderLog(orderId, orderData = {}) {
        const logFilePath = this.getLogFilePath(orderId);
        const release = await this.acquireTaskLock(orderId);

        try {
            // Try to read existing log first — if another voucher from the same order
            // already initialized this file, we must NOT overwrite it (data loss!)
            let existing = null;
            try {
                const raw = await fs.readFile(logFilePath, 'utf8');
                existing = JSON.parse(raw);
            } catch (e) {
                // File doesn't exist yet — that's fine, create fresh
            }

            if (!existing) {
                const initialLogEntry = {
                    order_id: orderId,
                    created_at: new Date().toISOString(),
                    order_data: orderData,
                    logs: []
                };
                await fs.writeFile(logFilePath, JSON.stringify(initialLogEntry, null, 2));
            }
            // If the file already exists (another voucher ran first), leave it intact.

            const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
            console.log(`[${timestamp}] [${orderId}] [INFO] Order log initialized`);
        } catch (error) {
            console.error(`Failed to initialize log file for order ${orderId}:`, error);
        } finally {
            release();
        }
    }

    async log(orderId, level, message, data = {}) {
        const logFilePath = this.getLogFilePath(orderId);

        const logEntry = {
            timestamp: new Date().toISOString(),
            level: level.toUpperCase(),
            message: message,
            data: data
        };

        const release = await this.acquireTaskLock(orderId);

        try {
            // Read existing log file
            let logFileContent;
            try {
                const fileContent = await fs.readFile(logFilePath, 'utf8');
                logFileContent = JSON.parse(fileContent);
            } catch (error) {
                // File doesn't exist, create initial structure
                logFileContent = {
                    order_id: orderId,
                    created_at: new Date().toISOString(),
                    order_data: {},
                    logs: []
                };
            }

            // Add new log entry
            logFileContent.logs.push(logEntry);
            logFileContent.last_updated = new Date().toISOString();

            // Write back to file
            await fs.writeFile(logFilePath, JSON.stringify(logFileContent, null, 2));

            // Console output
            const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
            const lvl = level.toUpperCase();

            // Build a short inline summary from key fields only
            let suffix = '';
            if (data && typeof data === 'object' && Object.keys(data).length > 0) {
                const important = ['status', 'final_status', 'result_status', 'reason', 'error_message', 'proxy', 'voucher_id', 'payment_url'];
                const parts = [];
                for (const key of important) {
                    if (data[key] !== undefined && data[key] !== null) {
                        const val = String(data[key]);
                        // Truncate long values like URLs
                        parts.push(`${key}=${val.length > 60 ? val.substring(0, 60) + '...' : val}`);
                    }
                }
                if (parts.length > 0) suffix = ` | ${parts.join(', ')}`;
            }

            console.log(`[${timestamp}] [${orderId}] [${lvl}] ${message}${suffix}`);

        } catch (error) {
            // Fallback to console if file logging fails
            console.error(`[LogError] Failed to write log for order ${orderId}: ${error.message}`);
            const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
            console.log(`[${timestamp}] [${orderId}] [${level.toUpperCase()}] ${message}`);
        } finally {
            release(); // Release file lock for next worker
        }
    }

    async logError(orderId, message, error, data = {}) {
        const errorData = {
            ...data,
            error_message: error?.message || error,
            error_stack: error?.stack || null
        };
        await this.log(orderId, 'error', message, errorData);
    }

    async logInfo(orderId, message, data = {}) {
        await this.log(orderId, 'info', message, data);
    }

    async logWarn(orderId, message, data = {}) {
        await this.log(orderId, 'warn', message, data);
    }

    async logDebug(orderId, message, data = {}) {
        await this.log(orderId, 'debug', message, data);
    }

    async pruneOldLogs(maxFiles = 100) {
        try {
            const files = await fs.readdir(this.logsDir);
            const jsonFiles = files.filter(f => f.endsWith('.json'));
            if (jsonFiles.length <= maxFiles) return;

            // Get stats and sort by modification time (oldest first)
            const fileStats = await Promise.all(jsonFiles.map(async f => {
                const fullPath = path.join(this.logsDir, f);
                try {
                    const stat = await fs.stat(fullPath);
                    return { file: fullPath, mtime: stat.mtimeMs };
                } catch (e) {
                    return null;
                }
            }));

            const validStats = fileStats.filter(s => s !== null);
            validStats.sort((a, b) => a.mtime - b.mtime);

            // Delete oldest files beyond the limit
            const toDelete = validStats.slice(0, validStats.length - maxFiles);
            for (const { file } of toDelete) {
                try {
                    await fs.unlink(file);
                } catch (e) {
                    // Ignore individual file deletion errors in background task
                }
            }
        } catch (error) {
            console.error('[Logger] Failed to prune old logs:', error.message);
        }
    }

    async finalizeOrderLog(orderId, finalStatus, summary = {}) {
        const logFilePath = this.getLogFilePath(orderId);
        const release = await this.acquireTaskLock(orderId);

        try {
            const fileContent = await fs.readFile(logFilePath, 'utf8');
            const logFileContent = JSON.parse(fileContent);

            logFileContent.final_status = finalStatus;
            logFileContent.completed_at = new Date().toISOString();
            logFileContent.summary = summary;

            await fs.writeFile(logFilePath, JSON.stringify(logFileContent, null, 2));

            // Prune old logs to keep disk usage low on ephemeral Koyeb instances
            await this.pruneOldLogs(100);
        } catch (error) {
            console.error(`Failed to finalize log file for order ${orderId}:`, error);
        } finally {
            release();
        }

        // NOTE: this.log() is called AFTER releasing the lock so it can acquire
        // the lock itself properly and not deadlock inside finalizeOrderLog.
        await this.log(orderId, 'info', 'Order processing completed', {
            final_status: finalStatus,
            summary: summary
        });
    }

    async getOrderLogs(orderId) {
        const logFilePath = this.getLogFilePath(orderId);

        try {
            const fileContent = await fs.readFile(logFilePath, 'utf8');
            return JSON.parse(fileContent);
        } catch (error) {
            console.error(`Failed to read log file for order ${orderId}:`, error);
            return null;
        }
    }
}

// Create a singleton instance
const orderLogger = new OrderLogger();

module.exports = orderLogger; 