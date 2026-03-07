const axios = require('axios');
const { Agent } = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');

function createAxiosInstance(proxy) {
    const config = {
        timeout: 15000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9'
        },
        maxRedirects: 5,
        validateStatus: (status) => status < 500 // Don't throw on 400s
    };

    if (proxy && proxy !== 'none') {
        let proxyUrl = proxy;
        if (!proxyUrl.startsWith('http')) {
            proxyUrl = `http://${proxyUrl}`;
        }
        config.httpsAgent = new HttpsProxyAgent(proxyUrl);
    } else {
        config.httpsAgent = new Agent({ rejectUnauthorized: false });
    }

    return axios.create(config);
}

function extractCookies(response, existingCookies = {}) {
    const setCookieHeaders = response.headers['set-cookie'];
    if (!setCookieHeaders) return existingCookies;

    setCookieHeaders.forEach(cookieStr => {
        const parts = cookieStr.split(';');
        const [nameValue] = parts;
        const [name, ...valueParts] = nameValue.split('=');
        if (name && valueParts.length > 0) {
            existingCookies[name.trim()] = valueParts.join('=').trim();
        }
    });
    return existingCookies;
}

function formatCookies(cookiesObj) {
    return Object.entries(cookiesObj)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
}

async function processUnipinCheckout(paymentUrl, voucherDetails, proxy = null) {
    const client = createAxiosInstance(proxy);
    let cookies = {};

    try {
        // Step 1: Visit the generated payment link to get Session & CSRF Token
        // This will redirect to /unibox/select_denom/{hash}
        const initResponse = await client.get(paymentUrl);
        cookies = extractCookies(initResponse, cookies);

        let html = initResponse.data;
        const currentUrl = initResponse.request.res.responseUrl || paymentUrl;

        // Extract Hash
        const hashMatch = currentUrl.match(/\/unibox\/(?:select_denom|c|d)\/([^\/?]+)/);
        if (!hashMatch) {
            throw new Error(`Failed to extract payment hash from URL: ${currentUrl}`);
        }
        const hash = hashMatch[1];

        // Extract CSRF Token
        let csrfToken = '';
        const tokenMatch1 = html.match(/<meta\s+name=["']csrf-token["']\s+content=["']([^"']+)["']/i);
        const tokenMatch2 = html.match(/<input\s+type=["']hidden["']\s+name=["']_token["']\s+value=["']([^"']+)["']/i);
        if (tokenMatch1) csrfToken = tokenMatch1[1];
        else if (tokenMatch2) csrfToken = tokenMatch2[1];
        else throw new Error('Failed to extract CSRF token from page.');

        // Step 2: Extract the correct denomination JSON payload
        // The HTML contains divs with onclick attributes holding JSON values for each denomination
        const denomRegex = /onclick=["']submit_form\(['"]({[^'"]+})['"]\)/ig;
        let match;
        let selectedDenomJson = null;

        const targetDenomText = String(voucherDetails.denomination).toLowerCase();

        // For matching, the button text usually looks like "50 Diamond" which is inside a sibling span or label,
        // but the JSON string itself contains the name, e.g., {"name":"50 Diamond","amount":"36.0","amount_uc":"36.0","amount_up":36}
        while ((match = denomRegex.exec(html)) !== null) {
            try {
                // The value is HTML encoded (e.g. &quot;)
                let decodedValue = match[1].replace(/&quot;/g, '"');
                const parsed = JSON.parse(decodedValue);
                if (parsed.name && parsed.name.toLowerCase().includes(targetDenomText) || targetDenomText.includes(parsed.name.toLowerCase())) {
                    selectedDenomJson = decodedValue;
                    break;
                }
            } catch (e) {
                // Ignore parse errors for individual matches
            }
        }

        // Fallback for tricky denominations like BDMB
        if (!selectedDenomJson) {
            throw new Error(`Could not find a matching denomination radio button for: ${targetDenomText}`);
        }

        // Step 3: POST to select denomination
        const denomPostUrl = `https://www.unipin.com/unibox/select_denom/${hash}?lg=en`;
        const denomPayload = new URLSearchParams();
        denomPayload.append('_token', csrfToken);
        denomPayload.append('denomination', selectedDenomJson);

        const denomResponse = await client.post(denomPostUrl, denomPayload, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Cookie': formatCookies(cookies),
                'Origin': 'https://www.unipin.com',
                'Referer': currentUrl,
                'Upgrade-Insecure-Requests': '1'
            }
        });

        cookies = extractCookies(denomResponse, cookies);

        // Step 4: POST to submit Voucher
        let paymentMethodId = '659'; // Default to BDMB 'UniPin Voucher'
        const serialUpper = voucherDetails.serial.toUpperCase();

        if (serialUpper.includes('UPBD') || serialUpper.startsWith('UP')) {
            paymentMethodId = '670'; // 'UP Gift Card'
        } else if (serialUpper.includes('BDMB')) {
            paymentMethodId = '659';
        }

        const submitUrl = `https://www.unipin.com/unibox/c/${hash}/${paymentMethodId}`;
        const submitPayload = new URLSearchParams();
        submitPayload.append('_token', csrfToken);
        submitPayload.append('serial', voucherDetails.serial.replace(/-/g, ''));
        submitPayload.append('pin_1', voucherDetails.pinBlocks[0]);
        submitPayload.append('pin_2', voucherDetails.pinBlocks[1]);
        submitPayload.append('pin_3', voucherDetails.pinBlocks[2]);
        submitPayload.append('pin_4', voucherDetails.pinBlocks[3]);

        const submitResponse = await client.post(submitUrl, submitPayload, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Cookie': formatCookies(cookies),
                'Origin': 'https://www.unipin.com',
                'Referer': `https://www.unipin.com/unibox/c/${hash}/${paymentMethodId}?b=1`,
                'Upgrade-Insecure-Requests': '1'
            }
        });

        cookies = extractCookies(submitResponse, cookies);

        // Step 5: Check result
        // UniPin usually replies with a 302 redirect on success or a 200/302 on error
        const finalUrl = submitResponse.request.res.responseUrl || submitUrl;
        const finalHtml = submitResponse.data;

        if (finalUrl.includes('/unibox/result/') || finalHtml.includes('Thank you') || finalHtml.includes('Transaction Successful')) {
            return { status: 'completed', reason: null };
        } else if (finalUrl.includes('error/Consumed') || finalHtml.includes('Consumed Voucher') || finalHtml.includes('already been used')) {
            return { status: 'consumed', reason: 'Voucher has already been consumed.' };
        } else if (finalUrl.includes('error') || finalHtml.includes('Invalid serial')) {
            // Extract specific error message if possible
            const errMatch = finalHtml.match(/<div class=["']alert alert-danger["'][^>]*>([\s\S]*?)<\/div>/i);
            const errMsg = errMatch ? errMatch[1].replace(/<[^>]+>/g, '').trim() : 'Unknown error during submission';
            return { status: 'failed', reason: errMsg };
        } else {
            return { status: 'failed', reason: 'Unexpected response after submission. Url: ' + finalUrl };
        }

    } catch (error) {
        if (error.response && error.response.status === 429) {
            return { status: 'failed', reason: 'RATE_LIMIT_DETECTED' };
        }
        return { status: 'failed', reason: 'HTTP API Exception: ' + error.message };
    }
}

module.exports = { processUnipinCheckout };
