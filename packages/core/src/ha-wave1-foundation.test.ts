import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { DEFAULT_FEATURES, desiredStateSchema, type DesiredState, type FeatureFlags } from '@yoal/contracts';
import {
	gateDesiredState,
	missingCapabilityMessage,
	nodeCapabilityList,
	nodeHasCapability,
	nodesMissingCapability,
	objectStoreKindAllowed,
} from './capability-gate.ts';
import { assertReleasePhaseSpec } from './release-phase-gate.ts';
<<<<<<< HEAD
=======
import { computeHaLevel } from './ha-level.ts';
import { judgeCanary } from './canary-judge.ts';
import { createAzureObjectStore, createGcsObjectStore, createObjectStore } from './object-store-factory.ts';
import { ReleaseCommandScheduler } from './release-commands.ts';
>>>>>>> ha/w1-b-attach-core
import { S3ObjectStore, LocalObjectStore, storageKindForDb } from './object-store.ts';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { ValidationError } from './errors.ts';

/** HA Wave 1 foundation PR (docs/build-plan/HA-WAVE-1.md): the capability gate, refusals and stubs. */

const CERT = '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUQ2VydGlmaWNhdGVGb3JUZXN0czAKBggqhkjOPQQDAjAA\n-----END CERTIFICATE-----\n';

const plain = desiredStateSchema.parse({
	version: 3,
	nodeId: 'nod_1',
	agentVersion: '0.15.3',
	generatedAt: '2026-11-20T10:00:00.000Z',
	contentDomain: 'sites.test',
	releases: [],
	routes: [
		{
			projectId: 'prj_1',
			slug: 'app',
			host: 'app.sites.test',
			deploymentId: 'dep_1',
			release: 'a'.repeat(64),
			access: { mode: 'public', siteKey: 'k'.repeat(32), loginUrl: 'https://control.test/login' },
			accessMode: 'public',
			spa: false,
			cleanUrls: false,
			trailingSlash: 'ignore',
			notFound: null,
			healthPath: '/healthz',
		},
	],
	workloads: [
		{
			id: 'wl_1',
			projectId: 'prj_1',
			projectSlug: 'app',
			deploymentId: 'dep_1',
			runtime: 'container',
			status: 'running',
			release: null,
			image: 'docker.io/library/nginx:1.27',
			upstream: '127.0.0.1:20001',
			memoryMb: 256,
			cpus: 1,
			port: 8080,
			healthPath: '/',
			socketActivation: false,
			activationVersion: 'b'.repeat(64),
		},
	],
	serviceEndpoints: [
		{ id: 'sep_1', kind: 'database', serviceId: 'db_1', localPort: 21_000, upstream: { nodeId: 'nod_2', address: '10.47.1.3', port: 15432 } },
	],
	serviceProviders: [{ id: 'svp_1', listenAddress: '10.47.1.2', listenPort: 15432, targetPort: 15432 }],
});

function withWave1(state: DesiredState): DesiredState {
	return {
		...state,
		routes: state.routes.map((route) => ({ ...route, readinessPath: '/ready' })),
		workloads: state.workloads.map((workload) => ({
			...workload,
			readinessPath: '/ready',
			drainSeconds: 10,
			stopTimeoutSeconds: 45,
			addHosts: [{ host: 'db-db_1', address: '10.89.0.1' }],
		})),
		serviceEndpoints: [
			...state.serviceEndpoints.map((endpoint) => ({
				...endpoint,
				role: 'primary' as const,
				gatewayAddress: '10.89.0.1',
				trust: 'install-ca' as const,
				version: 2,
			})),
			// A pooled endpoint exists only under the gateway; without it, it must be dropped, not
			// turned into a primary forwarder.
			...state.serviceEndpoints.slice(0, 1).map((endpoint) => ({
				...endpoint,
				id: `${endpoint.id}_pool`,
				localPort: endpoint.localPort + 1,
				role: 'pool' as const,
				gatewayAddress: '10.89.0.1',
				trust: 'install-ca' as const,
				version: 2,
			})),
		],
		serviceProviders: state.serviceProviders.map((provider) => ({ ...provider, clientAuth: 'install-ca' as const, allowedClientNodeIds: ['nod_1'] })),
		readEndpoints: [
			{
				id: 'rep_1',
				kind: 'database',
				serviceId: 'db_1',
				role: 'read',
				localPort: 23_000,
				upstreams: [{ nodeId: 'nod_3', address: '10.47.1.4', port: 15433, trust: 'install-ca', tlsFingerprint: null }],
				version: 0,
			},
		],
		nodeTrust: { generation: 1, caBundlePem: CERT, certificatePem: null, serial: null, notAfter: null, revokedSerials: [] },
		releaseCommands: [
			{
				runId: `rc_${'c'.repeat(32)}`,
				releaseId: 'dep_2',
				workloadId: 'wl_1',
				release: null,
				command: ['bin/migrate'],
				timeoutSeconds: 600,
				attempt: 1,
				startBy: '2026-11-20T10:05:00Z',
			},
		],
	};
}

const flagsOn = { ENDPOINTS_GATEWAY: true, RELEASE_PHASE: true };
const flagsOff = { ENDPOINTS_GATEWAY: false, RELEASE_PHASE: false };
const both = ['endpoints-gateway', 'release-phase'];

describe('capability gate: flags (reviewer item 4)', () => {
	test('flags off: a capable node gets none of the new fields (stale or leftover values)', () => {
		const gated = gateDesiredState(withWave1(plain), both, flagsOff);
		expect(JSON.stringify(gated)).toBe(JSON.stringify(plain));
	});

	test('each flag gates its own group even on a capable node', () => {
		const gatewayOnly = gateDesiredState(withWave1(plain), both, { ENDPOINTS_GATEWAY: true, RELEASE_PHASE: false });
		expect(gatewayOnly.nodeTrust).toBeDefined();
		expect('releaseCommands' in gatewayOnly).toBe(false);
		const releaseOnly = gateDesiredState(withWave1(plain), both, { ENDPOINTS_GATEWAY: false, RELEASE_PHASE: true });
		expect(releaseOnly.releaseCommands).toHaveLength(1);
		expect('nodeTrust' in releaseOnly).toBe(false);
	});
});

describe('capability gate (HA-PLAN §9 "Mixed versions")', () => {
	test('a state with no Wave 1 fields comes back as the same object, for any node', () => {
		for (const capabilities of [[], ['endpoints-gateway'], ['release-phase'], ['endpoints-gateway', 'release-phase']])
			for (const flags of [flagsOn, flagsOff]) expect(gateDesiredState(plain, capabilities, flags)).toBe(plain);
	});

	test('an agent without either capability gets today\'s document, byte for byte', () => {
		const gated = gateDesiredState(withWave1(plain), ['studio-principal', 'node-update'], flagsOn);
		expect(JSON.stringify(gated)).toBe(JSON.stringify(plain));
		// And what it receives still parses with today's schema.
		expect(desiredStateSchema.parse(gated)).toEqual(plain);
	});

	test('endpoints-gateway alone keeps the H24 fields and strips the H25 ones', () => {
		const gated = gateDesiredState(withWave1(plain), ['endpoints-gateway'], flagsOn);
		expect(gated.readEndpoints).toHaveLength(1);
		expect(gated.nodeTrust?.generation).toBe(1);
		expect(gated.serviceEndpoints[0]).toMatchObject({ role: 'primary', gatewayAddress: '10.89.0.1', trust: 'install-ca', version: 2 });
		expect(gated.serviceEndpoints.at(-1)).toMatchObject({ role: 'pool' });
		expect(gated.serviceEndpoints).toHaveLength(plain.serviceEndpoints.length + 1);
		expect(gated.serviceProviders[0]).toMatchObject({ clientAuth: 'install-ca', allowedClientNodeIds: ['nod_1'] });
		expect(gated.workloads[0]!.addHosts).toHaveLength(1);
		expect('releaseCommands' in gated).toBe(false);
		expect('readinessPath' in gated.routes[0]!).toBe(false);
		for (const key of ['readinessPath', 'drainSeconds', 'stopTimeoutSeconds']) expect(key in gated.workloads[0]!).toBe(false);
	});

	test('release-phase alone keeps the H25 fields and strips the H24 ones', () => {
		const gated = gateDesiredState(withWave1(plain), ['release-phase'], flagsOn);
		expect(gated.releaseCommands).toHaveLength(1);
		expect(gated.routes[0]!.readinessPath).toBe('/ready');
		expect(gated.workloads[0]).toMatchObject({ readinessPath: '/ready', drainSeconds: 10, stopTimeoutSeconds: 45 });
		expect('addHosts' in gated.workloads[0]!).toBe(false);
		expect('readEndpoints' in gated).toBe(false);
		expect('nodeTrust' in gated).toBe(false);
		expect(gated.serviceEndpoints).toEqual(plain.serviceEndpoints);
		expect(gated.serviceProviders[0]).toEqual(plain.serviceProviders[0]!);
	});

	test('both capabilities: nothing is removed', () => {
		const full = withWave1(plain);
		expect(gateDesiredState(full, ['release-phase', 'endpoints-gateway'], flagsOn)).toBe(full);
	});

	test('reads stored capabilities and names the nodes that lack one', () => {
		expect(nodeCapabilityList(null)).toEqual([]);
		expect(nodeCapabilityList('not json')).toEqual([]);
		expect(nodeCapabilityList('["release-phase",3]')).toEqual(['release-phase']);
		const nodes = [
			{ id: 'nod_a', name: 'node-a', capabilitiesJson: '["release-phase","endpoints-gateway"]' },
			{ id: 'nod_b', name: 'node-b', capabilitiesJson: '["release-phase"]' },
			{ id: 'nod_c', name: 'node-c', capabilitiesJson: null },
		];
		expect(nodeHasCapability(nodes[0]!, 'endpoints-gateway')).toBe(true);
		const missing = nodesMissingCapability(nodes, 'endpoints-gateway');
		expect(missing.map((node) => node.name)).toEqual(['node-b', 'node-c']);
		expect(missingCapabilityMessage('ENDPOINTS_GATEWAY', 'endpoints-gateway', missing)).toBe(
			'ENDPOINTS_GATEWAY needs every involved node to run an agent with "endpoints-gateway"; update node-b, node-c first.',
		);
		expect(missingCapabilityMessage('X', 'y', [])).toBeNull();
		expect(objectStoreKindAllowed([], 's3')).toBe(true);
		expect(objectStoreKindAllowed([], 'azure')).toBe(false);
		expect(objectStoreKindAllowed(['object-store-kinds'], 'gcs')).toBe(true);
	});
});

describe('release phase refusals (H25)', () => {
	const off = { features: { ...DEFAULT_FEATURES } satisfies FeatureFlags };
	const on = { features: { ...DEFAULT_FEATURES, RELEASE_PHASE: true } satisfies FeatureFlags };

	test('every release-phase field is refused while RELEASE_PHASE is off', () => {
		const fields = {
			release: { command: ['bin/migrate'], timeoutSeconds: 600 },
			readinessPath: '/ready',
			drainSeconds: 10,
			stopTimeoutSeconds: 30,
			rollout: { canary: 1, soakSeconds: 60, maxUnavailable: 0 },
			placement: { spread: 'zone' as const },
		};
		for (const [field, value] of Object.entries(fields)) {
			expect(() => assertReleasePhaseSpec(off, { [field]: value })).toThrow(ValidationError);
			expect(() => assertReleasePhaseSpec(off, { [field]: value })).toThrow(`${field} needs the release phase`);
			expect(() => assertReleasePhaseSpec(on, { [field]: value })).not.toThrow();
		}
		expect(() => assertReleasePhaseSpec(off, { runtime: 'process', port: 3000 })).not.toThrow();
	});
});

describe('backup targets refuse azure and gcs while their flags are off (W3)', () => {
	const dir = mkdtempSync(join(tmpdir(), 'yoal-w1-foundation-'));
	const opened = createDb({ path: ':memory:' });
	const make = (features: Partial<FeatureFlags>): Core =>
		createCore({
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
				features: { ...DEFAULT_FEATURES, ...features },
			},
		});
	const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
	afterAll(() => {
		opened.sqlite.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const azure = { name: 'az-main', kind: 'azure', account: 'acct1', container: 'yoal', accountKey: 'k'.repeat(20) };
	const gcs = { name: 'gcs-main', kind: 'gcs', bucket: 'yoal-ha', serviceAccountJson: JSON.stringify({ client_email: 'a@b', private_key: 'k' }) };

	test('flags off: a clear refusal, and no row is written', () => {
		const core = make({});
		expect(() => core.backupTargets.create(owner, azure)).toThrow('YOAL_FEATURE_OBJECT_STORE_AZURE');
		expect(() => core.backupTargets.create(owner, gcs)).toThrow('YOAL_FEATURE_OBJECT_STORE_GCS');
		expect(opened.sqlite.query('SELECT COUNT(*) AS n FROM backup_targets').get()).toEqual({ n: 0 });
	});

	test('flags on: the target is stored as store_kind azure or gcs, credentials sealed once', () => {
		const core = make({ OBJECT_STORE_AZURE: true, OBJECT_STORE_GCS: true });
		const createdAzure = core.backupTargets.create(owner, azure);
		expect(createdAzure.target).toMatchObject({ kind: 'azure', hasCredentials: true, endpoint: null, bucket: null });
		expect(createdAzure.target.store).toMatchObject({ kind: 'azure', account: 'acct1', container: 'yoal' });
		const createdGcs = core.backupTargets.create(owner, gcs);
		expect(createdGcs.target.store).toMatchObject({ kind: 'gcs', bucket: 'yoal-ha' });
		const rows = opened.sqlite
			.query<{ store_kind: string; store_options_json: string; access_key_sealed: string | null; bucket: string | null }, []>(
				"SELECT store_kind, store_options_json, access_key_sealed, bucket FROM backup_targets WHERE name IN ('az-main','gcs-main') ORDER BY name",
			)
			.all();
		expect(rows.map((row) => row.store_kind).sort()).toEqual(['azure', 'gcs']);
		for (const row of rows) expect(row).toMatchObject({ access_key_sealed: null, bucket: null });
	});

	test('an s3 target is created as before and stored as store kind s3', () => {
		const core = make({});
		core.backupTargets.create(owner, { name: 'minio', kind: 's3', endpoint: 'https://minio.test', bucket: 'b-1', accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret-1234' });
		const row = opened.sqlite.query<{ kind: string; store_kind: string | null; store_options_json: string }, []>(
			"SELECT kind, store_kind, store_options_json FROM backup_targets WHERE name = 'minio'",
		).get();
		expect(row).toEqual({ kind: 's3', store_kind: 's3', store_options_json: '{}' });
	});
});
