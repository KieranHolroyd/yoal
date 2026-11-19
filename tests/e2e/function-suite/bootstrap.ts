#!/usr/bin/env bun
/**
 * Owner bootstrap for the function-suite e2e lane, run as root on the node. On a fresh install it
 * does what a person does in the setup wizard, through the same form actions, so that path is
 * exercised too:
 *
 *   1. unlock the wizard with the installer's one-time setup token (/etc/yoal/setup-token)
 *   2. claim the instance (owner account + organisation)
 *   3. enrol an authenticator app and answer it with a computed TOTP code (owners need a second
 *      factor before they can do anything, D10)
 *
 * On a claimed instance it signs the same owner back in (password, then TOTP). With that session
 * it then:
 *
 *   4. sets every node's workload slice to --slice-mb when it is lower (a platform-admin dashboard
 *      action: the 1024 MB default cannot hold the suite's services and two functions)
 *   5. mints an API key unless --out already holds one that works
 *
 * The owner's password and TOTP secret stay in --owner (0600) on the disposable node so a later
 * run can sign in again; the key goes to --out (0600). Neither is printed.
 *
 *   bun bootstrap.ts --out /etc/yoal-e2e/token --owner /etc/yoal-e2e/owner.json [--slice-mb 3072]
 */
import { createHmac, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values: flags } = parseArgs({
	options: {
		out: { type: 'string' },
		owner: { type: 'string' },
		env: { type: 'string', default: '/etc/yoal/yoal.env' },
		'setup-token': { type: 'string', default: '/etc/yoal/setup-token' },
		'slice-mb': { type: 'string' },
	},
});
if (!flags.out || !flags.owner) {
	console.error('usage: bun bootstrap.ts --out <token-file> --owner <owner.json> [--slice-mb <mb>] [--env /etc/yoal/yoal.env]');
	process.exit(2);
}

const envText = readFileSync(flags.env!, 'utf8');
const origin = /^YOAL_PLATFORM_ORIGIN=["']?([^"'\n]+)["']?$/m.exec(envText)?.[1];
if (!origin) throw new Error(`YOAL_PLATFORM_ORIGIN not found in ${flags.env}`);

interface Owner {
	email: string;
	password: string;
	totpSecret: string;
}

// --------------------------------------------------------------------------- HTTP + cookies

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

function cookieHeader(): string {
	return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

/** A JSON request with the session cookies; returns status and parsed body (or text). */
async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
	const response = await fetch(new URL(path, origin), {
		method,
		redirect: 'manual',
		headers: {
			origin,
			cookie: cookieHeader(),
			...(body === undefined ? {} : { 'content-type': 'application/json' }),
		},
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

/** POST a SvelteKit form action; returns the ActionResult's raw (devalue-encoded) `data`. */
async function action(path: string, name: string, fields: Record<string, string>): Promise<string> {
	const response = await fetch(new URL(`${path}?/${name}`, origin), {
		method: 'POST',
		redirect: 'manual',
		headers: { origin, accept: 'application/json', 'x-sveltekit-action': 'true', cookie: cookieHeader() },
		body: new URLSearchParams(fields),
	});
	remember(response);
	const text = await response.text();
	let result: { type?: string; status?: number; data?: string };
	try {
		result = JSON.parse(text);
	} catch {
		throw new Error(`${path}?/${name}: HTTP ${response.status}, not an action result: ${text.slice(0, 200)}`);
	}
	if (result.type === 'failure' || result.type === 'error')
		throw new Error(`${path}?/${name} failed (${result.status ?? response.status}): ${String(result.data ?? '').slice(0, 300)}`);
	return String(result.data ?? '');
}

// --------------------------------------------------------------------------- TOTP (RFC 6238)

function base32Decode(input: string): Buffer {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
	let bits = 0;
	let value = 0;
	const out: number[] = [];
	for (const char of input.replace(/=+$/, '').toUpperCase()) {
		const index = alphabet.indexOf(char);
		if (index < 0) throw new Error('invalid base32 in the TOTP secret');
		value = (value << 5) | index;
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}
	return Buffer.from(out);
}

/** The current code; waits out the last seconds of a step so the server judges the same step. */
async function totp(secret: string): Promise<string> {
	const intoStep = (Date.now() / 1000) % 30;
	if (intoStep > 27) await Bun.sleep((30 - intoStep + 0.5) * 1000);
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)));
	const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
	const offset = mac[mac.length - 1]! & 0x0f;
	return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

// --------------------------------------------------------------------------- owner session

async function claim(): Promise<Owner> {
	const setupToken = readFileSync(flags['setup-token']!, 'utf8').trim();
	const owner: Owner = { email: 'e2e-owner@example.com', password: randomBytes(18).toString('base64url'), totpSecret: '' };
	await action('/setup', 'unlock', { token: setupToken });
	await action('/setup', 'claim', {
		name: 'E2E Owner',
		email: owner.email,
		organizationName: 'E2E',
		password: owner.password,
		passwordConfirm: owner.password,
	});
	console.log('bootstrap: owner claimed');
	// The action data is devalue-encoded; the otpauth URI is a plain string inside it.
	const started = await action('/setup', 'startTotp', { password: owner.password });
	const uri = /otpauth:\/\/totp\/[^"\\]+/.exec(started)?.[0];
	const secret = uri ? new URL(uri.replace(/\\u0026/g, '&')).searchParams.get('secret') : null;
	if (!secret) throw new Error(`startTotp returned no otpauth URI: ${started.slice(0, 200)}`);
	owner.totpSecret = secret;
	// Saved before verifying: a half-finished enrolment can still be signed in to next time.
	writeFileSync(flags.owner!, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
	chmodSync(flags.owner!, 0o600);
	await action('/setup', 'verifyTotp', { code: await totp(secret) });
	console.log('bootstrap: authenticator enrolled');
	return owner;
}

async function signIn(owner: Owner): Promise<void> {
	const first = await call('POST', '/api/auth/sign-in/email', { email: owner.email, password: owner.password });
	if (first.status !== 200) throw new Error(`owner sign-in failed (${first.status}): ${JSON.stringify(first.body).slice(0, 200)}`);
	if ((first.body as { twoFactorRedirect?: boolean }).twoFactorRedirect) {
		const second = await call('POST', '/api/auth/two-factor/verify-totp', { code: await totp(owner.totpSecret) });
		if (second.status !== 200) throw new Error(`owner TOTP failed (${second.status}): ${JSON.stringify(second.body).slice(0, 200)}`);
	}
	console.log('bootstrap: owner signed in');
}

// --------------------------------------------------------------------------- run

if (existsSync(flags.owner)) await signIn(JSON.parse(readFileSync(flags.owner, 'utf8')) as Owner);
else {
	const status = await call('GET', '/api/setup/status');
	if ((status.body as { needsSetup?: boolean }).needsSetup === false)
		throw new Error(`the instance is already claimed and ${flags.owner} is missing: start from a fresh machine`);
	await claim();
}

if (flags['slice-mb']) {
	const want = Number(flags['slice-mb']);
	const listed = await call('GET', '/api/v1/nodes');
	if (listed.status !== 200) throw new Error(`listing nodes failed (${listed.status}): ${JSON.stringify(listed.body).slice(0, 200)}`);
	const list = (listed.body as { nodes?: Array<{ id: string; name: string; sliceMemoryMb: number }> }).nodes ?? [];
	for (const node of list) {
		if (node.sliceMemoryMb >= want) continue;
		const patched = await call('PATCH', `/api/v1/nodes/${node.id}`, { sliceMemoryMb: want });
		if (patched.status !== 200) throw new Error(`setting ${node.name}'s slice failed (${patched.status}): ${JSON.stringify(patched.body).slice(0, 200)}`);
		console.log(`bootstrap: ${node.name} workload slice ${node.sliceMemoryMb} → ${want} MB`);
	}
}

if (existsSync(flags.out)) {
	const token = readFileSync(flags.out, 'utf8').trim();
	const probe = await fetch(new URL('/api/v1/projects', origin), { headers: { authorization: `Bearer ${token}` } });
	if (probe.ok) {
		console.log(`bootstrap: reusing the key in ${flags.out}`);
		process.exit(0);
	}
}
const created = await call('POST', '/api/v1/access-keys', { name: 'function-suite e2e' });
// `{ accessKey: { …, start: 'yoal_abc' }, key: 'yoal_…' }`: only `key` is the secret.
const token = (created.body as { key?: unknown }).key;
if (created.status !== 201 || typeof token !== 'string' || !token.startsWith('yoal_'))
	throw new Error(`creating the API key failed (${created.status})`);
writeFileSync(flags.out, `${token}\n`, { mode: 0o600 });
chmodSync(flags.out, 0o600);
console.log(`bootstrap: API key written to ${flags.out}`);
