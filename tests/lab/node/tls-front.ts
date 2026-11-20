#!/usr/bin/env bun
/**
 * HA lab: a TLS front for the control plane, used only while workers join.
 *
 * `scripts/install/main.ts --join` refuses a control URL that is not https, and the lab has no
 * public domain or ACME. So `lab up` runs this on lab-a as a transient unit: it makes a lab CA and
 * a certificate for lab-a's address (once, under /etc/yoal-lab/tls), serves https on :8443 and
 * forwards every request to the platform origin over plain HTTP with the platform's Host header.
 * Workers trust the lab CA through NODE_EXTRA_CA_CERTS for the join only. The join answers with the
 * platform origin (http://<lab-a>), which is what the agents then use.
 *
 *   bun tls-front.ts --address 172.30.147.11 [--port 8443] [--dir /etc/yoal-lab/tls] [--certs-only]
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: flags } = parseArgs({
	options: {
		address: { type: 'string' },
		port: { type: 'string', default: '8443' },
		dir: { type: 'string', default: '/etc/yoal-lab/tls' },
		'certs-only': { type: 'boolean', default: false },
	},
});
if (!flags.address || !/^\d{1,3}(\.\d{1,3}){3}$/.test(flags.address)) throw new Error('--address <ipv4> is required');
const dir = flags.dir!;
mkdirSync(dir, { recursive: true, mode: 0o700 });

function openssl(args: string[]): void {
	const result = Bun.spawnSync(['openssl', ...args], { stdout: 'pipe', stderr: 'pipe' });
	if (result.exitCode !== 0) throw new Error(`openssl ${args[0]} failed: ${result.stderr.toString()}`);
}

const ca = join(dir, 'ca.crt');
const caKey = join(dir, 'ca.key');
const cert = join(dir, 'server.crt');
const key = join(dir, 'server.key');
if (!existsSync(ca)) {
	openssl(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '30', '-subj', '/CN=yoal-w0 lab CA', '-keyout', caKey, '-out', ca]);
}
if (!existsSync(cert)) {
	const ext = join(dir, 'server.ext');
	await Bun.write(ext, `subjectAltName=IP:${flags.address}\nextendedKeyUsage=serverAuth\n`);
	openssl(['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-subj', `/CN=${flags.address}`, '-keyout', key, '-out', join(dir, 'server.csr')]);
	openssl(['x509', '-req', '-in', join(dir, 'server.csr'), '-CA', ca, '-CAkey', caKey, '-CAcreateserial', '-days', '30', '-extfile', ext, '-out', cert]);
}
if (flags['certs-only']) {
	console.log(ca);
	process.exit(0);
}

const env = readFileSync('/etc/yoal/yoal.env', 'utf8');
const origin = /^YOAL_PLATFORM_ORIGIN=["']?([^"'\n]+)["']?$/m.exec(env)?.[1];
if (!origin) throw new Error('YOAL_PLATFORM_ORIGIN not found');
const platformHost = new URL(origin).host;

Bun.serve({
	port: Number(flags.port),
	hostname: flags.address,
	tls: { cert: Bun.file(cert), key: Bun.file(key) },
	async fetch(request) {
		const url = new URL(request.url);
		const headers = new Headers(request.headers);
		headers.set('host', platformHost);
		headers.set('x-forwarded-proto', 'http');
		// Bun's fetch decompresses the answer; ask for none, and never pass an encoding header on.
		headers.delete('accept-encoding');
		const upstream = await fetch(`http://127.0.0.1:80${url.pathname}${url.search}`, {
			method: request.method,
			headers,
			body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer(),
			redirect: 'manual',
		});
		const out = new Headers(upstream.headers);
		out.delete('content-encoding');
		out.delete('content-length');
		return new Response(await upstream.arrayBuffer(), { status: upstream.status, headers: out });
	},
});
console.log(`tls-front: https://${flags.address}:${flags.port} → ${origin}`);
