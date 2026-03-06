const express = require("express");
const { v4: uuidv4 } = require('uuid');
const session = require('express-session');
const passport = require('./auth'); // Our new passport config
const axios = require('axios');
const FormData = require('form-data');
const { URL } = require('url');

const { orderRegistry, getRateLimitActive } = require('./state');
const { startWorkerLoops } = require('./worker');
const { getBrowserPool } = require('./topup'); // Ensure we export this

const app = express();
const PORT = process.env.PORT || 4000;
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: false, limit: '50mb' }));

app.use(session({
    secret: process.env.SESSION_SECRET || 'a-very-secret-key-that-should-be-in-env-vars',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } // Set to true if HTTPS
}));

app.use(passport.initialize());
app.use(passport.session());

function isAuthenticated(req, res, next) {
    if (req.isAuthenticated()) {
        return next();
    }
    res.redirect('/login');
}

app.get('/login', (req, res) => {
    res.sendFile(__dirname + '/login.html');
});

app.post('/login', passport.authenticate('local', {
    successRedirect: '/monitor',
    failureRedirect: '/login',
}));

app.get('/logout', (req, res) => {
    req.logout(function (err) {
        if (err) { return next(err); }
        res.redirect('/login');
    });
});

async function uploadToImgBB(base64Image) {
    const apiKey = 'b5424b1f8e23b36a75ef9f35a97b7696';
    if (!base64Image) return null;

    try {
        const form = new FormData();
        form.append('image', base64Image);

        const response = await axios.post(`https://api.imgbb.com/1/upload?expiration=600&key=${apiKey}`, form, {
            headers: form.getHeaders(),
        });

        if (response.data && response.data.success) {
            console.log("Screenshot uploaded:", response.data.data.url);
            return response.data.data.url;
        }
        console.error("ImgBB upload failed:", response.data);
        return null;
    } catch (error) {
        console.error("Error uploading screenshot to ImgBB:", error.message);
        return null;
    }
}

app.post("/screenshot", async (req, res) => {
    const { voucher_id, screenshot_base64 } = req.body;

    if (!voucher_id || !screenshot_base64) {
        return res.status(400).json({ status: false, message: 'Missing voucher_id or screenshot_base64.' });
    }

    try {
        const screenshot_url = await uploadToImgBB(screenshot_base64);

        if (screenshot_url) {
            let found = false;
            for (const order of orderRegistry.values()) {
                const voucher = order.vouchers.find(v => v.id === voucher_id);
                if (voucher) {
                    voucher.screenshot_url = screenshot_url;
                    found = true;
                    break;
                }
            }

            if (found) {
                res.status(200).json({ status: true, message: "Screenshot saved.", screenshot_url: screenshot_url });
            } else {
                res.status(404).json({ status: false, message: "Voucher not found." });
            }
        } else {
            res.status(500).json({ status: false, message: "Failed to upload screenshot to ImgBB." });
        }
    } catch (error) {
        console.error(`Error saving screenshot for voucher ${voucher_id}:`, error);
        res.status(500).json({ status: false, message: "Internal server error." });
    }
});

app.post("/order", async (req, res) => {
    const { order_id, domain, order_items } = req.body;

    if (!order_id || !domain || !Array.isArray(order_items) || order_items.length === 0) {
        return res.status(400).json({ status: false, message: 'Invalid order payload structure.' });
    }

    try {
        const existingOrder = orderRegistry.get(order_id);

        if (existingOrder) {
            let completed = 0, consumed = 0, unprocessed = 0;

            existingOrder.vouchers.forEach(v => {
                if (v.status === 'Pending' || v.status === 'Failed') {
                    v.retry_count = 0; // Reset retries
                }

                if (v.status === 'completed' || v.status === 'Success' || v.status === 'success') completed++;
                else if (v.status === 'consumed') consumed++;
                else if (v.status === 'Pending' || v.status === 'Submitting' || v.status === 'Failed') unprocessed++;
            });

            if (unprocessed === 0) {
                try {
                    console.log(`[Order] All vouchers for order ${order_id} are processed. Triggering final callback.`);
                    if (!existingOrder.callbackUrl) {
                        console.error(`[Order] CRITICAL: No callbackUrl found for completed order ${order_id}. Cannot send callback.`);
                    } else {
                        const finalPayload = {
                            order_id: order_id,
                            order_status: 'success',
                            vouchers: existingOrder.vouchers.map(v => {
                                let timeTaken = 'N/A';
                                if (v.processing_started_at && v.completed_at) {
                                    const timeDiffSeconds = Math.floor((new Date(v.completed_at) - new Date(v.processing_started_at)) / 1000);
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
                                    screenshot: v.screenshot_url || null,
                                    transaction_id: v.transaction_id,
                                    validated_uid: v.validated_uid,
                                    timetaken: timeTaken
                                };
                            })
                        };

                        let totalTimeTaken = 'N/A';
                        if (existingOrder.createdAt) {
                            const totalTimeSeconds = Math.floor((new Date() - new Date(existingOrder.createdAt)) / 1000);
                            if (totalTimeSeconds > 0) {
                                totalTimeTaken = totalTimeSeconds < 60 ? `${totalTimeSeconds} seconds` : `${Math.floor(totalTimeSeconds / 60)} minutes ${totalTimeSeconds % 60} seconds`;
                            }
                        }

                        finalPayload.totaltimetaken = totalTimeTaken;

                        console.log(`[Order] Sending final callback payload to ${existingOrder.callbackUrl}`);
                        await axios.post(existingOrder.callbackUrl, { result: finalPayload });
                        console.log(`[Order] Successfully sent callback for existing completed order ${order_id}.`);
                    }
                } catch (error) {
                    console.error(`[Order] Error sending final callback for existing order ${order_id}: ${error.message}`);
                }
            }

            return res.status(200).json({
                status: true,
                message: "Order already exists. Here is the current status.",
                order_id: order_id,
                completed_voucher: completed,
                consumed_voucher: consumed,
                unprocessed_voucher: unprocessed,
            });
        }

        let callbackUrl = domain;
        try {
            const urlToParse = domain.startsWith('http') ? domain : `https://${domain}`;
            const parsedUrl = new URL(urlToParse);

            if (parsedUrl.pathname === '/') {
                const protocol = parsedUrl.hostname.includes('localhost') ? 'http://' : 'https://';
                const origin = `${protocol}${parsedUrl.host}`;
                callbackUrl = `${origin}/wp-json/custom-order-plugin/v1/orders`;
            } else {
                callbackUrl = parsedUrl.href;
            }
        } catch (error) {
            console.error(`Invalid domain/URL provided: ${domain}. Sticking with original value. Error: ${error.message}`);
            callbackUrl = domain;
        }

        const newOrder = {
            callbackUrl,
            createdAt: new Date(),
            vouchers: []
        };

        let totalVouchers = 0;
        for (const orderItem of order_items) {
            for (const item of orderItem.items) {
                for (const voucher of item.voucher_data) {
                    for (const voucherCode of voucher.voucher_codes) {
                        newOrder.vouchers.push({
                            id: uuidv4(),
                            order_id: order_id,
                            uid: orderItem.player_id,
                            voucher_code: voucherCode,
                            voucher_denomination: voucher.voucher_value,
                            status: 'Pending',
                            retry_count: 0,
                            reason: null,
                            screenshot_url: null,
                            transaction_id: null,
                            validated_uid: null,
                            processing_started_at: null,
                            completed_at: null,
                            failed_at: null
                        });
                        totalVouchers++;
                    }
                }
            }
        }

        orderRegistry.set(order_id, newOrder);

        res.status(201).json({
            status: true,
            message: `Order received. ${totalVouchers} vouchers have been added to the processing queue.`,
            order_id: order_id,
            total_vouchers_queued: totalVouchers
        });

    } catch (error) {
        console.error(`Error processing order ${order_id}:`, error);
        res.status(500).json({ status: false, message: "Internal server error." });
    }
});

app.get("/status", (req, res) => {
    try {
        let currently_processing = 0;
        let queue_length = 0;

        for (const order of orderRegistry.values()) {
            for (const v of order.vouchers) {
                if (v.status === 'Submitting') currently_processing++;
                else if (v.status === 'Pending') queue_length++;
            }
        }

        res.status(200).json({
            status: true,
            rate_limit_active: getRateLimitActive(),
            currently_processing,
            queue_length
        });
    } catch (error) {
        console.error('Error fetching system status:', error);
        res.status(500).json({ status: false, message: "Internal server error." });
    }
});

app.get("/monitor", isAuthenticated, (req, res) => {
    res.sendFile(__dirname + '/queue-monitor.html');
});

app.get("/queue-status", isAuthenticated, (req, res) => {
    try {
        let currently_processing = [];
        let processing_count = 0;
        let queue_length = 0;
        let pendingVouchers = [];

        // Check active browsers
        // Assuming getBrowserPool() returns [{ browserId, inUse, orderId, startTime }]
        let pool = typeof getBrowserPool === 'function' ? getBrowserPool() : [];
        const activeBrowsers = pool.filter(b => b.inUse).map(b => {
            const duration = b.startTime ? Math.floor((new Date() - b.startTime) / 1000) : 0;
            return {
                order_id: b.orderId || 'Unknown',
                browser_id: b.browserId,
                start_time: b.startTime,
                duration: duration
            };
        });

        for (const order of orderRegistry.values()) {
            for (const v of order.vouchers) {
                if (v.status === 'Submitting') {
                    processing_count++;
                    currently_processing.push(v.order_id);
                }
                else if (v.status === 'Pending') {
                    queue_length++;
                    pendingVouchers.push({
                        order_id: v.order_id,
                        voucher_id: v.id,
                        queued_at: order.createdAt
                    });
                }
            }
        }

        // Sort pending alphabetically by time
        pendingVouchers.sort((a, b) => new Date(a.queued_at) - new Date(b.queued_at));
        const queueDetails = pendingVouchers.slice(0, 10).map((pv, idx) => ({
            ...pv,
            position: idx + 1
        }));

        res.json({
            status: true,
            currently_processing: currently_processing, // order ids string array or actual active state
            queue_length: queue_length,
            active_browsers: activeBrowsers,
            queue_details: queueDetails
        });

    } catch (error) {
        console.error('Error fetching queue status:', error);
        res.status(500).json({ status: false, message: 'Internal Server Error' });
    }
});

app.listen(PORT, async () => {
    console.log(`Server listening on port ${PORT}`);
    // Start worker loops in the same node process
    await startWorkerLoops();
});
