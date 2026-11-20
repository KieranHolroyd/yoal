/**
 * Design B's ingress agent (stand-in for Yoal's agent), run as root in each ingress container.
 * Pulls the pair from the issuer every S4_POLL_MS (Yoal: on start, on a generation change in
 * desired state, and every 6 h), writes it 0640 root:caddy by atomic replace, and either loads it
 * into Caddy with one POST /load (S4_DELIVERY=load) or serves it to Caddy's get_certificate http
 * manager on loopback (S4_DELIVERY=manager). If the issuer is unreachable it keeps the file it has.
 */
import { closeSync, chownSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync, readdirSync } from 'node:fs';
import { AGENT_PORT, AGENT_TOKEN, caddyConfig } from './caddy.ts';

const NODE = process.env.S4_NODE!;
const HOST = process.env.S4_HOST ?? 'b.s4.test';
const CP = process.env.S4_CP ?? 'http://cp:8080';
const RELAY = process.env.S4_RELAY || null;
const DELIVERY = (process.env.S4_DELIVERY ?? 'load') as 'load' | 'manager';
const POLL_MS = Number(process.env.S4_POLL_MS ?? 2000);
const DIR = '/etc/caddy-certs';
const caddyGid = Number(readFileSync('/etc/group', 'utf8').split('\n').find((l) => l.startsWith('caddy:'))!.split(':')[2]);

const log = (event: string, extra: Record<string, unknown> = {}) =>
	console.log(JSON.stringify({ t: Date.now(), src: 'agent', node: NODE, event, ...extra }));

function writeAtomic(path: string, body: string) {
	const tmp = `${path}.tmp-${process.pid}`;
	const fd = openSync(tmp, 'w', 0o640);
	writeSync(fd, body);
	fsyncSync(fd);
	closeSync(fd);
	chownSync(tmp, 0, caddyGid);
	renameSync(tmp, path);
}

let generation = 0;
let unreachableSince = 0;

async function tick() {
	let res: Response;
	try {
		res = await fetch(`${CP}/cert`, { headers: { authorization: 'Bearer s4-node-token' }, signal: AbortSignal.timeout(1500) });
	} catch (error) {
		if (!unreachableSince) {
			unreachableSince = Date.now();
			log('issuer-unreachable', { error: String(error), keeping: generation });
		}
		return;
	}
	if (unreachableSince) {
		log('issuer-back', { afterMs: Date.now() - unreachableSince });
		unreachableSince = 0;
	}
	if (res.status !== 200) return;
	const pair = (await res.json()) as { generation: number; certPem: string; keyPem: string; fingerprint: string };
	if (pair.generation <= generation) return;
	const started = Date.now();
	const certificate = `${DIR}/gen-${pair.generation}.crt`;
	const key = `${DIR}/gen-${pair.generation}.key`;
	writeAtomic(key, pair.keyPem);
	writeAtomic(certificate, pair.certPem);
	const previous = generation;
	if (DELIVERY === 'manager') {
		// Caddy reads the pair from us on its next handshake; nothing in Caddy reloads.
		current = { certificate, key };
		generation = pair.generation;
		log('loaded', { generation, fingerprint: pair.fingerprint, ms: Date.now() - started, via: 'manager' });
		prune(previous);
		return;
	}
	const config = caddyConfig({ node: NODE, host: HOST, design: 'B', relay: RELAY, certFiles: { certificate, key } });
	const load = await fetch('http://localhost:2019/load', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(config),
	});
	if (!load.ok) {
		log('load-failed', { generation: pair.generation, status: load.status, body: await load.text() });
		return;
	}
	generation = pair.generation;
	log('loaded', { generation, fingerprint: pair.fingerprint, ms: Date.now() - started });
	prune(previous);
}

/** Keep the previous pair for a rollback; remove anything older. */
function prune(previous: number) {
	for (const f of readdirSync(DIR))
		if (!f.startsWith(`gen-${generation}.`) && !f.startsWith(`gen-${previous}.`)) rmSync(`${DIR}/${f}`, { force: true });
}

let current: { certificate: string; key: string } | null = null;
if (DELIVERY === 'manager')
	Bun.serve({
		hostname: '127.0.0.1',
		port: AGENT_PORT,
		fetch(req) {
			if (new URL(req.url).searchParams.get('token') !== AGENT_TOKEN) return new Response(null, { status: 403 });
			// Not 204: on "no certificate" certmagic falls through to its own issuers and then waits
			// on that retry loop. An error fails the handshake instead (not ready, I14).
			if (!current) return new Response('no certificate delivered yet', { status: 503 });
			// Caddy's http manager wants the chain and the key, PEM, in one body.
			return new Response(readFileSync(current.certificate, 'utf8') + readFileSync(current.key, 'utf8'));
		},
	});

log('start', { cp: CP, relay: RELAY, pollMs: POLL_MS, delivery: DELIVERY });
for (;;) {
	await tick().catch((error) => log('tick-error', { error: String(error) }));
	await Bun.sleep(POLL_MS);
}
