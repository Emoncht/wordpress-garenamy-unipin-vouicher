// This file acts as a fallback for Hostinger's standard Passenger configurations
// which natively expect "app.js" as the startup file instead of "server.js".
require('./server.js');
