import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	TOKEN_REFRESH_MARGIN_MS,
	execCredential,
	clusterDetails,
	formatPodLogLine,
	parseAgents,
	parseCidrs,
	parseNodeList,
	parseServers,
	type KubernetesClusterView,
	readCachedToken,
	tokenCachePath,
	usableCachedToken,
	writeCachedToken,
} from './kubernetes.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-k8s-cli-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('execCredential', () => {
	test('prints exactly the client.authentication.k8s.io/v1 ExecCredential', () => {
		const out = execCredential({ token: 'eyJ.abc.def', expiresAt: '2026-11-18T12:15:00.000Z' });
		expect(out).toBe(
			'{"apiVersion":"client.authentication.k8s.io/v1","kind":"ExecCredential","status":{"token":"eyJ.abc.def","expirationTimestamp":"2026-11-18T12:15:00.000Z"}}',
		);
		expect(out).not.toContain('\n');
	});

	test('ignores extra token fields such as groups and audience', () => {
		const parsed = JSON.parse(
			execCredential({ token: 't', expiresAt: 'x', audience: 'k8s:kc_1', groups: ['yoal:admins'] } as never),
		);
		expect(Object.keys(parsed.status)).toEqual(['token', 'expirationTimestamp']);
	});
});

describe('token cache', () => {
	const now = Date.parse('2026-11-18T12:00:00Z');
	const token = (expiresInMs: number) => ({
		token: 'tok',
		expiresAt: new Date(now + expiresInMs).toISOString(),
		audience: 'k8s:kc_1',
		groups: ['yoal:viewers'],
	});

	test('reuses a token until a minute before expiry', () => {
		expect(usableCachedToken(token(TOKEN_REFRESH_MARGIN_MS + 1_000), now)?.token).toBe('tok');
		expect(usableCachedToken(token(TOKEN_REFRESH_MARGIN_MS), now)).toBeNull();
		expect(usableCachedToken(token(-1), now)).toBeNull();
		expect(usableCachedToken({ token: 1 }, now)).toBeNull();
		expect(usableCachedToken(null, now)).toBeNull();
	});

	test('keys the file by profile, cluster and identity', () => {
		const a = tokenCachePath(dir, { url: 'https://a', credential: 'key1', cluster: 'lab', profile: 'prod' });
		const b = tokenCachePath(dir, { url: 'https://a', credential: 'key2', cluster: 'lab', profile: 'prod' });
		const c = tokenCachePath(dir, { url: 'https://a', credential: 'key1', cluster: 'other', profile: 'prod' });
		expect(a).not.toBe(b);
		expect(a).not.toBe(c);
		expect(a).toContain(join('k8s-tokens', 'prod--lab--'));
		expect(a).not.toContain('key1');
		expect(tokenCachePath(dir, { url: 'u', credential: 'k', cluster: 'lab' })).toContain('env--lab--');
	});

	test('writes the cache with mode 0600 and reads it back', async () => {
		const path = tokenCachePath(dir, { url: 'https://a', credential: 'key', cluster: 'lab', profile: 'p' });
		await writeCachedToken(path, token(10 * 60_000));
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700);
		expect((await readCachedToken(path, now))?.token).toBe('tok');
		expect(await readCachedToken(path, now + 10 * 60_000)).toBeNull();
		expect(await readCachedToken(join(dir, 'missing.json'), now)).toBeNull();
	});
});

describe('parsing', () => {
	test('agents are 0–8', () => {
		expect(parseAgents('0')).toBe(0);
		expect(parseAgents('8')).toBe(8);
		expect(() => parseAgents('9')).toThrow();
		expect(() => parseAgents('1.5')).toThrow();
	});

	test('cidrs split on commas, dedupe and clear with none', () => {
		expect(parseCidrs(['10.0.0.0/8,192.168.0.0/16', '10.0.0.0/8'])).toEqual(['10.0.0.0/8', '192.168.0.0/16']);
		expect(parseCidrs(['none'])).toEqual([]);
		expect(() => parseCidrs(['10.0.0.1'])).toThrow();
	});
});

describe('K5/K6', () => {
	test('servers are 1 or 3; nodes split and dedupe', () => {
		expect(parseServers('1')).toBe(1);
		expect(parseServers('3')).toBe(3);
		expect(() => parseServers('2')).toThrow();
		expect(parseNodeList(['a,b', 'b', ' c '])).toEqual(['a', 'b', 'c']);
		expect(() => parseNodeList([','])).toThrow();
	});

	test('get shows servers, datastore, backups and a rollout', () => {
		const cluster = {
			id: 'kc_1',
			name: 'prod',
			minor: '1.36',
			release: 'v1.36.6+k3s1',
			displayVersion: '1.36.6',
			upgradeTo: '1.37',
			endOfSupport: '2027-06-28',
			tier: 'userns',
			purpose: 'production',
			status: 'running',
			message: null,
			nodeId: 'n1',
			nodeName: 'w1',
			memoryMb: 2048,
			cpus: 1,
			agents: 0,
			apiAccess: 'public',
			allowCidrs: [],
			apiUrl: 'https://prod-org.k8s.example.com',
			window: { hour: 3, hours: 2 },
			autoPatch: true,
			traefik: true,
			servers: 3,
			datastore: 'etcd',
			multiNode: true,
			backup: { hours: 1, retentionDays: 7, nextAt: null, lastAt: '2026-11-18T10:00:00Z', lastStatus: 'ok' },
			upgrade: { from: '1.36', to: '1.37', startedAt: '2026-11-18T10:05:00Z', message: 'server-1 draining' },
			deprecatedApis: ['batch/v1beta1/cronjobs'],
			shipper: true,
			logRetentionDays: 7,
			restoring: false,
			machines: [
				{ id: 'km_1', role: 'server', ordinal: 0, nodeId: 'n1', nodeName: 'w1', status: 'running', restarts: 0, memoryMb: 2048, cpus: 1, release: 'v1.36.6+k3s1', overlayIp: '10.47.0.2' },
			],
			routes: [],
			attachments: [],
			nodesReady: 3,
			nodesTotal: 3,
			statsAt: null,
			createdAt: '2026-11-18T09:00:00Z',
			updatedAt: '2026-11-18T09:00:00Z',
			deletedAt: null,
			purgeAt: null,
		} as KubernetesClusterView;
		const text = clusterDetails(cluster);
		expect(text).toContain('3 servers + 0 agents');
		expect(text).toContain('etcd (highly available), spread across nodes');
		expect(text).toContain('Rollout in progress: 1.36 → 1.37');
		expect(text).toContain('batch/v1beta1/cronjobs');
		expect(text).toContain('10.47.0.2');
		expect(text).toContain('every 1 hour, kept 7 days');
	});

	test('pod log lines name namespace, pod and container', () => {
		expect(
			formatPodLogLine({ seq: 1, namespace: 'shop', pod: 'web-1', container: 'app', stream: 'stdout', message: 'ok', at: 't' }),
		).toBe('t shop/web-1[app] ok');
	});
});
