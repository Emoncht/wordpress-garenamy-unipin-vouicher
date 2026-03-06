const axios = require('axios');
const https = require('https');

const agent = new https.Agent({
    keepAlive: true,
    rejectUnauthorized: false,
    secureProtocol: 'TLSv1_2_method'
});

const keepAlive = async () => {
    try {
        const response = await axios.get('https://shop.garena.my', {
            httpsAgent: agent
        });
        console.log('Ping successful:', response.status);
    } catch (error) {
        console.error('Ping failed:', error.message);
    }
};

// Run the keepAlive function every 30 seconds
const interval = 30000; // 30 seconds
setInterval(keepAlive, interval);

