const { paymentLink } = require('./paymentLink');
const axios = require('axios');
const fs = require('fs');

async function run() {
    console.log("Generating Garena link...");
    const pl = await paymentLink('1957318275', false, 'test-upbd');
    console.log("Raw pl:", pl, "Type:", typeof pl);
    if (!pl) return console.log("Failed to gen link");

    const url = typeof pl === 'string' ? pl : pl.url;
    if (!url) return console.log("No URL found inside pl");

    console.log("Link:", url);
    const client = axios.create({ timeout: 15000 });
    const initResponse = await client.get(url);
    const html = initResponse.data;

    const hashMatch = url.match(/\/unibox\/(?:select_denom|c|d)\/([^\/?]+)/);
    const hash = hashMatch[1];

    let csrfToken = '';
    const tokenMatch1 = html.match(/<meta\s+name=["']csrf-token["']\s+content=["']([^"']+)["']/i);
    const tokenMatch2 = html.match(/<input\s+type=["']hidden["']\s+name=["']_token["']\s+value=["']([^"']+)["']/i);
    if (tokenMatch1) csrfToken = tokenMatch1[1];
    else if (tokenMatch2) csrfToken = tokenMatch2[1];

    console.log("Hash:", hash, "CSRF:", csrfToken);

    let selectedDenomJson = null;
    const denomRegex = /onclick=["']submit_form\(['"]({[^'"]+})['"]\)/ig;
    let match;
    while ((match = denomRegex.exec(html)) !== null) {
        let dec = match[1].replace(/&quot;/g, '"');
        let parsed = JSON.parse(dec);
        if (parsed.name.includes("1240")) {
            selectedDenomJson = dec;
            break;
        }
    }

    console.log("Denom JSON:", selectedDenomJson);

    const denomPostUrl = `https://www.unipin.com/unibox/select_denom/${hash}?lg=en`;
    const denomPayload = new URLSearchParams();
    denomPayload.append('_token', csrfToken);
    denomPayload.append('denomination', selectedDenomJson);

    let setCookie = initResponse.headers['set-cookie'];
    let cookieStr = setCookie ? setCookie.map(c => c.split(';')[0]).join('; ') : '';

    const denomResponse = await client.post(denomPostUrl, denomPayload, {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cookie': cookieStr,
            'Origin': 'https://www.unipin.com',
            'Referer': url
        }
    });

    fs.writeFileSync('payment_methods.html', denomResponse.data);
    console.log("Wrote HTML to payment_methods.html");
}
run();
