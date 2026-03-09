require('dotenv').config();
const express = require("express");
const session = require('express-session');
const passport = require('./auth');
const state = require('./state');
const { startWorkerLoops } = require('./worker');
const { getBrowserPool } = require('./topup');
const { startHeartbeatLoop, setupShutdownHandlers } = require('./heartbeat');

const app = express();
const PORT = Number(process.env.PORT) || 0;
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: false, limit: '50mb' }));

app.use(session({
    secret: process.env.SESSION_SECRET || 'a-very-secret-key-that-should-be-in-env-vars',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } // Set to true if HTTPS
}));

app.use(passport.initialize());
app.use(passport.session());

function isAuthenticated(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.redirect('/login');
}

app.get('/login', (req, res) => res.sendFile(__dirname + '/login.html'));
app.post('/login', passport.authenticate('local', {
    successRedirect: '/monitor',
    failureRedirect: '/login',
}));
app.get('/logout', (req, res) => {
    req.logout(function (err) {
        if (err) { return next(err); }
        res.redirect('/login');
    });
});

app.get('/monitor', isAuthenticated, (req, res) => res.sendFile(__dirname + '/queue-monitor.html'));

app.get('/status', (req, res) => {
    res.status(200).json({
        status: true,
        server_id: require('./heartbeat').SERVER_ID,
        rate_limit_active: state.getGlobalRateLimitActive(),
        currently_processing: state.getActiveClaimedIds().length,
        uptime_seconds: Math.floor(process.uptime())
    });
});

app.get('/queue-status', isAuthenticated, (req, res) => {
    try {
        let pool = typeof getBrowserPool === 'function' ? getBrowserPool() : [];
        const activeBrowsers = pool.filter(b => b.inUse).map(b => {
            const duration = b.startTime ? Math.floor((new Date() - b.startTime) / 1000) : 0;
            return {
                order_id: b.orderId || 'Unknown',
                browser_id: b.browserId,
                start_time: b.startTime,
                duration: duration
            };
        });

        res.json({
            status: true,
            currently_processing: state.getActiveClaimedIds(),
            queue_length: 0, // Check WP Dashboard for global queue!
            active_browsers: activeBrowsers,
            queue_details: []
        });

    } catch (error) {
        console.error('Error fetching queue status:', error);
        res.status(500).json({ status: false, message: 'Internal Server Error' });
    }
});

// Setup Graceful Shutdown
setupShutdownHandlers();

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on 0.0.0.0:${server.address().port}`);
});

// Start background processes independently from the Express server binding
// This prevents Phusion Passenger / Hostinger from timing out the boot process
startHeartbeatLoop().catch(console.error);
startWorkerLoops().catch(console.error);
