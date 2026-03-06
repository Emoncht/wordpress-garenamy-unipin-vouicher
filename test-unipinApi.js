require('dotenv').config();
const { paymentLink } = require('./paymentLink');
const { processUnipinCheckout } = require('./unipinApi');

async function test() {
    const playerId = '1934379129';
    const sessionKey = process.env.GARENA_SESSION_KEY;
    const orderId = 'api-test-' + Date.now();

    console.log('--- Generating Payment Link ---');
    const result = await paymentLink(playerId, sessionKey, null, orderId);

    if (result.error || !result.url) {
        console.error('Failed to get payment link:', result.error);
        return;
    }
    console.log('Payment Link:', result.url);

    const voucherDetails = {
        denomination: '50 Diamond',
        serial: 'BDMBUS01510127',
        pinBlocks: ['1392', '1492', '6371', '3923']
    };

    console.log('\n--- Executing Raw API Checkout ---');
    console.time('API Checkout Duration');
    const apiResult = await processUnipinCheckout(result.url, voucherDetails, null);
    console.timeEnd('API Checkout Duration');

    console.log('Result:', apiResult);
}

test();
