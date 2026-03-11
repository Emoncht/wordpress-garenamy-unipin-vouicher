const fs = require('fs');
const path = require('path');

const logDir = 'G:\\Free Fire Top Up Project\\Logs';
let files = fs.readdirSync(logDir)
    .filter(f => f.endsWith('.json'))
    .map(f => ({ name: f, time: fs.statSync(path.join(logDir, f)).mtime.getTime() }))
    .sort((a, b) => b.time - a.time)
    .map(f => f.name)
    .slice(0, 500);

let results = {
    good: [],
    bad: []
};

for (const file of files) {
    try {
        const data = JSON.parse(fs.readFileSync(path.join(logDir, file), 'utf8'));
        if (!data.logs) continue;

        let ddHeaders = null;
        let currentCookie = null;

        for (const log of data.logs) {
            if (log.message === 'DataDome - response' && log.data) {
                ddHeaders = log.data.headers;
                if (log.data.body) {
                    try {
                        const body = typeof log.data.body === 'string' ? JSON.parse(log.data.body) : log.data.body;
                        if (body.cookie) {
                            const match = body.cookie.match(/datadome=([^;]+)/);
                            if (match) currentCookie = match[1];
                        }
                    } catch (e) { }
                }
            }

            if (log.message === 'Garena Login - response' && currentCookie) {
                if (log.data && log.data.status === 200) {
                    results.good.push({ cookie: currentCookie, headers: ddHeaders, file });
                } else if (log.data && (log.data.status === 403 || log.data.status === 401)) {
                    results.bad.push({ cookie: currentCookie, headers: ddHeaders, file });
                }
                currentCookie = null;
                ddHeaders = null;
            }
        }
    } catch (e) { }
}

fs.writeFileSync('cookie_analysis.json', JSON.stringify(results, null, 2));
console.log(`Wrote analysis. Good: ${results.good.length}, Bad: ${results.bad.length}`);
