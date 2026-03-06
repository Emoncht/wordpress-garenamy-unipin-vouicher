module.exports = {
	apps: [
		{
			name: 'garenamy-server',
			script: 'server.js',
			interpreter: 'node',
			windowsHide: true,
			autorestart: true,
			watch: false,
			max_memory_restart: '800M',
			exp_backoff_restart_delay: 500,
			env: {
				NODE_ENV: 'production',
				PORT: 4000,
				BROWSER_CONCURRENCY: '1',
				NODE_OPTIONS: '--max-old-space-size=512'
			}
		},
		{
			name: 'garenamy-keepalive',
			script: 'keepAlive.js',
			interpreter: 'node',
			windowsHide: true,
			autorestart: true,
			watch: false,
			max_memory_restart: '200M',
			exp_backoff_restart_delay: 500,
			env: {
				NODE_ENV: 'production'
			}
		}
	]
};