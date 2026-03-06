const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const bcrypt = require('bcrypt');
require('dotenv').config();

passport.use(new LocalStrategy(
    async (username, password, done) => {
        try {
            const adminUser = process.env.ADMIN_USER;
            const adminPassHash = process.env.ADMIN_PASS_HASH;

            if (!adminUser || !adminPassHash) {
                console.warn('Authentication failed: ADMIN_USER or ADMIN_PASS_HASH not set in environment.');
                return done(null, false, { message: 'Authentication is not configured correctly on the server.' });
            }

            if (username !== adminUser) {
                return done(null, false, { message: 'Incorrect username.' });
            }

            const isMatch = await bcrypt.compare(password, adminPassHash);

            if (!isMatch) {
                return done(null, false, { message: 'Incorrect password.' });
            }

            return done(null, { id: 1, username: adminUser, role: 'admin' });
        } catch (err) {
            return done(err);
        }
    }
));

passport.serializeUser((user, done) => {
    done(null, user.id);
});

passport.deserializeUser((id, done) => {
    if (id === 1) {
        done(null, { id: 1, username: process.env.ADMIN_USER, role: 'admin' });
    } else {
        done(new Error('User not found.'));
    }
});

module.exports = passport;