import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { ConflictError, UnauthorizedError } from './errors.ts';
import { LocalObjectStore } from './object-store.ts';

/**
 * HA-PLAN Wave 1 F11: a second join used to fail with an HTTP 500 (SQLite UNIQUE on
 * `nodes.wg_public_key`). Second review: an idempotent retry turned a used join token into a
 * credential for its node, since every field it could check (name, address, key, version, the
 * token itself) is visible on the command line or public. So there is no retry: any second use of
 * a token is a 409 that names the node and says what to do, and the node's own token never changes.
 * A WireGuard key another node holds is a 409 too.
 */
const dir = mkdtempSync(join(tmpdir(), 'yoal-node-join-'));
const opened = createDb({ path: ':memory:' });
const clock = { now: Date.parse('2026-11-20T12:00:00Z') };
const core: Core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	version: '0.1.0',
	config: {
		dataDir: dir,
		platformOrigin: 'https://control.test',
		contentDomain: 'sites.test',
		objectStore: new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123'),
		masterKey: new Uint8Array(32).fill(7),
		siteCookieSecret: 'site-cookie-secret-123',
		objectStoreSecret: 'object-secret-123',
		desiredAgentVersion: '0.1.0',
		now: () => clock.now,
	},
});
const admin = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
core.nodes.join({ token: core.nodes.createJoinToken(admin, 'edge').token, name: 'edge' });

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

const key = (letter: string) => `${letter.repeat(43)}=`;
const nodesWithKey = (wgKey: string) =>
	opened.sqlite.query<{ id: string }, [string]>('SELECT id FROM nodes WHERE wg_public_key = ?').all(wgKey);
const thrown = (fn: () => unknown): unknown => {
	try {
		fn();
	} catch (error) {
		return error;
	}
	throw new Error('expected a throw');
};

const nodeCount = () => opened.sqlite.query<{ n: number }, []>('SELECT count(*) AS n FROM nodes').get()!.n;

/** A second use of `input`'s token: a 409 naming the node, nothing written, the node's token intact. */
function expectUsedTokenRefused(input: Parameters<Core['nodes']['join']>[0], first: { nodeId: string; token: string }, name: string) {
	const before = nodeCount();
	const error = thrown(() => core.nodes.join(input));
	expect(error).toBeInstanceOf(ConflictError);
	expect((error as ConflictError).status).toBe(409);
	const message = (error as Error).message;
	expect(message).toContain('already used');
	expect(message).toContain(`"${name}"`);
	expect(message).toContain(first.nodeId);
	expect(message).toContain('new join token');
	expect(nodeCount()).toBe(before);
	expect(core.nodes.authenticate(first.token).id).toBe(first.nodeId);
}

describe('a second use of a join token (F11)', () => {
	test('the same token, name and key again: 409, and the node keeps its token', () => {
		const token = core.nodes.createJoinToken(admin, 'again-1').token;
		const input = { token, name: 'again-1', networkMode: 'yoal' as const, wireguardPublicKey: key('C'), publicAddress: '198.51.100.1' };
		const first = core.nodes.join(input);
		expectUsedTokenRefused(input, first, 'again-1');
		// The message says what to do with a node that never came up.
		expect((thrown(() => core.nodes.join(input)) as Error).message).toMatch(/remove/i);
		expect(nodesWithKey(key('C'))).toEqual([{ id: first.nodeId }]);
	});

	test('reviewer proof, external mode: a replay with the install command\'s values takes nothing over', () => {
		const token = core.nodes.createJoinToken(admin, 'victim-ext').token;
		const input = { token, name: 'victim-ext', networkMode: 'external' as const, publicAddress: '203.0.113.9', version: '0.1.0' };
		const legit = core.nodes.join(input);
		clock.now += 20_000; // the agent has not heartbeated yet
		expectUsedTokenRefused(input, legit, 'victim-ext');
	});

	test('reviewer proof, managed mode without an address: token, name and public key take nothing over', () => {
		const token = core.nodes.createJoinToken(admin, 'victim-nat').token;
		const input = { token, name: 'victim-nat', networkMode: 'yoal' as const, wireguardPublicKey: key('Q') };
		const legit = core.nodes.join(input);
		clock.now += 20_000;
		expectUsedTokenRefused(input, legit, 'victim-nat');
	});

	test('a node that already reported in: still the same 409', () => {
		const token = core.nodes.createJoinToken(admin, 'again-2').token;
		const input = { token, name: 'again-2', publicAddress: '10.9.0.2:8080' };
		const first = core.nodes.join(input);
		opened.sqlite.run('UPDATE nodes SET last_heartbeat_at = ? WHERE id = ?', [clock.now, first.nodeId]);
		expectUsedTokenRefused(input, first, 'again-2');
		// Any other name or key with that token is the same refusal.
		expectUsedTokenRefused({ ...input, name: 'other' }, first, 'again-2');
	});

	test('an unknown or expired unused token is still a 401', () => {
		expect(() => core.nodes.join({ token: 'x'.repeat(40), name: 'nobody' })).toThrow(UnauthorizedError);
		const token = core.nodes.createJoinToken(admin, 'late').token;
		clock.now += 2 * 60 * 60_000;
		expect(() => core.nodes.join({ token, name: 'late' })).toThrow(UnauthorizedError);
	});

	test('a different token cannot take over a key another node holds: 409, token left unused', () => {
		const first = core.nodes.join({
			token: core.nodes.createJoinToken(admin, 'keyed').token,
			name: 'keyed',
			networkMode: 'yoal',
			wireguardPublicKey: key('D'),
		});
		const other = core.nodes.createJoinToken(admin, 'keyed').token;
		const error = thrown(() => core.nodes.join({ token: other, name: 'keyed', networkMode: 'yoal', wireguardPublicKey: key('D') }));
		expect(error).toBeInstanceOf(ConflictError);
		expect((error as ConflictError).status).toBe(409);
		expect((error as Error).message).toContain('keyed');
		expect((error as Error).message).toContain(first.nodeId);
		expect(nodesWithKey(key('D'))).toEqual([{ id: first.nodeId }]);
		// The refused token was not consumed: with the node's own fresh key it still joins.
		const joined = core.nodes.join({ token: other, name: 'keyed-b', networkMode: 'yoal', wireguardPublicKey: key('E') });
		expect(joined.nodeId).not.toBe(first.nodeId);
	});
});
