/**
 * Criterion 2 and 5 probes, run inside a lab container. `--suite`:
 *   attacker  direct to an ingress from outside trustedProxies: forged PROXY v1/v2, forged XFF, garbage
 *   client    through HAProxy (tcp :443 and http :8080): true address, XFF not believed, Host routing
 *   trusted   from HAProxy's own network namespace (a trusted source): what a listed source can do
 *   health    the health endpoint's answers on every listener (body size, headers)
 * Prints one JSON array of cases: { name, pass, detail }.
 */
import net from 'node:net';
import tls from 'node:tls';
import { parseArgs } from 'node:util';
import { LAB } from './lab.ts';

const { values: args } = parseArgs({
	options: { suite: { type: 'string' }, ingress: { type: 'string', default: LAB.ingress[0]!.ip } },
});
const ING = args.ingress!;
const FAKE = '203.0.113.7';
const D = LAB.domain;

function v2Header(src: string, dst: string, srcPort: number, dstPort: number, command = 0x21): Buffer {
	const sig = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]);
	if (command === 0x20) return Buffer.concat([sig, Buffer.from([0x20, 0x00, 0x00, 0x00])]);
	const body = Buffer.alloc(12);
	src.split('.').forEach((o, i) => body.writeUInt8(Number(o), i));
	dst.split('.').forEach((o, i) => body.writeUInt8(Number(o), 4 + i));
	body.writeUInt16BE(srcPort, 8);
	body.writeUInt16BE(dstPort, 10);
	return Buffer.concat([sig, Buffer.from([command, 0x11, 0x00, 0x0c]), body]);
}
const v1Header = (src: string, dst: string, dstPort: number) => Buffer.from(`PROXY TCP4 ${src} ${dst} 40000 ${dstPort}\r\n`);

interface Raw {
	host: string;
	port: number;
	tls?: boolean;
	sni?: string;
	prefix?: Buffer;
	request?: string;
	/** Send only the prefix and wait this long before reading. */
	holdMs?: number;
}

/** Writes `prefix`, then (optionally over TLS) the request; resolves with the raw response or an error label. */
function raw(options: Raw): Promise<string> {
	return new Promise((resolve) => {
		let out = '';
		let settled = false;
		const done = (value: string) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		const timer = setTimeout(() => {
			done(out ? out : 'timeout');
			sock.destroy();
		}, (options.holdMs ?? 0) + 4000);
		const sock = net.connect({ host: options.host, port: options.port }, () => {
			if (options.prefix) sock.write(options.prefix);
			if (options.holdMs) {
				setTimeout(() => {
					if (!sock.destroyed) sock.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n');
				}, options.holdMs);
				return;
			}
			if (!options.request) {
				sock.end();
				return;
			}
			if (options.tls) {
				const secure = tls.connect({ socket: sock, servername: options.sni, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] }, () =>
					secure.write(options.request!),
				);
				secure.on('data', (c) => {
					out += c.toString();
					if (/\r\n\r\n[\s\S]*$/.test(out) && complete(out)) {
						clearTimeout(timer);
						done(out);
						secure.destroy();
					}
				});
				secure.on('error', (e: Error & { code?: string }) => {
					clearTimeout(timer);
					done(out || `tls-error:${e.code ?? e.message}`);
				});
				secure.on('close', () => {
					clearTimeout(timer);
					done(out || 'closed');
				});
			} else sock.write(options.request);
		});
		sock.on('data', (c) => {
			if (options.tls && options.request && !options.holdMs) return;
			out += c.toString('latin1');
			if (complete(out)) {
				clearTimeout(timer);
				done(out);
				sock.destroy();
			}
		});
		sock.on('error', (e: Error & { code?: string }) => {
			clearTimeout(timer);
			done(out || `error:${e.code ?? e.message}`);
		});
		sock.on('close', () => {
			clearTimeout(timer);
			done(out || 'closed');
		});
	});
}

function complete(out: string): boolean {
	const end = out.indexOf('\r\n\r\n');
	if (end < 0) return false;
	const m = /content-length:\s*(\d+)/i.exec(out.slice(0, end));
	return m ? out.length >= end + 4 + Number(m[1]) : true;
}

const req = (host: string, path = '/', extra = '') => `GET ${path} HTTP/1.1\r\nHost: ${host}\r\n${extra}Connection: close\r\n\r\n`;
const status = (r: string) => Number(/^HTTP\/1\.1 (\d{3})/.exec(r)?.[1] ?? 0);
const body = (r: string) => r.slice(r.indexOf('\r\n\r\n') + 4);
function whoami(r: string): Record<string, string> | null {
	try {
		return JSON.parse(body(r));
	} catch {
		return null;
	}
}

const cases: { name: string; pass: boolean; detail: unknown }[] = [];
const check = (name: string, pass: boolean, detail: unknown) => cases.push({ name, pass, detail });

async function healthOk(port: number): Promise<boolean> {
	const r = await raw({ host: ING, port, request: req('probe', '/.well-known/yoal/health') });
	return status(r) === 200 || status(r) === 503;
}
const wantHost = `whoami.${D}`;

async function attacker() {
	const me = (await raw({ host: ING, port: 443, tls: true, sni: wantHost, request: req(wantHost) }))!;
	const self = whoami(me);
	check('direct, no header: remote and client are the caller', self?.remote === LAB.attacker.ip && self?.client === LAB.attacker.ip, self);

	const v2 = whoami(await raw({ host: ING, port: 443, tls: true, sni: wantHost, prefix: v2Header(FAKE, ING, 40000, 443), request: req(wantHost) }));
	check('forged PROXY v2 on :443 from unlisted source: not believed', v2 !== null && v2.remote !== FAKE && v2.client !== FAKE, v2);
	const v1 = whoami(await raw({ host: ING, port: 443, tls: true, sni: wantHost, prefix: v1Header(FAKE, ING, 443), request: req(wantHost) }));
	check('forged PROXY v1 on :443 from unlisted source: not believed', v1 !== null && v1.remote !== FAKE && v1.client !== FAKE, v1);
	const xff = whoami(await raw({ host: ING, port: 443, tls: true, sni: wantHost, request: req(wantHost, '/', `X-Forwarded-For: ${FAKE}\r\n`) }));
	check('forged X-Forwarded-For from unlisted source: not believed', xff?.client === LAB.attacker.ip && xff?.remote === LAB.attacker.ip, xff);

	// Today's allowlist (remote_ip) and the client_ip variant both allow only the client (.50).
	for (const host of [`allow.${D}`, `allowci.${D}`]) {
		const spoofV2 = await raw({ host: ING, port: 443, tls: true, sni: host, prefix: v2Header(LAB.client.ip, ING, 40000, 443), request: req(host) });
		check(`${host}: PROXY v2 claiming the allowed address from an unlisted source is refused`, status(spoofV2) === 403, status(spoofV2) || spoofV2.slice(0, 60));
		const spoofXff = await raw({ host: ING, port: 443, tls: true, sni: host, request: req(host, '/', `X-Forwarded-For: ${LAB.client.ip}\r\n`) });
		check(`${host}: XFF claiming the allowed address from an unlisted source is refused`, status(spoofXff) === 403, status(spoofXff));
	}

	// Plain listeners: forged headers still get an answer, never a crash.
	for (const port of [80, LAB.healthPort]) {
		for (const [label, prefix] of [['v2', v2Header(FAKE, ING, 40000, port)], ['v1', v1Header(FAKE, ING, port)]] as const) {
			const r = await raw({ host: ING, port, prefix, request: req('probe', '/.well-known/yoal/health') });
			check(`:${port} forged PROXY ${label} from unlisted source: answered, not crashed`, status(r) === 200 || status(r) === 503, status(r) || r.slice(0, 60));
		}
	}
	await garbage('unlisted');
}

async function garbage(source: string) {
	const cases_: [string, Buffer, number?][] = [
		['random 4 KiB', Buffer.from(crypto.getRandomValues(new Uint8Array(4096)))],
		['truncated v2 signature', v2Header(FAKE, ING, 1, 2).subarray(0, 14)],
		['bad v1 line', Buffer.from('PROXY GARBAGE\r\n')],
		['v2 length 65535, short body', Buffer.concat([v2Header(FAKE, ING, 1, 2).subarray(0, 14), Buffer.from([0xff, 0xff]), Buffer.alloc(32, 1)])],
		['v2 unknown family', Buffer.concat([v2Header(FAKE, ING, 1, 2).subarray(0, 13), Buffer.from([0x77, 0x00, 0x00])])],
		['header that never finishes (7 s)', v2Header(FAKE, ING, 1, 2).subarray(0, 6), 7000],
	];
	for (const port of [443, 80, LAB.healthPort]) {
		for (const [label, prefix, holdMs] of cases_) {
			const started = Date.now();
			const r = await raw({ host: ING, port, prefix, holdMs, request: holdMs ? undefined : '' });
			const after = await healthOk(port === 443 ? LAB.healthPort : port);
			const tlsAfter = port === 443 ? whoami(await raw({ host: ING, port: 443, tls: true, sni: wantHost, request: req(wantHost) })) !== null : true;
			check(`${source} garbage :${port} ${label}: listener still serves`, after && tlsAfter, {
				answer: r.slice(0, 40).replace(/[^\x20-\x7e]/g, '.'),
				ms: Date.now() - started,
			});
		}
	}
}

async function client() {
	const tcp = whoami(await raw({ host: LAB.haproxy.ip, port: 443, tls: true, sni: wantHost, request: req(wantHost) }));
	check('HAProxy tcp + PROXY v2: remote and client are the true client', tcp?.remote === LAB.client.ip && tcp?.client === LAB.client.ip, tcp);
	const tcpXff = whoami(await raw({ host: LAB.haproxy.ip, port: 443, tls: true, sni: wantHost, request: req(wantHost, '/', `X-Forwarded-For: ${FAKE}\r\n`) }));
	check('HAProxy tcp: client-sent XFF not believed', tcpXff?.client === LAB.client.ip, tcpXff);
	const http = whoami(await raw({ host: LAB.haproxy.ip, port: 8080, request: req(wantHost) }));
	check('HAProxy http + PROXY v2: remote and client are the true client', http?.remote === LAB.client.ip && http?.client === LAB.client.ip, http);
	const httpXff = whoami(await raw({ host: LAB.haproxy.ip, port: 8080, request: req(wantHost, '/', `X-Forwarded-For: ${FAKE}\r\n`) }));
	check('HAProxy http: client-sent XFF not believed', httpXff?.client === LAB.client.ip, httpXff);
	const smuggled = await raw({ host: LAB.haproxy.ip, port: 443, prefix: v2Header(FAKE, ING, 1, 443), tls: true, sni: wantHost, request: req(wantHost) });
	check('PROXY v2 smuggled through HAProxy tcp: not believed', whoami(smuggled)?.remote !== FAKE && whoami(smuggled)?.client !== FAKE, smuggled.slice(0, 60));
	for (const [port, tlsOn] of [[443, true], [8080, false]] as const) {
		for (const host of [`allow.${D}`, `allowci.${D}`]) {
			const r = await raw({ host: LAB.haproxy.ip, port, tls: tlsOn, sni: host, request: req(host) });
			check(`via HAProxy :${port} ${host} from the allowed client: not refused by the allowlist`, status(r) !== 403, status(r));
		}
		const app = await raw({ host: LAB.haproxy.ip, port, tls: tlsOn, sni: `app.${D}`, request: req(`app.${D}`) });
		check(`via HAProxy :${port} Host routing: app.${D} reaches the app`, status(app) === 200 && /hello from app/.test(body(app)), status(app));
		const stat = await raw({ host: LAB.haproxy.ip, port, tls: tlsOn, sni: `static.${D}`, request: req(`static.${D}`) });
		check(`via HAProxy :${port} Host routing: static.${D} serves its files`, status(stat) === 200 && /s9 static/.test(body(stat)), status(stat));
		const unknown = await raw({ host: LAB.haproxy.ip, port, tls: tlsOn, sni: `nope.${D}`, request: req(`nope.${D}`) });
		check(`via HAProxy :${port} Host routing: unknown host gets 404`, status(unknown) === 404, status(unknown));
	}
}

async function trusted() {
	const none = whoami(await raw({ host: ING, port: 443, tls: true, sni: wantHost, request: req(wantHost) }));
	check('trusted source, no PROXY header (probe path): accepted, remote is the balancer', none?.remote === LAB.haproxy.ip, none);
	const v2 = whoami(await raw({ host: ING, port: 443, tls: true, sni: wantHost, prefix: v2Header(FAKE, ING, 40000, 443), request: req(wantHost) }));
	check('trusted source, PROXY v2: believed', v2?.remote === FAKE && v2?.client === FAKE, v2);
	const local = whoami(await raw({ host: ING, port: 443, tls: true, sni: wantHost, prefix: v2Header('', '', 0, 0, 0x20), request: req(wantHost) }));
	check('trusted source, PROXY v2 LOCAL (health-check form): remote is the balancer', local?.remote === LAB.haproxy.ip, local);
	const xff = whoami(await raw({ host: ING, port: 443, tls: true, sni: wantHost, request: req(wantHost, '/', `X-Forwarded-For: ${FAKE}\r\n`) }));
	check('trusted source, XFF without PROXY (an L7 balancer): client_ip believed, remote_ip is the balancer', xff?.client === FAKE && xff?.remote === LAB.haproxy.ip, xff);
	await garbage('trusted');
}

async function health() {
	const answers: Record<string, unknown>[] = [];
	for (const [label, port, tlsOn, sni] of [
		['health port', LAB.healthPort, false, undefined],
		[':80', 80, false, undefined],
		[':443 with SNI', 443, true, `app.${D}`],
		[':443 without SNI', 443, true, undefined],
	] as const) {
		const r = await raw({ host: ING, port, tls: tlsOn, sni, request: req(sni ?? ING, '/.well-known/yoal/health') });
		const head = r.slice(0, r.indexOf('\r\n\r\n'));
		answers.push({ label, status: status(r), bodyBytes: Buffer.byteLength(body(r)), body: body(r), headers: head.split('\r\n').slice(1), raw: status(r) ? undefined : r.slice(0, 80) });
	}
	console.log(JSON.stringify(answers));
}

if (args.suite === 'health') await health();
else {
	if (args.suite === 'attacker') await attacker();
	if (args.suite === 'client') await client();
	if (args.suite === 'trusted') await trusted();
	console.log(JSON.stringify(cases));
}
process.exit(0);
