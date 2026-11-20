/**
 * Runs one Bun forwarder the way the agent does: converge() on every poll (8 s, unchanged state)
 * and a route edit for another service every 60 s. 200 consumer routes; route 0 is the full
 * production path (consumer -> pinned mTLS -> provider on the overlay address -> Postgres),
 * route 1 is plain to Postgres's loopback port, the rest point at closed ports.
 *
 *   bun harness.ts <module.ts> <basePort> <providerPort> <gateway> <overlay> <certDir> [routes]
 */
import { readFileSync } from 'node:fs';

const [modulePath, baseArg, providerArg, gateway, overlay, certDir, routesArg] = process.argv.slice(2) as string[];
const base = Number(baseArg);
const providerPort = Number(providerArg);
const routes = Number(routesArg ?? 200);
const { ServiceForwarder } = await import(modulePath!);
const certPem = readFileSync(`${certDir}/node.crt`, 'utf8');
const keyPem = readFileSync(`${certDir}/node.key`, 'utf8');
const fingerprint = readFileSync(`${certDir}/node.fp`, 'utf8').trim();
const PG = 15432;

const log = (level: string, message: string) => console.log(`${new Date().toISOString()} ${level} ${message}`);
const forwarder = new ServiceForwarder({ log, certificate: { certPem, keyPem }, gatewayBinds: gateway === '-' ? [] : [gateway] });

let edit = 0;
function endpoints() {
	return Array.from({ length: routes }, (_, i) => {
		const upstream =
			i === 0
				? { nodeId: 'provider', address: overlay, port: providerPort }
				: i === 1
					? { nodeId: 'provider', address: '127.0.0.1', port: PG }
					: { nodeId: 'provider', address: '127.0.0.1', port: 30_000 + i + (i === 2 + (edit % (routes - 2)) ? edit : 0) };
		return { id: `sep_${i}`, kind: 'database', serviceId: `db_${i}`, localPort: base + i, upstream, tlsFingerprint: i === 0 ? fingerprint : null };
	});
}
const providers = [{ id: 'p0', listenAddress: overlay, listenPort: providerPort, targetPort: PG, allowedClientFingerprints: [fingerprint] }];

let polls = 0;
let restarts = 0;
const first = forwarder.converge(endpoints(), providers);
log('info', `converge#0 ${JSON.stringify(first)}`);
setInterval(() => {
	polls += 1;
	if (polls % 7 === 0) edit += 1; // about every 60 s (7 x 8.0 s = 56 s)
	const result = forwarder.converge(endpoints(), providers);
	restarts += result.stopped;
	if (polls % 7 === 0) log('info', `poll ${polls} edit ${edit} ${JSON.stringify(result)} listenerRestartsTotal=${restarts}`);
}, 8_000);
process.on('SIGTERM', () => {
	forwarder.close();
	process.exit(0);
});
