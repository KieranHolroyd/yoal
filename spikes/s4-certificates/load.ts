/**
 * S4 client tools, run in yoal-w0-s4-client.
 *
 *   probe  one fresh TLS handshake per target (SNI = --host): leaf SHA-256, serial, notAfter.
 *   watch  probe every --interval ms for --seconds; one JSON line per change or error; a summary.
 *   hold   --conns TLS keep-alive connections to --target, each sending GET / every --period ms
 *          (staggered). A connection is dropped when the server closes it or a request on it fails
 *          (no answer within 5 s, reset, non-2xx); a dropped connection is reopened so the
 *          population stays at --conns. Writes every drop with its time; prints a summary.
 */
import tls from 'node:tls';
import { createHash } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values: a, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		targets: { type: 'string', default: '' },
		target: { type: 'string', default: '' },
		host: { type: 'string', default: 'a.s4.test' },
		interval: { type: 'string', default: '500' },
		seconds: { type: 'string', default: '60' },
		conns: { type: 'string', default: '1000' },
		period: { type: 'string', default: '2000' },
		out: { type: 'string', default: '/out/events.jsonl' },
	},
});
const mode = positionals[0];
const HOST = a.host!;

interface Probe {
	target: string;
	ok: boolean;
	fingerprint?: string;
	serial?: string;
	notAfter?: number;
	error?: string;
	ms: number;
}

function probe(target: string): Promise<Probe> {
	const [host, port] = target.split(':');
	const started = Date.now();
	return new Promise((resolve) => {
		const sock = tls.connect({ host, port: Number(port ?? 443), servername: HOST, rejectUnauthorized: false, session: undefined });
		const timer = setTimeout(() => {
			sock.destroy();
			resolve({ target, ok: false, error: 'timeout', ms: Date.now() - started });
		}, 3000);
		sock.once('secureConnect', () => {
			clearTimeout(timer);
			const c = sock.getPeerCertificate();
			const fp = c?.raw ? createHash('sha256').update(c.raw).digest('hex') : undefined;
			sock.destroy();
			resolve({ target, ok: !!fp, fingerprint: fp, serial: c?.serialNumber, notAfter: c?.valid_to ? Date.parse(c.valid_to) : undefined, ms: Date.now() - started });
		});
		sock.once('error', (e: Error & { code?: string }) => {
			clearTimeout(timer);
			resolve({ target, ok: false, error: e.code ?? e.message, ms: Date.now() - started });
		});
	});
}

const targets = () => a.targets!.split(',').filter(Boolean);

if (mode === 'probe') {
	console.log(JSON.stringify(await Promise.all(targets().map(probe))));
} else if (mode === 'watch') {
	writeFileSync(a.out!, '');
	const last = new Map<string, string>();
	const stats = new Map<string, { probes: number; errors: number; expiredServed: number; changes: number }>();
	const end = Date.now() + Number(a.seconds) * 1000;
	while (Date.now() < end) {
		const round = Date.now();
		for (const p of await Promise.all(targets().map(probe))) {
			const s = stats.get(p.target) ?? { probes: 0, errors: 0, expiredServed: 0, changes: 0 };
			s.probes++;
			const key = p.ok ? p.fingerprint! : `error:${p.error}`;
			if (!p.ok) s.errors++;
			if (p.ok && p.notAfter! < round) s.expiredServed++;
			if (last.get(p.target) !== key) {
				if (last.has(p.target)) s.changes++;
				last.set(p.target, key);
				appendFileSync(a.out!, `${JSON.stringify({ t: round, ...p })}\n`);
			}
			stats.set(p.target, s);
		}
		await Bun.sleep(Math.max(0, Number(a.interval) - (Date.now() - round)));
	}
	console.log(JSON.stringify({ mode, stats: Object.fromEntries(stats), final: Object.fromEntries(last) }));
} else if (mode === 'hold') {
	writeFileSync(a.out!, '');
	const [host, port] = a.target!.split(':');
	const N = Number(a.conns);
	const PERIOD = Number(a.period);
	const end = Date.now() + Number(a.seconds) * 1000;
	let opened = 0;
	let openFailed = 0;
	let ok = 0;
	let failedRequests = 0;
	let serverClosedIdle = 0;
	let serverClosedInflight = 0;
	const byNode = new Map<string, number>();
	const drop = (kind: string, extra: Record<string, unknown> = {}) =>
		appendFileSync(a.out!, `${JSON.stringify({ t: Date.now(), kind, ...extra })}\n`);

	const live = async (slot: number): Promise<void> => {
		let first = true;
		while (Date.now() < end) {
			const sock = await new Promise<tls.TLSSocket | null>((resolve) => {
				const s = tls.connect({ host, port: Number(port), servername: HOST, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] });
				const t = setTimeout(() => (s.destroy(), resolve(null)), 5000);
				s.once('secureConnect', () => (clearTimeout(t), resolve(s)));
				s.once('error', () => (clearTimeout(t), resolve(null)));
			});
			if (!sock) {
				openFailed++;
				drop('open-failed', { slot });
				await Bun.sleep(500);
				continue;
			}
			opened++;
			sock.setNoDelay(true);
			let buf = Buffer.alloc(0);
			let waiter: ((r: { status: number; node: string } | null) => void) | null = null;
			let closedByUs = false;
			let closed = false;
			const onClose = () => {
				if (closed) return;
				closed = true;
				if (waiter) {
					const w = waiter;
					waiter = null;
					w(null);
				} else if (!closedByUs) {
					serverClosedIdle++;
					drop('server-closed-idle', { slot });
				}
			};
			sock.on('data', (chunk: Buffer) => {
				buf = Buffer.concat([buf, chunk]);
				const end = buf.indexOf('\r\n\r\n');
				if (end < 0) return;
				const head = buf.subarray(0, end).toString('latin1');
				const len = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? 0);
				if (buf.length < end + 4 + len) return;
				buf = buf.subarray(end + 4 + len);
				const status = Number(head.split(' ')[1]);
				const node = /x-node:\s*(\S+)/i.exec(head)?.[1] ?? '?';
				const w = waiter;
				waiter = null;
				w?.({ status, node });
			});
			sock.on('end', onClose);
			sock.on('close', onClose);
			sock.on('error', () => {});
			if (first) {
				await Bun.sleep(Math.random() * PERIOD);
				first = false;
			}
			while (!closed && Date.now() < end) {
				const r = await new Promise<{ status: number; node: string } | null>((resolve) => {
					const t = setTimeout(() => {
						waiter = null;
						resolve(null);
					}, 5000);
					waiter = (x) => (clearTimeout(t), resolve(x));
					sock.write(`GET / HTTP/1.1\r\nHost: ${HOST}\r\nUser-Agent: s4-hold\r\n\r\n`);
				});
				if (!r || r.status < 200 || r.status > 299) {
					failedRequests++;
					if (!r && closed) serverClosedInflight++;
					drop('request-failed', { slot, status: r?.status ?? null, closed });
					closedByUs = true;
					sock.destroy();
					break;
				}
				ok++;
				byNode.set(r.node, (byNode.get(r.node) ?? 0) + 1);
				await Bun.sleep(PERIOD);
			}
			if (!closed) {
				closedByUs = true;
				sock.destroy();
			}
		}
	};

	// Open in batches of 100 so the handshakes do not all land in one second.
	const slots: Promise<void>[] = [];
	for (let i = 0; i < N; i++) {
		slots.push(live(i));
		if (i % 100 === 99) await Bun.sleep(200);
	}
	const t0 = Date.now();
	await Promise.all(slots);
	console.log(
		JSON.stringify({
			mode,
			conns: N,
			seconds: Number(a.seconds),
			opened,
			openFailed,
			okRequests: ok,
			failedRequests,
			serverClosedIdle,
			serverClosedInflight,
			dropped: serverClosedIdle + failedRequests,
			byNode: Object.fromEntries(byNode),
			wallMs: Date.now() - t0,
		}),
	);
} else {
	console.error('usage: load.ts probe|watch|hold …');
	process.exit(2);
}
