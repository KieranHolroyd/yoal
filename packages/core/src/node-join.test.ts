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
 * HA-PLAN Wave 1 F11: retrying a node join used to fail with an HTTP 500 (SQLite UNIQUE on
 * `nodes.wg_public_key`). A retry of the same join (same token, same key, a node that never
 * reported in) returns that node; any other reuse of a key is a 409 that says why.
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

describe('retrying a node join (F11)', () => {
	test('the same token and key return the same node with a fresh node token', () => {
		const token = core.nodes.createJoinToken(admin, 'retry-1').token;
		const input = { token, name: 'retry-1', networkMode: 'yoal' as const, wireguardPublicKey: key('C'), publicAddress: '198.51.100.1' };
		const first = core.nodes.join(input);
		// The response was lost; the installer runs the join again.
		const second = core.nodes.join(input);
		expect(second.nodeId).toBe(first.nodeId);
		expect(second.mode).toBe(first.mode);
		expect(second.wireguard?.address).toBe(first.wireguard?.address);
		expect(nodesWithKey(key('C'))).toEqual([{ id: first.nodeId }]);
		// Only the latest node token works: the first one was never delivered.
		expect(core.nodes.authenticate(second.token).id).toBe(first.nodeId);
		expect(() => core.nodes.authenticate(first.token)).toThrow(UnauthorizedError);
	});

	test('a different token cannot take over a key another node holds: 409, token left unused', () => {
		const first = core.nodes.join({
			token: core.nodes.createJoinToken(admin, 'retry-2').token,
			name: 'retry-2',
			networkMode: 'yoal',
			wireguardPublicKey: key('D'),
		});
		const other = core.nodes.createJoinToken(admin, 'retry-2').token;
		const error = thrown(() => core.nodes.join({ token: other, name: 'retry-2', networkMode: 'yoal', wireguardPublicKey: key('D') }));
		expect(error).toBeInstanceOf(ConflictError);
		expect((error as ConflictError).status).toBe(409);
		expect((error as Error).message).toContain('retry-2');
		expect((error as Error).message).toContain(first.nodeId);
		expect(nodesWithKey(key('D'))).toEqual([{ id: first.nodeId }]);
		// The refused token was not consumed: with the node's own fresh key it still joins.
		const joined = core.nodes.join({ token: other, name: 'retry-2b', networkMode: 'yoal', wireguardPublicKey: key('E') });
		expect(joined.nodeId).not.toBe(first.nodeId);
	});

	test('a node that already reported in is not handed out again', () => {
		const token = core.nodes.createJoinToken(admin, 'retry-3').token;
		const input = { token, name: 'retry-3', networkMode: 'yoal' as const, wireguardPublicKey: key('F') };
		const first = core.nodes.join(input);
		opened.sqlite.run('UPDATE nodes SET last_heartbeat_at = ? WHERE id = ?', [clock.now, first.nodeId]);
		expect(() => core.nodes.join(input)).toThrow(UnauthorizedError);
		expect(core.nodes.authenticate(first.token).id).toBe(first.nodeId);
	});

	test('the same token with another key or name is not a retry', () => {
		const token = core.nodes.createJoinToken(admin, 'retry-4').token;
		const first = core.nodes.join({ token, name: 'retry-4', networkMode: 'yoal', wireguardPublicKey: key('G') });
		expect(() => core.nodes.join({ token, name: 'retry-4', networkMode: 'yoal', wireguardPublicKey: key('H') })).toThrow(UnauthorizedError);
		expect(() => core.nodes.join({ token, name: 'other', networkMode: 'yoal', wireguardPublicKey: key('G') })).toThrow(UnauthorizedError);
		expect(nodesWithKey(key('H'))).toEqual([]);
		expect(core.nodes.authenticate(first.token).id).toBe(first.nodeId);
	});

	test('an expired token is never a retry', () => {
		const token = core.nodes.createJoinToken(admin, 'retry-5').token;
		const input = { token, name: 'retry-5', networkMode: 'yoal' as const, wireguardPublicKey: key('J') };
		core.nodes.join(input);
		clock.now += 86_400_000 * 30;
		expect(() => core.nodes.join(input)).toThrow(UnauthorizedError);
	});

	test('an external (bring-your-own network) join retries the same way', () => {
		const token = core.nodes.createJoinToken(admin, 'retry-6').token;
		const first = core.nodes.join({ token, name: 'retry-6', publicAddress: '10.9.0.6:8080', version: '0.15.3' });
		const second = core.nodes.join({ token, name: 'retry-6', publicAddress: '10.9.0.6:8080', version: '0.15.3' });
		expect(second.nodeId).toBe(first.nodeId);
		expect(second.wireguard).toBeUndefined();
	});

	describe('a replayed join token is not a credential for its node (F11 review)', () => {
		const managed = (name: string, letter: string, publicAddress = '198.51.100.7') => ({
			token: core.nodes.createJoinToken(admin, name).token,
			name,
			networkMode: 'yoal' as const,
			wireguardPublicKey: key(letter),
			publicAddress,
		});

		test('a replay after the 10-minute retry window is refused, inside the token\'s hour', () => {
			const input = managed('replay-1', 'K');
			const first = core.nodes.join(input);
			clock.now += 10 * 60_000 + 1;
			expect(() => core.nodes.join(input)).toThrow(UnauthorizedError);
			// The real node keeps its token and nothing new was issued.
			expect(core.nodes.authenticate(first.token).id).toBe(first.nodeId);
		});

		test('a retry from another address is refused, even with the same token, name and key', () => {
			const input = managed('replay-2', 'L');
			const first = core.nodes.join(input);
			expect(() => core.nodes.join({ ...input, publicAddress: '203.0.113.66' })).toThrow(UnauthorizedError);
			expect(() => core.nodes.join({ ...input, publicAddress: undefined })).toThrow(UnauthorizedError);
			expect(core.nodes.authenticate(first.token).id).toBe(first.nodeId);
		});

		test('inside the window with every field the same it is still a retry', () => {
			const input = managed('replay-3', 'M');
			const first = core.nodes.join(input);
			clock.now += 10 * 60_000;
			expect(core.nodes.join(input).nodeId).toBe(first.nodeId);
		});

		test('an external join with no address to bind it is never retried', () => {
			const token = core.nodes.createJoinToken(admin, 'replay-4').token;
			const first = core.nodes.join({ token, name: 'replay-4' });
			expect(() => core.nodes.join({ token, name: 'replay-4' })).toThrow(UnauthorizedError);
			expect(core.nodes.authenticate(first.token).id).toBe(first.nodeId);
		});

		test('an external retry needs every identifying field to match', () => {
			const token = core.nodes.createJoinToken(admin, 'replay-5').token;
			const input = { token, name: 'replay-5', publicAddress: '10.9.0.9:8080', version: '0.15.3' };
			const first = core.nodes.join(input);
			expect(() => core.nodes.join({ ...input, version: '0.15.4' })).toThrow(UnauthorizedError);
			expect(() => core.nodes.join({ ...input, publicAddress: '10.9.0.10:8080' })).toThrow(UnauthorizedError);
			expect(() => core.nodes.join({ ...input, networkMode: 'yoal', wireguardPublicKey: key('N') })).toThrow(UnauthorizedError);
			expect(core.nodes.authenticate(first.token).id).toBe(first.nodeId);
		});
	});
});
