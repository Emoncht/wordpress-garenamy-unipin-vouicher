require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const { paymentLink } = require('./paymentLink');
const fs = require('fs');

async function testNetwork() {
    const playerId = '1934379129';
    const sessionKey = process.env.GARENA_SESSION_KEY;
    const proxy = null;
    const orderId = 'test-network-123';

    console.log('Generating payment link...');
    const result = await paymentLink(playerId, sessionKey, proxy, orderId);
    console.log('Payment Link Result:', result.url);

    if (result.error || !result.url) {
        console.error('Failed to get payment link:', result.error);
        return;
    }

    console.log('Launching Puppeteer...');
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();

    const capturedRequests = [];

    await page.setRequestInterception(true);
    page.on('request', (request) => {
        const url = request.url();
        // Capture only POSTs that look like the actual voucher submission
        if (request.method() === 'POST' && url.includes('unipin.com') && !url.includes('google-analytics') && !url.includes('analytics')) {
            capturedRequests.push({
                url: url,
                headers: request.headers(),
                postData: request.postData()
            });
        }
        request.continue();
    });

    try {
        console.log(`Navigating to ${result.url}...`);
        await page.goto(result.url, { waitUntil: 'networkidle2', timeout: 60000 });

        console.log('Selecting denomination "50 Diamond"...');
        const clickedDenom = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('.payment-denom-button'));
            const button = buttons.find(b => b.innerText.trim() === '50 Diamond');
            if (button) { button.click(); return true; }
            return false;
        });

        if (!clickedDenom) throw new Error('Denomination not found');
        await page.waitForNavigation({ waitUntil: 'networkidle2' });

        console.log('Selecting payment provider BDMB...');
        await page.waitForSelector('.icon-Expand-More');
        await page.click('.icon-Expand-More');
        await new Promise(r => setTimeout(r, 1000));

        const bdmbButton = await page.waitForSelector('::-p-xpath(//*[@id="pc_div_659"])');
        if (bdmbButton) await bdmbButton.click();

        await new Promise(r => setTimeout(r, 2000));

        console.log('Filling in voucher details...');
        await page.waitForSelector('#serial');

        // BDMB-U-S-01510127-1392-1492-6371-3923
        await page.type('#serial', 'BDMB-U-S-01510127');
        await page.type('#pin_1', '1392');
        await page.type('input[name=pin_2]', '1492');
        await page.type('input[name=pin_3]', '6371');
        await page.type('input[name=pin_4]', '3923');

        console.log('Submitting...');
        await page.click('[type=submit]');

        await new Promise(r => setTimeout(r, 6000));

        // Save to JSON
        fs.writeFileSync('unipin-requests.json', JSON.stringify(capturedRequests, null, 2));
        console.log('Saved captured requests to unipin-requests.json');

    } catch (e) {
        console.error('Error during automation:', e);
    } finally {
        await browser.close();
    }
}

testNetwork();
