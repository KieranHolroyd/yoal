/** The lab's upstream app: fixed-size bodies (always Content-Length), a health path and a slow path. */
const name = process.env.APP_NAME ?? 'app';
Bun.serve({
	port: 3000,
	idleTimeout: 120,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === '/healthz') return new Response('ok\n');
		if (url.pathname === '/slow') {
			const ms = Math.min(Number(url.searchParams.get('ms') ?? 2000), 30_000);
			await Bun.sleep(ms);
		}
		return new Response(`hello from ${name}\n`, { headers: { 'X-S9-App': name } });
	},
});
console.log(`${name} listening on :3000`);
