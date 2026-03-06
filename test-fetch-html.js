require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const { paymentLink } = require('./paymentLink');

async function debugHtml() {
    const result = await paymentLink('1934379129', process.env.GARENA_SESSION_KEY, null, 'debug-html');
    if (!result.url) return console.log('link failed');

    console.log('Fetching:', result.url);
    const res = await axios.get(result.url);
    fs.writeFileSync('unipin-page.html', res.data);
    console.log('Saved unipin-page.html');
}

debugHtml();
