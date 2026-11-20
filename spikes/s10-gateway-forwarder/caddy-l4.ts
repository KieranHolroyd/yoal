/**
 * caddy-l4 side of S10: 200 layer4 servers on 127.0.0.1 and the gateway address, route 0 plain to
 * Postgres's loopback port, the rest to closed ports. A full config load through the admin socket
 * every 60 s with one route edited for another service (CLUSTERING §15.2 S1 method).
 *
 *   bun caddy-l4.ts <adminSocket> <basePort> <gateway> [routes] [--once]
 */
const [socket, baseArg, gateway, routesArg, once] = process.argv.slice(2) as string[];
const base = Number(baseArg);
const routes = Number(routesArg ?? 200);
let edit = 0;

function config() {
	const servers: Record<string, unknown> = {};
	for (let i = 0; i < routes; i++) {
		const port = base + i;
		const dial = i === 0 ? '127.0.0.1:15432' : `127.0.0.1:${30_000 + i + (i === 1 + (edit % (routes - 1)) ? edit : 0)}`;
		servers[`ep-${i}`] = {
			listen: [`127.0.0.1:${port}`, `${gateway}:${port}`],
			routes: [{ handle: [{ handler: 'proxy', upstreams: [{ dial: [dial] }] }] }],
		};
	}
	return { admin: { listen: `unix/${socket}` }, logging: { logs: { default: { level: 'WARN' } } }, apps: { layer4: { servers } } };
}

async function load(): Promise<void> {
	const started = performance.now();
	const response = await fetch('http://caddy/load', {
		unix: socket,
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(config()),
	} as RequestInit);
	const ms = Math.round(performance.now() - started);
	console.log(`${new Date().toISOString()} load edit=${edit} status=${response.status} ms=${ms} ${response.ok ? '' : await response.text()}`);
}

await load();
if (once !== '--once')
	setInterval(() => {
		edit += 1;
		load().catch((error) => console.log(`${new Date().toISOString()} load failed ${error}`));
	}, 60_000);
