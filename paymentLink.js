const fetch = (...args) =>
    import("node-fetch").then(({ default: fetch }) => fetch(...args));
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');
const querystring = require('querystring');
const logger = require('./logger');

const RETRY_COUNT = 3;
const RETRY_DELAY = 2000; // 2 seconds

async function withRetries(fn, operationName, orderId) {
    for (let i = 0; i < RETRY_COUNT; i++) {
        try {
            const result = await fn();
            if (result) { // Assuming null/undefined is a retryable failure
                return result;
            }
            await logger.logWarn(orderId, `Operation ${operationName} returned a falsy result. Retrying...`, { attempt: i + 1 });
        } catch (error) {
            await logger.logWarn(orderId, `Operation ${operationName} failed with an error. Retrying...`, { attempt: i + 1, error: error.message });
        }
        if (i < RETRY_COUNT - 1) {
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
        }
    }
    await logger.logError(orderId, `Operation ${operationName} failed after ${RETRY_COUNT} attempts.`, null);
    return null; // Return null after all retries have failed
}

const agent = new https.Agent({
    keepAlive: true,
    rejectUnauthorized: false,
    secureProtocol: 'TLSv1_2_method'
});

function sanitizeHeaders(headers) {
    if (!headers) return {};
    const redacted = { ...headers };
    if (redacted['Cookie']) redacted['Cookie'] = '[REDACTED]';
    if (redacted['cookie']) redacted['cookie'] = '[REDACTED]';
    if (redacted['X-Csrf-Token']) redacted['X-Csrf-Token'] = '[REDACTED]';
    if (redacted['Authorization']) redacted['Authorization'] = '[REDACTED]';
    return redacted;
}

async function logRequest(orderId, label, { url, method, headers, body }) {
    try {
        await logger.logDebug(orderId, `${label} - request`, {
            url,
            method,
            headers: sanitizeHeaders(headers),
            body: typeof body === 'string' ? body.slice(0, 1000) : body
        });
    } catch (_) { }
}

async function logResponse(orderId, label, { status, headers, body }) {
    try {
        // Headers from fetch are an iterable; convert minimally
        const headersObj = typeof headers?.raw === 'function' ? headers.raw() : headers;
        const sanitized = sanitizeHeaders(headersObj || {});
        await logger.logDebug(orderId, `${label} - response`, {
            status,
            headers: sanitized,
            body: typeof body === 'string' ? body.slice(0, 2000) : body
        });
    } catch (_) { }
}

/**
 * Mimics a browser environment to get a valid DataDome cookie.
 * @param {string} url The target URL we intend to visit.
 * @param {string} orderId For structured per-order logging.
 * @returns {Promise<string|null>} The DataDome client ID (cookie value).
 */
/**
 * Generate realistic browser fingerprint values with slight randomization
 */
const generateFingerprint = () => {
    // Randomize some values slightly to avoid detection patterns
    const baseWidth = 1920;
    const baseHeight = 1080;
    const availHeight = 1040; // Taskbar takes ~40px

    // Generate realistic mouse movement data
    const mouseClicks = 2 + Math.floor(Math.random() * 4);
    const mouseMoves = 15 + Math.floor(Math.random() * 30);
    const scrolls = 3 + Math.floor(Math.random() * 8);
    const keyDowns = Math.floor(Math.random() * 6);
    const keyUps = keyDowns > 0 ? keyDowns - Math.floor(Math.random() * 2) : 0;

    return {
        jsData: {
            // Plugin detection
            "plg": 0, "plgod": false, "plgne": "NA", "plgre": "NA", "plgof": "NA",
            "plggt": "NA", "pltod": false,

            // Browser dimensions (consistent desktop Chrome)
            "br_h": 937, "br_w": 1920, "br_oh": 937, "br_ow": 1920,

            // JavaScript features
            "jsf": false, "cvs": true, "phe": false, "nm": false, "sln": null,

            // Local/session storage
            "lo": true, "lb": true,

            // Mouse position (null = not tracked yet, realistic)
            "mp_cx": null, "mp_cy": null, "mp_mx": null, "mp_my": null,
            "mp_sx": null, "mp_sy": null, "mp_tr": null, "mm_md": null,

            // Hardware
            "hc": 8,  // Hardware concurrency (CPU cores)

            // Screen resolution
            "rs_h": baseHeight, "rs_w": baseWidth, "rs_cd": 24,

            // User agent
            "ua": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",

            // Language & locale
            "lg": "en-US", "pr": 1,

            // Available screen (minus taskbar)
            "ars_h": availHeight, "ars_w": baseWidth,

            // Timezone: Malaysia is UTC+8, so offset is -480 minutes
            "tz": -480, "tzp": "Asia/Kuala_Lumpur",

            // Storage APIs
            "str_ss": true, "str_ls": true, "str_idb": true, "str_odb": true,

            // AbortController
            "abk": null,

            // Touch support (desktop = 0 or 1)
            "ts_mtp": 0, "ts_tec": false, "ts_tsa": false,

            // Screen orientation
            "so": "landscape-primary", "wo": 0, "sz": null,

            // WebDriver detection (must be false for non-bot)
            "wbd": false, "wbdm": false, "wdif": false, "wdifts": false, "wdifrm": false, "wdw": true,

            // Permissions
            "prm": true, "lgs": true, "lgsod": false,

            // USB
            "usb": "defined",

            // Vendor
            "vnd": "Google Inc.",

            // Build ID
            "bid": "NA",

            // MIME types & plugins
            "mmt": "application/pdf", "plu": "PDF Viewer,Chrome PDF Viewer,Chromium PDF Viewer,Microsoft Edge PDF Viewer,WebKit built-in PDF",

            // Features
            "hdn": false, "awe": false, "geb": false, "dat": false,
            "eva": 33, "med": "defined", "ocpt": false,

            // Video codecs support
            "vco": "probably", "vch": "probably", "vcw": "probably", "vc1": "probably",

            // Device memory
            "dvm": 8,

            // Various feature detections
            "sqt": false, "bgav": true, "rri": true, "idfr": true,
            "ancs": true, "inlc": true, "cgca": true, "inlf": true,
            "tecd": true, "sbct": true, "aflt": true, "rgp": true,
            "bint": true, "xr": false, "vpbq": true, "svde": false,

            // Cookie check string
            "cokys": "bG9hZFRpbWVzY3NpYXBwcnVudGltZQ==L="
        },
        eventCounters: {
            "mousemove": mouseMoves,
            "click": mouseClicks,
            "scroll": scrolls,
            "touchstart": 0,
            "touchend": 0,
            "touchmove": 0,
            "keydown": keyDowns,
            "keyup": keyUps
        }
    };
};

const datadomeTest = async (url, orderId) => {
    console.log("--- Generating DataDome cookie ---");
    const fp = generateFingerprint();
    const data = {
        jsData: JSON.stringify(fp.jsData),
        "eventCounters": JSON.stringify(fp.eventCounters),
        "jsType": "le",
        "ddk": "AE3F04AD3F0D3A462481A337485081",  // Garena Malaysia DDK (captured from real browser)
        "Referer": url,
        "request": new URL(url).pathname,
        "responsePage": "origin",
        "ddv": "5.1.11"  // Updated to current DataDome version
    };

    console.log("\n--- DataDome Request ---");
    const requestHeaders = {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
        "Origin": new URL(url).origin,
        "Referer": url,
    };
    console.log("URL: https://api-js.datadome.co/js/");
    console.log("Headers:", JSON.stringify(requestHeaders, null, 2));

    try {
        await logRequest(orderId, 'DataDome', { url: 'https://api-js.datadome.co/js/', method: 'POST', headers: requestHeaders, body: querystring.stringify(data).slice(0, 500) });

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 seconds timeout

        const response = await fetch("https://api-js.datadome.co/js/", {
            method: 'POST',
            headers: requestHeaders,
            body: querystring.stringify(data),
            signal: controller.signal
        });

        clearTimeout(timeoutId);
        const responseText = await response.text();
        await logResponse(orderId, 'DataDome', { status: response.status, headers: response.headers, body: responseText.slice(0, 1000) });
        const responseData = (() => { try { return JSON.parse(responseText); } catch { return {}; } })();
        const cookies = responseData.cookie || [];
        const datadomeCookie = Array.isArray(cookies) ? cookies.find(c => c.includes('datadome=')) : cookies;
        if (datadomeCookie) {
            const clientId = datadomeCookie.split(';')[0].split('=')[1];
            console.log("--- DataDome cookie generated successfully ---");
            await logger.logInfo(orderId, 'DataDome cookie generated');
            return clientId;
        }
        await logger.logWarn(orderId, 'DataDome cookie not found in response');
        return null;
    } catch (error) {
        if (error.name === 'AbortError') {
            console.error("--- DataDome cookie generation failed: Request timed out after 30 seconds ---");
            await logger.logError(orderId, 'DataDome cookie generation failed: Request timed out after 30 seconds', null);
        } else if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.message.includes('proxy')) {
            console.error("--- DataDome cookie generation failed: Proxy connection failed ---", error.message);
            await logger.logError(orderId, 'DataDome cookie generation failed: Proxy connection failed', error);
        } else {
            console.error("--- DataDome cookie generation failed ---", error.message);
            await logger.logError(orderId, 'DataDome cookie generation failed', error);
        }
        return null;
    }
}

/**
 * Uses a hardcoded, known-good request to get player details.
 * @param {string} playerId The player's ID to look up.
 * @param {string} sessionKey The existing session key for the player.
 * @param {string} proxy The proxy server to use for the request.
 * @returns {Promise<{cookie: string, csrfToken: string, nickname: string}|null>} An object containing session details, or null on failure.
 */
const getGarenaSession = async (playerId, sessionKey, proxy, orderId) => {
    const loginUrl = 'https://shop.garena.my/api/auth/player_id_login';
    console.log(`--- [1] Generating DataDome cookie... ---`);
    const datadomeCookie = await datadomeTest(loginUrl, orderId);
    if (!datadomeCookie) {
        console.error("Stopping: Failed to generate DataDome cookie.");
        await logger.logError(orderId, 'Stopping: Failed to generate DataDome cookie', null, { step: 'getGarenaSession' });
        return null;
    }
    console.log(`--- [2] Attempting login for Player ID: ${playerId} with FULL headers... ---`);

    // Constructing the full cookie using the provided sessionKey and the new datadome cookie.
    // All other parts are from your known-good example.
    const fullCookie = `region=MY; mspid2=6b7d0b83c5b0a3508e4deb8351ca9b27; language=en; _fbp=fb.1.1748296723121.844993683299681294; _ga=GA1.1.239634397.1748296724; source=pc; datadome=${datadomeCookie}; session_key=${sessionKey}`;

    const headers = {
        'Host': 'shop.garena.my',
        'Connection': 'keep-alive',
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        'Sec-Ch-Ua': '"Google Chrome";v="137", "Chromium";v="137", "Not A(Brand";v="24"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Origin': 'https://shop.garena.my',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Dest': 'empty',
        'Referer': 'https://shop.garena.my/?channel=202953',
        'Accept-Language': 'en-GB,en;q=0.9',
        'Cookie': fullCookie
    };

    const loginPayload = { app_id: 100067, login_id: playerId, app_server_id: 0 };

    console.log("\n--- Garena Login Request ---");
    console.log("URL:", loginUrl);
    console.log("Method: POST");
    console.log("Headers:", JSON.stringify(headers, null, 2));
    console.log("Body:", JSON.stringify(loginPayload, null, 2));

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 seconds timeout (increased for slow proxy)

        const fetchOptions = {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(loginPayload),
            signal: controller.signal
        };
        if (proxy) {
            const proxyAgent = new HttpsProxyAgent(proxy);
            fetchOptions.agent = proxyAgent;
        }
        await logRequest(orderId, 'Garena Login', { url: loginUrl, method: 'POST', headers, body: loginPayload });

        const response = await fetch(loginUrl, fetchOptions);
        clearTimeout(timeoutId);

        let responseData;
        const responseText = await response.text();
        try {
            responseData = JSON.parse(responseText);
        } catch (e) {
            responseData = responseText;
        }

        console.log("\n--- Garena Login Response ---");
        console.log("Status:", response.status);
        console.log("Headers:", JSON.stringify(response.headers.raw(), null, 2));
        console.log("Body:", JSON.stringify(responseData, null, 2));
        await logResponse(orderId, 'Garena Login', { status: response.status, headers: response.headers, body: responseData });

        if (!response.ok) {
            console.error(`Login failed with status ${response.status}.`);
            if (response.status === 403 && responseData && responseData.url && responseData.url.includes('captcha-delivery')) {
                console.warn('--- CAPTCHA DETECTED ---');
                await logger.logWarn(orderId, 'Garena login captcha detected');
                return { error: 'captcha_detected' };
            }
            await logger.logError(orderId, `Garena login failed with status ${response.status}`, null, { status: response.status, body: responseData });
            return null;
        }

        // Check for invalid_id error in response body (even with 200 status)
        if (responseData && responseData.error === 'invalid_id') {
            console.error('--- INVALID PLAYER ID DETECTED ---');
            await logger.logError(orderId, 'Garena login failed: Invalid Player ID', null, {
                player_id: playerId,
                error: 'invalid_id',
                response_body: responseData
            });
            return { error: 'invalid_id' };
        }

        // Enforce region: only BD is allowed. Treat others as invalid ID to trigger cleanup.
        if (responseData && responseData.region && String(responseData.region).toUpperCase() !== 'BD') {
            console.error('--- NON-BD REGION DETECTED ---');
            await logger.logError(orderId, 'Garena login failed: Player region not allowed', null, {
                player_id: playerId,
                region: responseData.region,
                expected_region: 'BD'
            });
            return { error: 'invalid_id' };
        }

        // Check if response contains expected data
        if (!responseData || !responseData.nickname) {
            console.error('Login response missing nickname or invalid format.');
            await logger.logError(orderId, 'Login response missing nickname or invalid format', null, {
                response_body: responseData,
                player_id: playerId
            });
            return null;
        }

        const newCookies = response.headers.raw()['set-cookie'];
        if (!newCookies) {
            console.error('Login successful, but no cookies were returned in the response.');
            await logger.logWarn(orderId, 'Login successful but no cookies returned');
            return null;
        }

        const fullCookieString = newCookies.map(c => c.split(';')[0]).join('; ');

        console.log(`--- [3] Session refreshed for player: ${responseData.nickname} ---`);
        await logger.logInfo(orderId, 'Garena session refreshed', { nickname: responseData.nickname });
        return {
            cookie: fullCookieString,
            nickname: responseData.nickname
        };
    } catch (error) {
        if (error.name === 'AbortError') {
            console.error('Garena session creation failed: Request timed out after 60 seconds');
            await logger.logError(orderId, 'Garena session creation failed: Request timed out after 60 seconds', null);
        } else if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.message.includes('proxy')) {
            console.error('Garena session creation failed: Proxy connection failed', error.message);
            await logger.logError(orderId, 'Garena session creation failed: Proxy connection failed', error);
        } else {
            console.error('An error occurred during session creation:', error.message);
            await logger.logError(orderId, 'Error during Garena session creation', error);
        }
        return null;
    }
};

/**
 * Makes a preflight request to get a CSRF token.
 * @param {string} loginCookie The cookie string from the successful login.
 * @param {string} proxy The proxy to use.
 * @returns {Promise<{fullCookie: string, csrfToken: string}|null>}
 */
const getCsrfToken = async (loginCookie, proxy, orderId) => {
    const preflightUrl = 'https://shop.garena.my/api/preflight';
    console.log(`\n--- [5] Making preflight request to get CSRF token... ---`);

    const headers = {
        'Host': 'shop.garena.my',
        'Connection': 'keep-alive',
        'Content-Length': '0',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Origin': 'https://shop.garena.my',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Dest': 'empty',
        'Referer': 'https://shop.garena.my/?channel=202953',
        'Accept-Language': 'en-GB,en;q=0.9',
        'Cookie': loginCookie
    };

    console.log("\n--- CSRF Token Request ---");
    console.log("URL:", preflightUrl);
    console.log("Method: POST");
    console.log("Headers:", JSON.stringify(headers, null, 2));

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 seconds timeout

        const fetchOptions = {
            method: 'POST',
            headers: headers,
            signal: controller.signal
        };
        if (proxy) {
            const proxyAgent = new HttpsProxyAgent(proxy);
            fetchOptions.agent = proxyAgent;
        }
        await logRequest(orderId, 'CSRF Preflight', { url: preflightUrl, method: 'POST', headers });
        const response = await fetch(preflightUrl, fetchOptions);
        clearTimeout(timeoutId);

        console.log("\n--- CSRF Token Response ---");
        console.log("Status:", response.status);
        console.log("Headers:", JSON.stringify(response.headers.raw(), null, 2));
        await logResponse(orderId, 'CSRF Preflight', { status: response.status, headers: response.headers, body: '[no body]' });

        const newCookies = response.headers.raw()['set-cookie'];
        if (!newCookies) {
            console.error('Preflight failed: No "set-cookie" header in response.');
            await logger.logError(orderId, 'Preflight failed: No set-cookie header in response', null);
            return null;
        }

        const csrfCookie = newCookies.find(c => c.includes('__csrf__='));
        if (!csrfCookie) {
            console.error('Preflight successful, but could not find CSRF token in response.');
            await logger.logError(orderId, 'Preflight successful but CSRF token not found');
            return null;
        }

        const csrfToken = csrfCookie.split(';')[0].split('=')[1];
        const fullCookieString = `${loginCookie}; ${csrfCookie.split(';')[0]}`;

        console.log(`--- [6] Successfully obtained CSRF token: ${csrfToken} ---`);
        await logger.logInfo(orderId, 'Obtained CSRF token');
        return { fullCookie: fullCookieString, csrfToken };

    } catch (error) {
        if (error.name === 'AbortError') {
            console.error('CSRF preflight request failed: Request timed out after 30 seconds');
            await logger.logError(orderId, 'CSRF preflight request failed: Request timed out after 30 seconds', null);
        } else if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.message.includes('proxy')) {
            console.error('CSRF preflight request failed: Proxy connection failed', error.message);
            await logger.logError(orderId, 'CSRF preflight request failed: Proxy connection failed', error);
        } else {
            console.error('An error occurred during preflight request:', error.message);
            await logger.logError(orderId, 'Error during CSRF preflight request', error);
        }
        return null;
    }
};

const paymentLink = async (playerId, sessionKey, proxy, orderId) => {
    return withRetries(async () => {
        await logger.logInfo(orderId, 'paymentLink: start', { playerId, using_proxy: Boolean(proxy) });
        const session = await getGarenaSession(playerId, sessionKey, proxy, orderId);

        if (session && session.error === 'captcha_detected') {
            await logger.logWarn(orderId, 'paymentLink: captcha detected during session creation');
            // Do not retry on captcha
            return { error: 'captcha_detected', details: 'Garena returned a captcha challenge.' };
        }

        if (session && session.error === 'invalid_id') {
            await logger.logError(orderId, 'paymentLink: invalid player id detected', null, {
                player_id: playerId,
                error: 'invalid_id'
            });
            // Do not retry on invalid ID
            return { error: 'invalid_id', details: 'Player ID is invalid according to Garena.' };
        }

        if (!session) {
            await logger.logError(orderId, 'paymentLink: failed to create/refresh session');
            // This will cause a retry
            return null;
        }

        console.log(`\n--- Verifying logged in Player ID... ---`);
        const verificationUrl = 'https://shop.garena.my/api/auth/get_user_info/multi';
        const verificationHeaders = { 'Cookie': session.cookie, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36', 'Referer': 'https://shop.garena.my/?channel=202953' };
        await logRequest(orderId, 'Verify Player', { url: verificationUrl, method: 'GET', headers: verificationHeaders });

        const controller2 = new AbortController();
        const timeoutId2 = setTimeout(() => controller2.abort(), 30000); // 30 seconds timeout

        const verificationResponse = await fetch(verificationUrl, {
            headers: verificationHeaders,
            signal: controller2.signal
        });
        clearTimeout(timeoutId2);
        const verificationData = await verificationResponse.json();
        await logResponse(orderId, 'Verify Player', { status: verificationResponse.status, headers: verificationResponse.headers, body: verificationData });
        console.log('--- Player Info Verification Response ---');
        console.log(JSON.stringify(verificationData, null, 2));

        if (!verificationData.player_id || String(verificationData.player_id.login_id) !== String(playerId)) {
            const returnedId = verificationData.player_id ? verificationData.player_id.login_id : 'N/A';
            await logger.logError(orderId, 'paymentLink: Player ID mismatch', null, { provided: playerId, returned: returnedId });
            // This is a permanent error, do not retry
            return { error: `Player ID mismatch. Provided: ${playerId}, Logged in as: ${returnedId}. ID not matched properly.` };
        }
        console.log(`--- [SUCCESS] Player ID verified: ${verificationData.player_id.nickname} ---`);
        await logger.logInfo(orderId, 'Verify Player: success', { nickname: verificationData.player_id.nickname });

        const preflight = await getCsrfToken(session.cookie, proxy, orderId);
        if (!preflight) {
            await logger.logError(orderId, 'paymentLink: Failed to get CSRF token from preflight request');
            // This will cause a retry
            return null;
        }

        try {
            console.log(`\n--- Initializing payment for ${session.nickname} ---`);
            const paymentUrl = 'https://shop.garena.my/api/shop/pay/init?language=en&region=MY';

            const paymentPostFields = {
                service: 'pc',
                app_id: 100067,
                packed_role_id: 0,
                channel_id: 221179,
                channel_data: {
                    payment_channel: null,
                    need_return: true,
                    invoice: []
                },
                revamp_experiment: {
                    session_id: '6b7d0b83c5b0a3508e4deb8351ca9b27',
                    group: 'treatment2',
                    service_version: 'mshop_frontend_20250626',
                    source: 'pc',
                    domain: 'shop.garena.my'
                }
            };

            const paymentHeaders = {
                'Host': 'shop.garena.my',
                'Cookie': preflight.fullCookie,
                'X-Csrf-Token': preflight.csrfToken,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'Origin': 'https://shop.garena.my',
                'Referer': 'https://shop.garena.my/?app=100067',
            };

            const controller3 = new AbortController();
            const timeoutId3 = setTimeout(() => controller3.abort(), 30000); // 30 seconds timeout

            const fetchOptions = {
                method: 'POST',
                headers: paymentHeaders,
                body: JSON.stringify(paymentPostFields),
                signal: controller3.signal
            };
            if (proxy) {
                fetchOptions.agent = new HttpsProxyAgent(proxy);
            }
            await logRequest(orderId, 'Pay Init', { url: paymentUrl, method: 'POST', headers: paymentHeaders, body: paymentPostFields });
            const response = await fetch(paymentUrl, fetchOptions);
            clearTimeout(timeoutId3);
            const paymentText = await response.text();
            const paymentData = (() => { try { return JSON.parse(paymentText); } catch { return {}; } })();
            await logResponse(orderId, 'Pay Init', { status: response.status, headers: response.headers, body: paymentData });

            if (!response.ok || !paymentData.init || !paymentData.init.url) {
                await logger.logError(orderId, 'paymentLink: Failed to initiate payment', null, { status: response.status, body_keys: Object.keys(paymentData || {}) });
                // This will cause a retry
                return null;
            }

            console.log('\n--- Success! ---');
            await logger.logInfo(orderId, 'paymentLink: success', { payment_url: paymentData.init.url });
            return { url: paymentData.init.url, validated_uid: verificationData.player_id.open_id };

        } catch (error) {
            if (error.name === 'AbortError') {
                await logger.logError(orderId, 'Payment link generation failed: Request timed out after 30 seconds', null);
            } else if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.message.includes('proxy')) {
                await logger.logError(orderId, 'paymentLink: Proxy connection failed', error);
            } else {
                await logger.logError(orderId, 'paymentLink: request setup failed', error);
            }
            // This will cause a retry
            return null;
        }
    }, 'paymentLink', orderId).then(result => {
        if (!result) {
            return { error: 'paymentLink process failed after multiple retries.' };
        }
        return result;
    });
};

module.exports = { paymentLink };
