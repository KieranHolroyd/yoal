/**
 * Design B's "control-plane issuer", run in the yoal-w0-s4-cp container. lego (pinned) does the
 * ACME work; this loop decides when, keeps the current pair, and serves it to agents the way
 * Yoal's node-authenticated activation endpoint would (sealing with the master key is not
 * modelled: the pair sits in this container's filesystem).
 *
 *   renew when less than S4_LIFETIME/3 remains (lego's and certmagic's default ratio), retry every
 *   S4_RETRY_S on failure; GET /cert → {generation, certPem, keyPem, fingerprint, notAfter};
 *   POST /reissue forces a new certificate (ingress removal); GET /status.
 */
import { createHash, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

const LIFETIME = Number(process.env.S4_LIFETIME ?? 240);
const RETRY_S = Number(process.env.S4_RETRY_S ?? 5);
const DOMAINS = (process.env.S4_DOMAINS ?? 'b.s4.test').split(',');
const CHALLENGE = process.env.S4_CHALLENGE ?? 'http';
const NODE_TOKEN = 's4-node-token';
const DATA = '/data';
const STATE = `${DATA}/state.json`;

interface Pair {
	generation: number;
	certPem: string;
	keyPem: string;
	fingerprint: string;
	notAfter: string;
	issuedAt: string;
}

const log = (event: string, extra: Record<string, unknown> = {}) =>
	console.log(JSON.stringify({ t: Date.now(), src: 'cp', event, ...extra }));

mkdirSync(DATA, { recursive: true });
let pair: Pair | null = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : null;
let issuing: Promise<boolean> | null = null;
let nextAttemptAt = 0;
let issued = 0;
let failed = 0;
log('start', { generation: pair?.generation ?? 0, lifetime: LIFETIME, domains: DOMAINS, challenge: CHALLENGE });

function legoArgs(): string[] {
	const args = [
		'lego', 'run', '--server', 'https://pebble:14000/dir', '--accept-tos', '--email', 's4@s4.test',
		'--path', `${DATA}/lego`, '--renew-force', '--no-random-sleep', '--ari-disable', '--log.format', 'text',
	];
	for (const d of DOMAINS) args.push('-d', d);
	if (CHALLENGE === 'dns')
		args.push('--dns', 'exec', '--dns.resolvers', '172.31.214.11:8053', '--dns.propagation.disable-ans');
	else args.push('--http', '--http.address', ':80');
	return args;
}

function findIssued(): { cert: string; key: string } {
	// lego v5 layout: <path>/certificates/<name>.crt|.key (a wildcard's name starts with "_").
	const dir = `${DATA}/lego/certificates`;
	const name = DOMAINS[0]!.replace('*', '_');
	const crt = readdirSync(dir).find((f) => f === `${name}.crt`);
	if (!crt) throw new Error(`no ${name}.crt in ${dir}: ${readdirSync(dir).join(',')}`);
	return { cert: readFileSync(`${dir}/${name}.crt`, 'utf8'), key: readFileSync(`${dir}/${name}.key`, 'utf8') };
}

async function issue(reason: string): Promise<boolean> {
	const started = Date.now();
	log('issue-start', { reason });
	const proc = Bun.spawn(legoArgs(), {
		env: { ...process.env, LEGO_CA_CERTIFICATES: '/etc/s4-shared/pebble-ca.pem', EXEC_PATH: '/rig/dns-exec.sh' },
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	if (code !== 0) {
		failed++;
		log('issue-failed', { reason, code, ms: Date.now() - started, tail: (err + out).trim().split('\n').slice(-4) });
		return false;
	}
	const { cert, key } = findIssued();
	const leaf = new X509Certificate(cert);
	pair = {
		generation: (pair?.generation ?? 0) + 1,
		certPem: cert,
		keyPem: key,
		fingerprint: createHash('sha256').update(leaf.raw).digest('hex'),
		notAfter: new Date(leaf.validTo).toISOString(),
		issuedAt: new Date().toISOString(),
	};
	writeFileSync(STATE, JSON.stringify(pair), { mode: 0o600 });
	issued++;
	log('issued', { reason, generation: pair.generation, fingerprint: pair.fingerprint, notAfter: pair.notAfter, san: leaf.subjectAltName, ms: Date.now() - started });
	return true;
}

function startIssue(reason: string): Promise<boolean> {
	issuing ??= issue(reason).finally(() => {
		issuing = null;
	});
	return issuing;
}

setInterval(() => {
	if (issuing || Date.now() < nextAttemptAt) return;
	const remaining = pair ? (Date.parse(pair.notAfter) - Date.now()) / 1000 : -1;
	if (pair && remaining > LIFETIME / 3) return;
	void startIssue(pair ? 'renewal-due' : 'initial').then((ok) => {
		if (!ok) nextAttemptAt = Date.now() + RETRY_S * 1000;
	});
}, 1000);

Bun.serve({
	port: 8080,
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === '/status')
			return Response.json({ generation: pair?.generation ?? 0, fingerprint: pair?.fingerprint, notAfter: pair?.notAfter, issuing: !!issuing, issued, failed });
		if (req.headers.get('authorization') !== `Bearer ${NODE_TOKEN}`) return new Response('unauthorised', { status: 401 });
		if (url.pathname === '/cert') return pair ? Response.json(pair) : new Response(null, { status: 204 });
		if (url.pathname === '/reissue' && req.method === 'POST') {
			const ok = await startIssue('reissue');
			return Response.json({ ok, generation: pair?.generation }, { status: ok ? 200 : 502 });
		}
		return new Response('not found', { status: 404 });
	},
});
