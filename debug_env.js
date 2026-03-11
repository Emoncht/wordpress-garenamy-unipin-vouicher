require('dotenv').config();
const fs = require('fs');
fs.writeFileSync('pm2_env_debug.log', `CENTRAL_API_KEY: ${process.env.CENTRAL_API_KEY}\nCENTRAL_API_URL: ${process.env.CENTRAL_API_URL}\n`);
console.log("Debug log written.");
