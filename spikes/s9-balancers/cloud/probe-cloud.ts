/**
 * Criterion 3 probes from this Mac: the client address through the Hetzner LB (tcp + PROXY v2, and
 * http/L7 + X-Forwarded-For), and forgeries sent straight to a node's public address, which is
 * outside `trusted_proxies`. Prints one JSON array of { name, pass, detail }.
 */
import net from 'node:net';
import tls from 'node:tls';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({ options: { lb: { type: 'string' }, node: { type: 'string' }, mac: { type: 'string' }, lbprivate: { type: 'string' } } });
const LB = args.lb!;
const NODE = args.node!;
const MAC = args.mac!;
const LBP = args.lbprivate!;
const FAKE = '203.0.113.7';
const D = 's9.test';
const HEALTH = 8099;

function v2Header(src: string, dst: string, srcPort: number, dstPort: number): Buffer {
	const sig = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]);
	const body = Buffer.alloc(12);
	src.split('.').forEach((o, i) => body.writeUInt8(Number(o), i));
	dst.split('.').forEach((o, i) => body.writeUInt8(Number(o), 4 + i));
	body.writeUInt16BE(srcPort, 8);
	body.writeUInt16BE(dstPort, 10);
	return Buffer.concat([sig, Buffer.from([0x21, 0x11, 0x00, 0x0c]), body]);
}
const v1Header = (src: string, dst: string, dstPort: number) => Buffer.from(`PROXY TCP4 ${src} ${dst} 40000 ${dstPort}\r\n`);

function complete(out: string): boolean {
	const end = out.indexOf('\r\n\r\n');
	if (end < 0) return false;
	const m = /content-length:\s*(\d+)/i.exec(out.slice(0, end));
	return m ? out.length >= end + 4 + Number(m[1]) : true;
}

/** Writes `prefix` in clear, then the request (over TLS when `sni` is set); resolves with the raw answer. */
function raw(host: string, port: number, request: string, opts: { sni?: string; prefix?: Buffer; holdMs?: number } = {}): Promise<string> {
	return new Promise((resolve) => {
		let out = '';
		let settled = false;
		const done = (v: string) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve(v);
			}
		};
		const timer = setTimeout(() => done(out || 'timeout'), (opts.holdMs ?? 0) + 6000);
		const sock = net.connect({ host, port }, () => {
			if (opts.prefix) sock.write(opts.prefix);
			if (opts.holdMs) return;
			if (opts.sni) {
				const s = tls.connect({ socket: sock, servername: opts.sni, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] }, () => s.write(request));
				s.on('data', (c) => {
					out += c.toString('latin1');
					if (complete(out)) {
						done(out);
						s.destroy();
					}
				});
				s.on('error', (e: Error & { code?: string }) => done(out || `tls-error:${e.code ?? e.message}`));
				s.on('close', () => done(out || 'closed'));
			} else sock.write(request);
		});
		sock.on('data', (c) => {
			if (opts.sni && !opts.holdMs) return;
			out += c.toString('latin1');
			if (complete(out)) {
				done(out);
				sock.destroy();
			}
		});
		sock.on('error', (e: Error & { code?: string }) => done(out || `error:${e.code ?? e.message}`));
		sock.on('close', () => done(out || 'closed'));
	});
}
const req = (host: string, path = '/', extra = '') => `GET ${path} HTTP/1.1\r\nHost: ${host}\r\n${extra}Connection: close\r\n\r\n`;
const status = (r: string) => Number(/^HTTP\/1\.1 (\d{3})/.exec(r)?.[1] ?? 0);
const who = (r: string): Record<string, string> | null => {
	try {
		return JSON.parse(r.slice(r.indexOf('\r\n\r\n') + 4));
	} catch {
		return null;
	}
};
const cases: { name: string; pass: boolean; detail: unknown }[] = [];
const check = (name: string, pass: boolean, detail: unknown) => cases.push({ name, pass, detail });
const W = `whoami.${D}`;

// Through the LB, tcp + PROXY v2.
const viaTcp = who(await raw(LB, 443, req(W), { sni: W }));
check('LB tcp+PROXY: remote.host and client_ip are the true client', viaTcp?.remote === MAC && viaTcp?.client === MAC, viaTcp);
const viaTcpXff = who(await raw(LB, 443, req(W, '/', `X-Forwarded-For: ${FAKE}\r\n`), { sni: W }));
check('LB tcp+PROXY: client-sent X-Forwarded-For not believed', viaTcpXff?.client === MAC && viaTcpXff?.remote === MAC, viaTcpXff);
const smuggled = await raw(LB, 443, req(W), { sni: W, prefix: v2Header(FAKE, LB, 1, 443) });
check('LB tcp: PROXY v2 smuggled by the client is not believed', who(smuggled)?.remote !== FAKE && who(smuggled)?.client !== FAKE, smuggled.slice(0, 80));
for (const host of [`allow.${D}`, `allowci.${D}`]) {
	const r = await raw(LB, 443, req(host), { sni: host });
	check(`LB tcp: ${host} admits the real client`, status(r) !== 403 && status(r) !== 0, status(r) || r.slice(0, 60));
}
const app = await raw(LB, 443, req(`app.${D}`), { sni: `app.${D}` });
check('LB tcp: Host routing reaches the app', status(app) === 200 && /hello from/.test(app), status(app));

// Through the LB, http (L7) + X-Forwarded-For.
const viaL7 = who(await raw(LB, 8080, req(W)));
check('LB http (L7): client_ip is the true client; remote.host is the LB private address', viaL7?.client === MAC && viaL7?.remote === LBP, viaL7);
const viaL7Xff = who(await raw(LB, 8080, req(W, '/', `X-Forwarded-For: ${FAKE}\r\n`)));
check('LB http (L7): client-sent X-Forwarded-For not believed', viaL7Xff?.client === MAC, viaL7Xff);
for (const host of [`allow.${D}`, `allowci.${D}`]) {
	const r = await raw(LB, 8080, req(host));
	check(`LB http (L7): ${host} from the real client (remote_ip is the LB; expected 403 for allow.)`, host.startsWith('allowci') ? status(r) === 200 : status(r) === 403, status(r));
}

// Straight to a node's public address: outside trusted_proxies.
const direct = who(await raw(NODE, 443, req(W), { sni: W }));
check('direct to node: remote and client are the caller', direct?.remote === MAC && direct?.client === MAC, direct);
for (const [label, prefix] of [['v2', v2Header(FAKE, NODE, 40000, 443)], ['v1', v1Header(FAKE, NODE, 443)]] as const) {
	const r = who(await raw(NODE, 443, req(W), { sni: W, prefix }));
	check(`direct to node :443: forged PROXY ${label} not believed`, r !== null && r.remote === MAC && r.client === MAC, r);
}
const directXff = who(await raw(NODE, 443, req(W, '/', `X-Forwarded-For: ${FAKE}\r\n`), { sni: W }));
check('direct to node :443: forged X-Forwarded-For not believed', directXff?.client === MAC, directXff);
for (const port of [80, HEALTH, 8081]) {
	for (const [label, prefix] of [['v2', v2Header(FAKE, NODE, 40000, port)], ['v1', v1Header(FAKE, NODE, port)]] as const) {
		const r = await raw(NODE, port, req('probe', '/.well-known/yoal/health'), { prefix });
		check(`direct to node :${port}: forged PROXY ${label} answered, not crashed`, status(r) === 200 || status(r) === 503, status(r) || r.slice(0, 60));
	}
}
const l7Forged = who(await raw(NODE, 8081, req(W), { prefix: v2Header(FAKE, NODE, 40000, 8081) }));
check('direct to node :8081 (L7 listener): forged PROXY v2 not believed', l7Forged?.remote === MAC && l7Forged?.client === MAC, l7Forged);

// Garbage on the public listeners; each must keep serving.
const garbage: [string, Buffer, number?][] = [
	['random 4 KiB', Buffer.from(crypto.getRandomValues(new Uint8Array(4096)))],
	['v2 length 65535, short body', Buffer.concat([v2Header(FAKE, NODE, 1, 2).subarray(0, 14), Buffer.from([0xff, 0xff]), Buffer.alloc(32, 1)])],
	['header that never finishes (7 s)', v2Header(FAKE, NODE, 1, 2).subarray(0, 6), 7000],
];
for (const port of [443, 80, HEALTH]) {
	for (const [label, prefix, holdMs] of garbage) {
		await raw(NODE, port, '', { prefix, holdMs });
		const after = await raw(NODE, HEALTH, req('probe', '/.well-known/yoal/health'));
		const tlsAfter = who(await raw(NODE, 443, req(W), { sni: W })) !== null;
		check(`garbage :${port} ${label}: listeners still serve`, status(after) === 200 && tlsAfter, status(after));
	}
}
console.log(JSON.stringify(cases));
process.exit(0);
