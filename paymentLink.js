const axios = require('axios');
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');
const querystring = require('querystring');
const logger = require('./logger');
const fs = require('fs');
const path = require('path');

// --- Residential Proxy Pool (high-quality, used ONLY for DataDome + login) ---
let cachedResidentialProxies = null;
function getResidentialProxies() {
    if (cachedResidentialProxies) return cachedResidentialProxies;
    try {
        const filePath = path.join(__dirname, 'residentialproxy.txt');
        const content = fs.readFileSync(filePath, 'utf8');
        cachedResidentialProxies = content.split('\n').map(p => p.trim()).filter(p => p.length > 0 && !p.startsWith('#'));
        if (cachedResidentialProxies.length > 0) {
            console.log(`[ResProxy] Loaded ${cachedResidentialProxies.length} residential proxies`);
            return cachedResidentialProxies;
        }
    } catch (e) {
        console.warn('[ResProxy] Failed to load residentialproxy.txt:', e.message);
    }
    cachedResidentialProxies = [];
    return cachedResidentialProxies;
}

function pickRandomResidentialProxy() {
    const proxies = getResidentialProxies();
    if (proxies.length === 0) return null;
    const proxy = proxies[Math.floor(Math.random() * proxies.length)];
    // Add http:// prefix if missing
    return proxy.startsWith('http') ? proxy : `http://${proxy}`;
}

// --- DataDome Cookie Cache ---
// Key: proxy string (or 'no_proxy'), Value: { cookie: string, createdAt: number }
const datadomeCacheMap = new Map();
const DATADOME_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function getCachedDatadome(proxyKey) {
    const entry = datadomeCacheMap.get(proxyKey);
    if (entry && (Date.now() - entry.createdAt < DATADOME_CACHE_TTL)) {
        return entry.cookie;
    }
    datadomeCacheMap.delete(proxyKey);
    return null;
}

function setCachedDatadome(proxyKey, cookie) {
    datadomeCacheMap.set(proxyKey, { cookie, createdAt: Date.now() });
}

function invalidateCachedDatadome(proxyKey) {
    datadomeCacheMap.delete(proxyKey);
}

// --- Per-proxy regeneration lock (Fix 2) ---
// Prevents thundering herd: only one worker regenerates the cookie per proxy,
// others wait for the same result.
const datadomeRegenerationLocks = new Map();

/**
 * Get or regenerate a DataDome cookie. If another worker is already
 * regenerating for the same proxy, wait for that result instead of
 * firing a duplicate request.
 */
async function getOrRegenerateDatadome(url, orderId, proxyKey) {
    // 1. Check cache (fast path)
    const cached = getCachedDatadome(proxyKey);
    if (cached) {
        console.log(`--- DataDome cookie served from cache (key: ${proxyKey}) ---`);
        await logger.logInfo(orderId, 'DataDome cookie served from cache', { proxyKey });
        return cached;
    }

    // 2. Check if another worker is already regenerating
    const existingLock = datadomeRegenerationLocks.get(proxyKey);
    if (existingLock) {
        console.log(`[DataDome] Worker waiting for in-flight regeneration (proxy: ${proxyKey})`);
        return existingLock;
    }

    // 3. This worker becomes the regenerator
    const regenerationPromise = (async () => {
        try {
            return await _rawDatadomeGenerate(url, orderId, proxyKey);
        } finally {
            datadomeRegenerationLocks.delete(proxyKey);
        }
    })();

    datadomeRegenerationLocks.set(proxyKey, regenerationPromise);
    return regenerationPromise;
}

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
    rejectUnauthorized: false
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
    // --- Randomized browser profiles to avoid fingerprint correlation ---
    // Pick from realistic desktop resolution pools
    const resolutionPool = [
        { w: 1920, h: 1080, avail_h: 1040 },
        { w: 1920, h: 1080, avail_h: 1032 },
        { w: 1536, h: 864, avail_h: 824 },
        { w: 1366, h: 768, avail_h: 728 },
        { w: 2560, h: 1440, avail_h: 1400 },
        { w: 1440, h: 900, avail_h: 860 },
    ];
    const res = resolutionPool[Math.floor(Math.random() * resolutionPool.length)];

    // Randomize browser window height (inner height varies by toolbar/bookmarks)
    const br_h = res.avail_h - Math.floor(Math.random() * 40); // e.g., 992-1032
    const br_w = res.w;

    // Randomized hardware concurrency (common values: 4, 8, 12, 16)
    const hcPool = [4, 8, 8, 8, 12, 16];
    const hc = hcPool[Math.floor(Math.random() * hcPool.length)];

    // Randomized device memory (common values: 4, 8, 16)
    const dvmPool = [4, 8, 8, 8, 16];
    const dvm = dvmPool[Math.floor(Math.random() * dvmPool.length)];

    // Generate realistic mouse movement & interaction data
    const mouseClicks = 2 + Math.floor(Math.random() * 5);   // 2-6 clicks
    const mouseMoves = 20 + Math.floor(Math.random() * 60);  // 20-79 moves
    const scrolls = 1 + Math.floor(Math.random() * 6);       // 1-6 scrolls
    const keyDowns = 5 + Math.floor(Math.random() * 12);     // 5-16 keydowns (typing player ID)
    const keyUps = Math.max(0, keyDowns - Math.floor(Math.random() * 2));

    // Generate plausible mouse positions (player ID input is near bottom-center of page)
    // These should NOT be null when mousemove count > 0
    const mp_cx = 350 + Math.floor(Math.random() * 400);  // current X: 350-749
    const mp_cy = 650 + Math.floor(Math.random() * 200);  // current Y: 650-849
    const mp_mx = mp_cx + Math.floor(Math.random() * 100) - 50; // max X: near current
    const mp_my = mp_cy + Math.floor(Math.random() * 80) - 40;  // max Y: near current
    const mp_sx = Math.floor(Math.random() * 200);         // scroll X: 0-199
    const mp_sy = Math.floor(Math.random() * 400);         // scroll Y: 0-399
    const mp_tr = mouseMoves > 0;                          // tracking active
    const mm_md = 200 + Math.floor(Math.random() * 1500);  // mouse movement duration ms

    // Randomize modern Chrome version to prevent static User-Agent block listing
    const chromeVersions = [134, 135, 136, 137, 138];
    const chromeVersion = chromeVersions[Math.floor(Math.random() * chromeVersions.length)];
    const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion}.0.0.0 Safari/537.36`;
    const secChUa = `"Google Chrome";v="${chromeVersion}", "Chromium";v="${chromeVersion}", "Not A(Brand";v="24"`;

    return {
        jsData: {
            // Plugin detection (Must be >0 since we list plugins below)
            "plg": 5, "plgod": false, "plgne": "NA", "plgre": "NA", "plgof": "NA",
            "plggt": "NA", "pltod": false,

            // Browser dimensions (randomized from pool)
            "br_h": br_h, "br_w": br_w, "br_oh": br_h, "br_ow": br_w,

            // JavaScript features
            "jsf": false, "cvs": true, "phe": false, "nm": false, "sln": null,

            // Local/session storage
            "lo": true, "lb": true,

            // Mouse position (randomized, consistent with event counters)
            "mp_cx": mp_cx, "mp_cy": mp_cy, "mp_mx": mp_mx, "mp_my": mp_my,
            "mp_sx": mp_sx, "mp_sy": mp_sy, "mp_tr": mp_tr, "mm_md": mm_md,

            // Hardware (randomized)
            "hc": hc,

            // Screen resolution (randomized from pool)
            "rs_h": res.h, "rs_w": res.w, "rs_cd": 24,

            // User agent (Randomized)
            "ua": userAgent,

            // Language & locale
            "lg": "en-US", "pr": 1,

            // Available screen (from pool)
            "ars_h": res.avail_h, "ars_w": res.w,

            // Timezone: Bangladesh is UTC+6, offset is -360 minutes
            "tz": -360, "tzp": "Asia/Dhaka",

            // Storage APIs
            "str_ss": true, "str_ls": true, "str_idb": true, "str_odb": true,

            // AbortController
            "abk": null,

            // Touch support (desktop = 0)
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

            // MIME types & plugins (Contains 5 plugins, so plg=5)
            "mmt": "application/pdf", "plu": "PDF Viewer,Chrome PDF Viewer,Chromium PDF Viewer,Microsoft Edge PDF Viewer,WebKit built-in PDF",

            // Features
            "hdn": false, "awe": false, "geb": false, "dat": false,
            "eva": 33, "med": "defined", "ocpt": false,

            // Video codecs support
            "vco": "probably", "vch": "probably", "vcw": "probably", "vc1": "probably",

            // Device memory (randomized)
            "dvm": dvm,

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

const _rawDatadomeGenerate = async (url, orderId, proxyKey = 'no_proxy') => {

    console.log("--- Generating fresh DataDome cookie ---");
    const fp = generateFingerprint();
    const data = {
        jsData: JSON.stringify(fp.jsData),
        "eventCounters": JSON.stringify(fp.eventCounters),
        "jsType": "le",
        "ddk": "AE3F04AD3F0D3A462481A337485081",
        "Referer": url,
        "request": new URL(url).pathname,
        "responsePage": "origin",
        "ddv": "5.4.0"
    };

    // Reconstruct generated UserAgent and secChUa based on matched Chrome version from fingerprint
    const matchedUA = fp.jsData.ua;
    const matchedVersion = matchedUA.match(/Chrome\/(\d+)\./)[1];
    const matchedSecChUa = `"Google Chrome";v="${matchedVersion}", "Chromium";v="${matchedVersion}", "Not A(Brand";v="24"`;

    const requestHeaders = {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": matchedUA,
        "Origin": new URL(url).origin,
        "Referer": url,
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Sec-Ch-Ua": matchedSecChUa,
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": "\"Windows\"",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-site"
    };

    try {
        const DATADOME_ENDPOINT = 'https://datadome.garena.com/js/';
        await logRequest(orderId, 'DataDome', { url: DATADOME_ENDPOINT, method: 'POST', headers: requestHeaders, body: querystring.stringify(data).slice(0, 500) });

        const axiosConfig = {
            headers: requestHeaders,
            timeout: 30000,
            validateStatus: (s) => s < 600 // Don't throw ugly exceptions on 502 from proxy
        };
        if (proxyKey !== 'no_proxy') {
            axiosConfig.httpsAgent = new HttpsProxyAgent(proxyKey);
        }

        const response = await axios.post(DATADOME_ENDPOINT, querystring.stringify(data), axiosConfig);

        if (response.status >= 400) {
            await logResponse(orderId, 'DataDome (Error)', { status: response.status, headers: response.headers, body: JSON.stringify(response.data).slice(0, 1000) });
            await logger.logWarn(orderId, `DataDome generation returned status ${response.status}`, { proxyKey });
            return null;
        }

        await logResponse(orderId, 'DataDome', { status: response.status, headers: response.headers, body: JSON.stringify(response.data).slice(0, 1000) });
        const responseData = response.data || {};
        const cookies = responseData.cookie || [];
        const datadomeCookie = Array.isArray(cookies) ? cookies.find(c => c.includes('datadome=')) : cookies;
        if (datadomeCookie) {
            const clientId = datadomeCookie.split(';')[0].split('=')[1];
            console.log("--- DataDome cookie generated and cached successfully ---");
            setCachedDatadome(proxyKey, clientId);
            await logger.logInfo(orderId, 'DataDome cookie generated and cached', { proxyKey });
            return clientId;
        }
        await logger.logWarn(orderId, 'DataDome cookie not found in response');
        return null;
    } catch (error) {
        if (error.code === 'ECONNABORTED') {
            console.error("--- DataDome cookie generation failed: Request timed out ---");
            await logger.logError(orderId, 'DataDome cookie generation timed out', null);
        } else if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
            console.error("--- DataDome cookie generation failed: Connection error ---", error.message);
            await logger.logError(orderId, 'DataDome cookie generation connection error', error);
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
const getGarenaSession = async (playerId, proxy, orderId, _isRetryAfterCacheInvalidation = false) => {
    const loginUrl = 'https://shop.garena.my/api/auth/player_id_login';

    // Pick a high-quality residential proxy for DataDome + login only
    const resProxy = pickRandomResidentialProxy();
    const proxyKey = resProxy || 'no_proxy';
    const sessionAgent = resProxy ? new HttpsProxyAgent(resProxy) : undefined;

    let proxyExitIp = 'Unknown';
    if (sessionAgent) {
        try {
            const ipRes = await axios.get('https://api.ipify.org?format=json', {
                httpsAgent: sessionAgent,
                timeout: 8000
            });
            proxyExitIp = ipRes.data.ip;
            console.log(`[ResProxy] Using residential exit IP: ${proxyExitIp}`);
            await logger.logInfo(orderId, `Residential Proxy Exit IP`, { exit_ip: proxyExitIp });
        } catch (e) {
            console.log(`[ResProxy] Failed to resolve exit IP`);
        }
    }

    // ========== STEP 1: DataDome Cookie Generation (via residential proxy) ==========
    console.log(`--- [1] Getting DataDome cookie (residential proxy)... ---`);
    const datadomeCookie = await getOrRegenerateDatadome(loginUrl, orderId, proxyKey);
    if (!datadomeCookie) {
        console.error("Stopping: Failed to generate DataDome cookie.");
        await logger.logError(orderId, 'Stopping: Failed to generate DataDome cookie', null, { step: 'getGarenaSession' });
        return null;
    }

    // ========== STEP 2: Garena Login (via same residential proxy) ==========
    console.log(`--- [2] Attempting login for Player ID: ${playerId}... ---`);

    // The session_key is NOT required for player_id_login.
    // Garena generates a brand new session_key and returns it in the LOGIN RESPONSE set-cookie.
    // Our code captures that response cookie and uses it for all subsequent API calls (CSRF, pay/init).
    // We only need a valid DataDome cookie for the login request itself.
    const fullCookie = `region=MY; language=en; source=pc; datadome=${datadomeCookie}`;

    // Generate matching randomized UA for the login request too
    const chromeVersions = [134, 135, 136, 137, 138];
    const chromeVersion = chromeVersions[Math.floor(Math.random() * chromeVersions.length)];
    const loginUserAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion}.0.0.0 Safari/537.36`;
    const loginSecChUa = `"Google Chrome";v="${chromeVersion}", "Chromium";v="${chromeVersion}", "Not A(Brand";v="24"`;

    const headers = {
        'Host': 'shop.garena.my',
        'Connection': 'keep-alive',
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'User-Agent': loginUserAgent,
        'Sec-Ch-Ua': loginSecChUa,
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Origin': 'https://shop.garena.my',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Dest': 'empty',
        'Referer': 'https://shop.garena.my/?channel=202953',
        'Accept-Language': 'en-GB,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cookie': fullCookie
    };

    const loginPayload = { app_id: 100067, login_id: playerId, app_server_id: 0 };

    console.log("\n--- Garena Login Request ---");
    console.log("URL:", loginUrl);
    console.log("Method: POST");
    console.log("Headers:", JSON.stringify(headers, null, 2));
    console.log("Body:", JSON.stringify(loginPayload, null, 2));

    try {
        const axiosConfig = {
            headers: headers,
            timeout: 60000,
            validateStatus: (s) => s < 600 // Allow 4xx and 5xx so we can log them
        };
        // Use the same residential proxy for login as for DataDome cookie
        if (sessionAgent) {
            axiosConfig.httpsAgent = sessionAgent;
        }
        await logRequest(orderId, 'Garena Login', { url: loginUrl, method: 'POST', headers, body: loginPayload });

        const response = await axios.post(loginUrl, loginPayload, axiosConfig);

        let responseData = response.data;
        if (typeof responseData === 'string') {
            try { responseData = JSON.parse(responseData); } catch (e) { /* keep as string */ }
        }

        console.log("\n--- Garena Login Response ---");
        console.log("Status:", response.status);
        console.log("Body:", JSON.stringify(responseData, null, 2));
        await logResponse(orderId, 'Garena Login', { status: response.status, headers: response.headers, body: responseData });

        // --- 502 Handling: Explicitly requested by user to log everything ---
        if (response.status === 502) {
            console.error(`Garena API returned 502 (Bad Gateway). Logging full response...`);
            await logger.logError(orderId, 'Garena API 502 Bad Gateway', null, {
                status: 502,
                headers: response.headers,
                response_body: responseData
            });
            return null;
        }

        // --- 403 Fallback: Invalidate DataDome cache and retry ONCE ---
        if (response.status === 403) {
            if (responseData && responseData.url && responseData.url.includes('captcha-delivery')) {
                console.warn('--- CAPTCHA DETECTED ---');
                // Invalidate cache so next attempt gets a fresh cookie
                invalidateCachedDatadome(proxyKey);
                if (!_isRetryAfterCacheInvalidation) {
                    console.log('--- Invalidated DataDome cache. Retrying with fresh cookie... ---');
                    await logger.logWarn(orderId, 'Captcha detected, invalidating DataDome cache and retrying');
                    return getGarenaSession(playerId, proxy, orderId, true);
                }
                await logger.logWarn(orderId, 'Garena login captcha detected even after cache invalidation');
                return { error: 'captcha_detected' };
            }
            console.error(`Login failed with status 403.`);
            invalidateCachedDatadome(proxyKey);
            await logger.logError(orderId, `Garena login failed with status 403`, null, { status: 403, body: responseData });
            return null;
        }

        if (response.status >= 400) {
            console.error(`Login failed with status ${response.status}.`);
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

        // Extract cookies from response headers (axios stores set-cookie differently)
        const setCookieHeaders = response.headers['set-cookie'];
        if (!setCookieHeaders || setCookieHeaders.length === 0) {
            console.error('Login successful, but no cookies were returned in the response.');
            await logger.logWarn(orderId, 'Login successful but no cookies returned');
            return null;
        }

        const fullCookieString = setCookieHeaders.map(c => c.split(';')[0]).join('; ');

        console.log(`--- [3] Session refreshed for player: ${responseData.nickname} ---`);
        await logger.logInfo(orderId, 'Garena session refreshed', { nickname: responseData.nickname });
        return {
            cookie: fullCookieString,
            nickname: responseData.nickname
        };
    } catch (error) {
        if (error.code === 'ECONNABORTED') {
            console.error('Garena session creation failed: Request timed out after 60 seconds');
            await logger.logError(orderId, 'Garena session creation failed: Request timed out', null);
        } else if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
            console.error('Garena session creation failed: Connection error', error.message);
            await logger.logError(orderId, 'Garena session creation failed: Connection error', error);
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
        const axiosConfig = {
            headers: headers,
            timeout: 30000,
            validateStatus: (s) => s < 500
        };
        if (proxy) {
            axiosConfig.httpsAgent = new HttpsProxyAgent(proxy);
        }
        await logRequest(orderId, 'CSRF Preflight', { url: preflightUrl, method: 'POST', headers });
        const response = await axios.post(preflightUrl, '', axiosConfig);

        console.log("\n--- CSRF Token Response ---");
        console.log("Status:", response.status);
        await logResponse(orderId, 'CSRF Preflight', { status: response.status, headers: response.headers, body: '[no body]' });

        const setCookieHeaders = response.headers['set-cookie'];
        if (!setCookieHeaders || setCookieHeaders.length === 0) {
            console.error('Preflight failed: No "set-cookie" header in response.');
            await logger.logError(orderId, 'Preflight failed: No set-cookie header in response', null);
            return null;
        }

        const csrfCookie = setCookieHeaders.find(c => c.includes('__csrf__='));
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
        if (error.code === 'ECONNABORTED') {
            console.error('CSRF preflight request failed: Request timed out');
            await logger.logError(orderId, 'CSRF preflight request timed out', null);
        } else if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
            console.error('CSRF preflight request failed: Connection error', error.message);
            await logger.logError(orderId, 'CSRF preflight connection error', error);
        } else {
            console.error('An error occurred during preflight request:', error.message);
            await logger.logError(orderId, 'Error during CSRF preflight request', error);
        }
        return null;
    }
};

const paymentLink = async (playerId, proxy, orderId) => {
    return withRetries(async () => {
        await logger.logInfo(orderId, 'paymentLink: start', { playerId, using_residential_proxy: true });
        // proxy arg from topup.js is ignored for Garena login — residential proxy is used internally
        const session = await getGarenaSession(playerId, null, orderId);

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

        const verificationResponse = await axios.get(verificationUrl, {
            headers: verificationHeaders,
            timeout: 30000
        });
        const verificationData = verificationResponse.data;
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

        // CSRF, pay/init go DIRECT (no proxy) to save residential proxy bandwidth
        const preflight = await getCsrfToken(session.cookie, null, orderId);
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

            const payInitConfig = {
                headers: paymentHeaders,
                timeout: 30000,
                validateStatus: (s) => s < 500
            };
            if (proxy) {
                payInitConfig.httpsAgent = new HttpsProxyAgent(proxy);
            }
            await logRequest(orderId, 'Pay Init', { url: paymentUrl, method: 'POST', headers: paymentHeaders, body: paymentPostFields });
            const response = await axios.post(paymentUrl, paymentPostFields, payInitConfig);
            const paymentData = response.data || {};
            await logResponse(orderId, 'Pay Init', { status: response.status, headers: response.headers, body: paymentData });

            if (response.status >= 400 || !paymentData.init || !paymentData.init.url) {
                await logger.logError(orderId, 'paymentLink: Failed to initiate payment', null, { status: response.status, body_keys: Object.keys(paymentData || {}) });
                // This will cause a retry
                return null;
            }

            console.log('\n--- Success! ---');
            await logger.logInfo(orderId, 'paymentLink: success', { payment_url: paymentData.init.url });
            return { url: paymentData.init.url, validated_uid: verificationData.player_id.open_id };

        } catch (error) {
            if (error.code === 'ECONNABORTED') {
                await logger.logError(orderId, 'Payment link generation timed out', null);
            } else if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
                await logger.logError(orderId, 'paymentLink: Connection error', error);
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

module.exports = { paymentLink, invalidateCachedDatadome };
