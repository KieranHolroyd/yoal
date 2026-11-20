#!/usr/bin/env bun
/**
 * HA lab bootstrap, run as root on lab-a (the control-plane node) by `lab up`. It does what an
 * operator does on a fresh install, through the same endpoints the dashboard uses, so the lab is a
 * real fleet and not a fixture:
 *
 *   1. claim the instance with the installer's setup token (owner + organisation + TOTP), or sign
 *      the saved lab owner back in
 *   2. mint an API key for the lab's scripts (kept in /etc/yoal-lab/token, 0600)
 *   3. set the cluster config the HA scenarios need (failover on, its grace periods)
 *   4. mint one join token per worker name given with --join
 *   5. put the edge node on the managed overlay (--edge-endpoint), so workers have a hub
 *   6. name nodes and set their zones (--nodes lab-a=cloud-a,lab-b=cloud-b,…; the edge is
 *      renamed from the installer's "edge" to the first name)
 *   7. raise every node's workload slice to --slice-mb
 *   8. drain or resume named nodes (--drain lab-c --resume lab-c; scenarios use it to place copies)
 *   9. remove half-joined nodes (--remove lab-c) before `lab up` joins them again: a join whose
 *      answer was lost leaves a row holding the node's WireGuard key, and a retry then fails
 *
 * Prints one JSON object on stdout: { origin, joinTokens: { name: token }, nodes: [...] }.
 * Everything else goes to stderr. Lab only: the owner is a throwaway on a throwaway node.
 *
 *   bun bootstrap.ts [--join lab-b,lab-c] [--failover on|off] [--failover-grace 120]
 *                    [--replica-grace 120] [--slice-mb 2048] [--edge-endpoint 172.30.147.11]
 *                    [--nodes lab-a=cloud-a,lab-b=cloud-b] [--nodes-only]
 */
import { createHmac, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values: flags } = parseArgs({
	options: {
		join: { type: 'string', default: '' },
		failover: { type: 'string' },
		'failover-grace': { type: 'string' },
		'replica-grace': { type: 'string' },
		'slice-mb': { type: 'string' },
		'nodes-only': { type: 'boolean', default: false },
		'edge-endpoint': { type: 'string' },
		drain: { type: 'string', default: '' },
		resume: { type: 'string', default: '' },
		remove: { type: 'string', default: '' },
		nodes: { type: 'string', default: '' },
		state: { type: 'string', default: '/etc/yoal-lab' },
	},
});

const STATE = flags.state!;
mkdirSync(STATE, { recursive: true, mode: 0o700 });
const OWNER_FILE = `${STATE}/owner.json`;
const SESSION_FILE = `${STATE}/session.json`;
const TOKEN_FILE = `${STATE}/token`;
const envText = readFileSync('/etc/yoal/yoal.env', 'utf8');
const originMatch = /^YOAL_PLATFORM_ORIGIN=["']?([^"'\n]+)["']?$/m.exec(envText)?.[1];
if (!originMatch) throw new Error('YOAL_PLATFORM_ORIGIN not found in /etc/yoal/yoal.env');
const origin: string = originMatch;
const say = (message: string) => console.error(`bootstrap: ${message}`);

interface Owner {
	email: string;
	password: string;
	totpSecret: string;
}

const jar = new Map<string, string>();
function remember(response: Response): void {
	for (const header of response.headers.getSetCookie()) {
		const [pair] = header.split(';');
		const eq = pair!.indexOf('=');
		const name = pair!.slice(0, eq).trim();
		const value = pair!.slice(eq + 1).trim();
		if (!value || /max-age=0/i.test(header)) jar.delete(name);
		else jar.set(name, value);
	}
}
const cookieHeader = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
	const response = await fetch(new URL(path, origin), {
		method,
		redirect: 'manual',
		headers: { origin, cookie: cookieHeader(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	remember(response);
	const text = await response.text();
	try {
		return { status: response.status, body: JSON.parse(text) };
	} catch {
		return { status: response.status, body: text };
	}
}

async function action(path: string, name: string, fields: Record<string, string>): Promise<string> {
	const response = await fetch(new URL(`${path}?/${name}`, origin), {
		method: 'POST',
		redirect: 'manual',
		headers: { origin, accept: 'application/json', 'x-sveltekit-action': 'true', cookie: cookieHeader() },
		body: new URLSearchParams(fields),
	});
	remember(response);
	const text = await response.text();
	const result = JSON.parse(text) as { type?: string; status?: number; data?: string };
	if (result.type === 'failure' || result.type === 'error')
		throw new Error(`${path}?/${name} failed (${result.status ?? response.status}): ${String(result.data ?? '').slice(0, 300)}`);
	return String(result.data ?? '');
}

function base32Decode(input: string): Buffer {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
	let bits = 0;
	let value = 0;
	const out: number[] = [];
	for (const char of input.replace(/=+$/, '').toUpperCase()) {
		value = (value << 5) | alphabet.indexOf(char);
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}
	return Buffer.from(out);
}

async function totp(secret: string): Promise<string> {
	const intoStep = (Date.now() / 1000) % 30;
	if (intoStep > 27) await Bun.sleep((30 - intoStep + 0.5) * 1000);
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)));
	const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
	const offset = mac[mac.length - 1]! & 0x0f;
	return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

async function claim(): Promise<void> {
	const owner: Owner = { email: 'lab-owner@yoal-lab.test', password: randomBytes(18).toString('base64url'), totpSecret: '' };
	await action('/setup', 'unlock', { token: readFileSync('/etc/yoal/setup-token', 'utf8').trim() });
	await action('/setup', 'claim', { name: 'Lab Owner', email: owner.email, organizationName: 'HA Lab', password: owner.password, passwordConfirm: owner.password });
	const started = await action('/setup', 'startTotp', { password: owner.password });
	const uri = /otpauth:\/\/totp\/[^"\\]+/.exec(started)?.[0];
	const secret = uri ? new URL(uri.replace(/\\u0026/g, '&')).searchParams.get('secret') : null;
	if (!secret) throw new Error('startTotp returned no otpauth URI');
	owner.totpSecret = secret;
	writeFileSync(OWNER_FILE, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
	await action('/setup', 'verifyTotp', { code: await totp(secret) });
	saveSession();
	say('owner claimed');
}

async function signIn(owner: Owner): Promise<void> {
	// Reuse the last session: a TOTP code is accepted once, so signing in twice within one 30 s
	// step (lab status right after lab up) would be refused as a replay.
	if (existsSync(SESSION_FILE)) {
		for (const [name, value] of Object.entries(JSON.parse(readFileSync(SESSION_FILE, 'utf8')) as Record<string, string>)) jar.set(name, value);
		if ((await call('GET', '/api/v1/nodes')).status === 200) return;
		jar.clear();
	}
	for (let attempt = 0; ; attempt++) {
		const first = await call('POST', '/api/auth/sign-in/email', { email: owner.email, password: owner.password });
		if (first.status !== 200) throw new Error(`owner sign-in failed (${first.status})`);
		if (!first.body?.twoFactorRedirect) break;
		const second = await call('POST', '/api/auth/two-factor/verify-totp', { code: await totp(owner.totpSecret) });
		if (second.status === 200) break;
		if (attempt >= 1) throw new Error(`owner TOTP failed (${second.status})`);
		// Most likely this step's code was already used: wait for the next one.
		await Bun.sleep((30 - ((Date.now() / 1000) % 30) + 1) * 1000);
	}
	saveSession();
}

function saveSession(): void {
	writeFileSync(SESSION_FILE, `${JSON.stringify(Object.fromEntries(jar))}\n`, { mode: 0o600 });
}

// Wait for the control plane, then sign in or claim.
for (let attempt = 0; ; attempt++) {
	const status = await call('GET', '/api/setup/status').catch(() => ({ status: 0, body: null }));
	if (status.status === 200) break;
	if (attempt > 120) throw new Error(`the control plane at ${origin} did not answer`);
	await Bun.sleep(2000);
}
if (existsSync(OWNER_FILE)) await signIn(JSON.parse(readFileSync(OWNER_FILE, 'utf8')) as Owner);
else await claim();

const result: { origin: string; joinTokens: Record<string, string>; nodes: unknown[] } = { origin, joinTokens: {}, nodes: [] };

if (!flags['nodes-only']) {
	let token = existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, 'utf8').trim() : '';
	if (token) {
		const probe = await fetch(new URL('/api/v1/projects', origin), { headers: { authorization: `Bearer ${token}` } });
		if (!probe.ok) token = '';
	}
	if (!token) {
		const created = await call('POST', '/api/v1/access-keys', { name: 'ha lab' });
		if (created.status !== 201 || typeof created.body?.key !== 'string') throw new Error(`creating the API key failed (${created.status})`);
		writeFileSync(TOKEN_FILE, `${created.body.key}\n`, { mode: 0o600 });
		chmodSync(TOKEN_FILE, 0o600);
		say(`API key written to ${TOKEN_FILE}`);
	}

	const failover: Record<string, unknown> = {};
	if (flags.failover) failover.enabled = flags.failover === 'on';
	if (flags['failover-grace']) failover.graceSeconds = Number(flags['failover-grace']);
	const patch: Record<string, unknown> = {};
	if (Object.keys(failover).length) patch.failover = failover;
	if (flags['replica-grace']) patch.replicas = { failoverGraceSeconds: Number(flags['replica-grace']) };
	if (Object.keys(patch).length) {
		const updated = await call('PATCH', '/api/v1/cluster/config', patch);
		if (updated.status !== 200) throw new Error(`cluster config update failed (${updated.status}): ${JSON.stringify(updated.body).slice(0, 300)}`);
		say(`cluster config: ${JSON.stringify(patch)}`);
	}

	for (const name of flags.join!.split(',').filter(Boolean)) {
		const created = await call('POST', '/api/v1/nodes/join-token', { name });
		const token = created.body?.token ?? created.body?.joinToken;
		if (created.status !== 201 || typeof token !== 'string') throw new Error(`join token for ${name} failed (${created.status}): ${JSON.stringify(created.body).slice(0, 300)}`);
		result.joinTokens[name] = token;
	}
}

interface NodeRow {
	id: string;
	name: string;
	mode: string;
	zone?: string;
	networkMode?: string;
	sliceMemoryMb: number;
}
async function listNodes(): Promise<NodeRow[]> {
	const listed = await call('GET', '/api/v1/nodes');
	if (listed.status !== 200) throw new Error(`listing nodes failed (${listed.status})`);
	return (listed.body?.nodes ?? []) as NodeRow[];
}
let nodes = await listNodes();
for (const name of flags.remove!.split(',').filter(Boolean)) {
	const node = nodes.find((candidate) => candidate.name === name);
	if (!node || node.mode === 'edge') continue;
	const removed = await call('DELETE', `/api/v1/nodes/${node.id}`);
	if (removed.status !== 200 && removed.status !== 204) throw new Error(`removing ${name} failed (${removed.status}): ${JSON.stringify(removed.body).slice(0, 300)}`);
	say(`${name}: removed a half-joined node row`);
}
if (flags.remove) nodes = await listNodes();

const edge = nodes.find((node) => node.mode === 'edge');
if (flags['edge-endpoint'] && edge && edge.networkMode !== 'yoal') {
	const adopted = await call('POST', `/api/v1/nodes/${edge.id}/overlay`, { endpoint: flags['edge-endpoint'] });
	if (adopted.status !== 200 && adopted.status !== 409)
		throw new Error(`moving ${edge.name} onto the overlay failed (${adopted.status}): ${JSON.stringify(adopted.body).slice(0, 300)}`);
	say(`${edge.name}: on the managed overlay, endpoint ${flags['edge-endpoint']}`);
}
const wanted = flags.nodes!.split(',').filter(Boolean).map((pair) => pair.split('=') as [string, string]);
for (const [index, [name, zone]] of wanted.entries()) {
	const node = nodes.find((candidate) => candidate.name === name) ?? (index === 0 ? edge : undefined);
	if (!node) continue;
	const patch: Record<string, unknown> = {};
	if (node.name !== name) patch.name = name;
	if (zone && node.zone !== zone) patch.zone = zone;
	if (!Object.keys(patch).length) continue;
	const patched = await call('PATCH', `/api/v1/nodes/${node.id}`, patch);
	if (patched.status !== 200) throw new Error(`updating ${node.name} failed (${patched.status}): ${JSON.stringify(patched.body).slice(0, 300)}`);
	say(`${node.name}: ${JSON.stringify(patch)}`);
}
nodes = await listNodes();
for (const [flag, path] of [['drain', 'drain'], ['resume', 'resume']] as const) {
	for (const name of flags[flag]!.split(',').filter(Boolean)) {
		const node = nodes.find((candidate) => candidate.name === name);
		if (!node) throw new Error(`no node named ${name}`);
		const done = await call('POST', `/api/v1/nodes/${node.id}/${path}`);
		if (done.status !== 200) throw new Error(`${path} ${name} failed (${done.status}): ${JSON.stringify(done.body).slice(0, 300)}`);
		say(`${name}: ${path}`);
	}
}
nodes = await listNodes();
if (flags['slice-mb']) {
	const want = Number(flags['slice-mb']);
	for (const node of nodes) {
		if (node.sliceMemoryMb >= want) continue;
		const patched = await call('PATCH', `/api/v1/nodes/${node.id}`, { sliceMemoryMb: want });
		if (patched.status !== 200) throw new Error(`slice for ${node.name} failed (${patched.status})`);
		say(`${node.name}: workload slice ${node.sliceMemoryMb} → ${want} MB`);
	}
}
result.nodes = nodes;
console.log(JSON.stringify(result));
