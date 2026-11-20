import { describe, expect, test } from 'bun:test';
import {
	DEFAULT_DRAIN_SECONDS,
	DEFAULT_FEATURES,
	DEFAULT_STOP_TIMEOUT_SECONDS,
	ENDPOINTS_GATEWAY_CAPABILITY,
	OBJECT_STORE_KINDS_CAPABILITY,
	RELEASE_PHASE_CAPABILITY,
	RELEASE_PHASE_SPEC_FIELDS,
	backupTargetCreateSchema,
	backupTargetViewSchema,
	containerAddHostSchema,
	databaseHostAlias,
	databasePitrRepoConfigSchema,
	databasePitrRepoViewSchema,
	desiredStateSchema,
	endpointPortRangeFor,
	haLevels,
	haWave1Capabilities,
	heartbeatSchema,
	jobRunTriggers,
	nodeCapabilities,
	nodeJoinSchema,
	nodeTrustDesiredSchema,
	objectStoreCredentialsSchema,
	objectStoreKindIssue,
	objectStoreTargetSchema,
	parsePlatformObjectStoreKind,
	parseStoredObjectStoreTarget,
	pemCertificateBundleSchema,
	pemCsrSchema,
	readEndpointSchema,
	releaseCommandSpecSchema,
	releaseCommandTaskSchema,
	releasePhaseSpecIssues,
	resolvedStopSettings,
	routeSpecSchema,
	serviceEndpointSchema,
	serviceProviderSchema,
	workloadDesiredSchema,
	workloadSpecSchema,
} from './index.ts';

/**
 * HA Wave 1 foundation (docs/build-plan/HA-WAVE-1.md): every new contract parses old data
 * unchanged, and every new field is refused while its flag is off.
 */

const CERT = '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUQ2VydGlmaWNhdGVGb3JUZXN0czAKBggqhkjOPQQDAjAA\n-----END CERTIFICATE-----\n';
const CSR = '-----BEGIN CERTIFICATE REQUEST-----\nMIIBDjCBtQIBADATMREwDwYDVQQDDAhub2RfdGVzdDBZMBMGByqGSM49AgEGCCqG\n-----END CERTIFICATE REQUEST-----\n';
const KEY = '-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg\n-----END PRIVATE KEY-----\n';

const oldProcessSpec = {
	runtime: 'process',
	command: ['bun', 'run', 'start'],
	port: 3000,
	memoryMb: 256,
	cpus: 1,
	healthPath: '/healthz',
	socketActivation: true,
	env: { MODE: 'prod' },
	secrets: [],
	ingress: 'http',
	replicas: 2,
};

const oldWorkloadDesired = {
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
	activationVersion: 'a'.repeat(64),
	env: {},
	secrets: [],
	dataSizeMb: null,
};

const oldEndpoint = {
	id: 'sep_1',
	kind: 'database',
	serviceId: 'db_1',
	localPort: 21_000,
	upstream: { nodeId: 'nod_2', address: '10.47.1.3', port: 15432 },
	tlsFingerprint: 'f'.repeat(64),
};

const minimalDesired = {
	version: 7,
	nodeId: 'nod_1',
	agentVersion: '0.15.3',
	generatedAt: '2026-11-20T10:00:00.000Z',
	contentDomain: 'sites.test',
	releases: [],
	routes: [],
	workloads: [oldWorkloadDesired],
	serviceEndpoints: [oldEndpoint],
};

describe('flags and capabilities', () => {
	test('the Wave 1 flags are off by default', () => {
		for (const flag of ['ENDPOINTS_GATEWAY', 'RELEASE_PHASE', 'OBJECT_STORE_AZURE', 'OBJECT_STORE_GCS'] as const)
			expect(DEFAULT_FEATURES[flag]).toBe(false);
	});

	test('capability strings are declared but no agent build advertises them yet', () => {
		expect([...haWave1Capabilities]).toEqual([ENDPOINTS_GATEWAY_CAPABILITY, RELEASE_PHASE_CAPABILITY, OBJECT_STORE_KINDS_CAPABILITY]);
		expect(ENDPOINTS_GATEWAY_CAPABILITY).toBe('endpoints-gateway');
		expect(RELEASE_PHASE_CAPABILITY).toBe('release-phase');
		for (const capability of haWave1Capabilities) expect((nodeCapabilities as readonly string[]).includes(capability)).toBe(false);
		// The heartbeat caps capabilities at 32; the static list plus the dynamic ones and these three fit.
		expect(nodeCapabilities.length + 5 + haWave1Capabilities.length).toBeLessThanOrEqual(32);
	});

	test('HA levels are the CLUSTERING §8.1 ladder', () => {
		expect([...haLevels]).toEqual(['L0', 'L1', 'L2', 'L3']);
	});
});

describe('workload spec (H25)', () => {
	test('a spec saved before Wave 1 parses to exactly what it did, with no new keys', () => {
		const parsed = workloadSpecSchema.parse(oldProcessSpec);
		for (const field of RELEASE_PHASE_SPEC_FIELDS) expect(field in parsed).toBe(false);
		expect(Object.keys(parsed).sort()).toEqual(Object.keys(oldProcessSpec).sort());
		expect(resolvedStopSettings(parsed)).toEqual({ drainSeconds: 10, stopTimeoutSeconds: 30 });
		expect(DEFAULT_DRAIN_SECONDS).toBe(10);
		expect(DEFAULT_STOP_TIMEOUT_SECONDS).toBe(30);
	});

	test('accepts the release-phase fields', () => {
		const parsed = workloadSpecSchema.parse({
			...oldProcessSpec,
			release: { command: ['bun', 'run', 'migrate'] },
			readinessPath: '/ready',
			drainSeconds: 15,
			stopTimeoutSeconds: 45,
			rollout: { canary: 1, soakSeconds: 120 },
			placement: { spread: 'zone' },
		});
		expect(parsed.release).toEqual({ command: ['bun', 'run', 'migrate'], timeoutSeconds: 600 });
		// No maxUnavailable given: none is invented (reviewer item 5); absent means today's path.
		expect(parsed.rollout).toEqual({ canary: 1, soakSeconds: 120 });
		expect(parsed.placement).toEqual({ spread: 'zone' });
	});

	test('a release command is argv, never a shell string', () => {
		expect(releaseCommandSpecSchema.safeParse({ command: 'bun run migrate && rm -rf /' }).success).toBe(false);
		expect(releaseCommandSpecSchema.safeParse({ command: ['sh', 'line\nbreak'] }).success).toBe(false);
		expect(releaseCommandSpecSchema.safeParse({ command: [] }).success).toBe(false);
		expect(releaseCommandSpecSchema.safeParse({ command: ['bun', 'migrate'], shell: true }).success).toBe(false);
	});

	test('a readiness path needs HTTP ingress', () => {
		const worker = workloadSpecSchema.safeParse({ runtime: 'container', image: 'nginx', ingress: 'none', readinessPath: '/ready' });
		expect(worker.success).toBe(false);
		expect(worker.error?.issues.some((issue) => issue.path[0] === 'readinessPath')).toBe(true);
	});

	test('each new field is refused while RELEASE_PHASE is off, and allowed when it is on', () => {
		const spec = {
			release: { command: ['x'], timeoutSeconds: 60 },
			readinessPath: '/ready',
			drainSeconds: 5,
			stopTimeoutSeconds: 30,
			rollout: { canary: 1, soakSeconds: 60, maxUnavailable: 0 },
			placement: { spread: 'node' as const },
		};
		const off = releasePhaseSpecIssues(spec, { RELEASE_PHASE: false });
		expect(off.map((issue) => issue.path)).toEqual([...RELEASE_PHASE_SPEC_FIELDS]);
		for (const issue of off) expect(issue.message).toContain('YOAL_FEATURE_RELEASE_PHASE');
		for (const field of RELEASE_PHASE_SPEC_FIELDS)
			expect(releasePhaseSpecIssues({ [field]: spec[field] }, { RELEASE_PHASE: false }).map((issue) => issue.path)).toEqual([field]);
		expect(releasePhaseSpecIssues(spec, { RELEASE_PHASE: true })).toEqual([]);
		expect(releasePhaseSpecIssues(workloadSpecSchema.parse(oldProcessSpec), { RELEASE_PHASE: false })).toEqual([]);
	});

	test('jobs gain the release trigger', () => {
		expect([...jobRunTriggers]).toEqual(['schedule', 'manual', 'retry', 'release']);
	});
});

describe('desired state', () => {
	test('a document from today parses with no Wave 1 key added', () => {
		const parsed = desiredStateSchema.parse(minimalDesired);
		for (const key of ['readEndpoints', 'nodeTrust', 'releaseCommands']) expect(key in parsed).toBe(false);
		const workload = parsed.workloads[0]!;
		for (const key of ['readinessPath', 'drainSeconds', 'stopTimeoutSeconds', 'addHosts']) expect(key in workload).toBe(false);
		const endpoint = parsed.serviceEndpoints[0]!;
		for (const key of ['role', 'gatewayAddress', 'trust', 'version']) expect(key in endpoint).toBe(false);
		expect(workloadDesiredSchema.parse(oldWorkloadDesired)).toEqual(workloadDesiredSchema.parse(oldWorkloadDesired));
	});

	test('carries the H24 and H25 fields', () => {
		const parsed = desiredStateSchema.parse({
			...minimalDesired,
			workloads: [
				{
					...oldWorkloadDesired,
					readinessPath: '/ready',
					drainSeconds: 10,
					stopTimeoutSeconds: 45,
					addHosts: [{ host: databaseHostAlias('db_1'), address: '10.89.0.1' }],
				},
			],
			serviceEndpoints: [{ ...oldEndpoint, role: 'pool', gatewayAddress: '10.89.0.1', trust: 'install-ca', version: 3 }],
			readEndpoints: [
				{
					id: 'rep_1',
					kind: 'database',
					serviceId: 'db_1',
					role: 'read',
					localPort: 23_000,
					upstreams: [{ nodeId: 'nod_3', address: '10.47.1.4', port: 15433 }],
				},
			],
			nodeTrust: { generation: 1, caBundlePem: CERT, certificatePem: CERT, serial: 'ab12', notAfter: '2027-02-18T00:00:00Z' },
			releaseCommands: [
				{
					runId: `rc_${'a'.repeat(32)}`,
					releaseId: 'dep_2',
					workloadId: 'wl_1',
					release: null,
					image: 'docker.io/library/app@sha256:' + 'b'.repeat(64),
					command: ['bin/migrate'],
					timeoutSeconds: 600,
					attempt: 1,
					startBy: '2026-11-20T10:05:00Z',
				},
			],
		});
		expect(parsed.workloads[0]!.addHosts).toEqual([{ host: 'db-db_1', address: '10.89.0.1' }]);
		expect(parsed.readEndpoints?.[0]?.trust).toBe('install-ca');
		expect(parsed.nodeTrust?.revokedSerials).toEqual([]);
		expect(routeSpecSchema.shape.readinessPath).toBeDefined();
	});

	test('read endpoints use 23000–23999 and stay out of serviceEndpoints', () => {
		expect(endpointPortRangeFor('read')).toEqual({ min: 23_000, max: 23_999 });
		expect(endpointPortRangeFor('pool')).toEqual({ min: 21_000, max: 21_999 });
		expect(serviceEndpointSchema.safeParse({ ...oldEndpoint, role: 'read' }).success).toBe(false);
		expect(serviceEndpointSchema.safeParse({ ...oldEndpoint, localPort: 23_000 }).success).toBe(false);
		const read = { id: 'r', kind: 'database', serviceId: 'db_1', role: 'read-pool', upstreams: [{ nodeId: 'n', port: 1 }] };
		expect(readEndpointSchema.safeParse({ ...read, localPort: 21_000 }).success).toBe(false);
		expect(readEndpointSchema.safeParse({ ...read, localPort: 23_999 }).success).toBe(true);
	});

	test('AddHost entries are validated fields, not a Quadlet line', () => {
		expect(containerAddHostSchema.safeParse({ host: 'db-db_1', address: '10.89.0.1' }).success).toBe(true);
		expect(containerAddHostSchema.safeParse({ host: 'db-1:10.0.0.1\nExec=/bin/sh', address: '10.89.0.1' }).success).toBe(false);
		expect(containerAddHostSchema.safeParse({ host: 'db-1', address: '10.89.0.1 evil' }).success).toBe(false);
		expect(containerAddHostSchema.safeParse({ host: 'db.example.com', address: '10.89.0.1' }).success).toBe(false);
	});

	test('a provider without the Wave 1 fields parses unchanged', () => {
		const provider = { id: 'svp_1', listenAddress: '10.47.1.3', listenPort: 15432, targetPort: 15432, allowedClientFingerprints: [] };
		expect(serviceProviderSchema.parse(provider)).toEqual(provider);
	});

	test('release-command tasks need an rc_ run id and an argv command', () => {
		const task = {
			runId: `rc_${'a'.repeat(32)}`,
			releaseId: 'dep_2',
			workloadId: 'wl_1',
			release: 'c'.repeat(64),
			command: ['bin/migrate'],
			timeoutSeconds: 600,
			attempt: 1,
			startBy: '2026-11-20T10:05:00Z',
		};
		expect(releaseCommandTaskSchema.safeParse(task).success).toBe(true);
		expect(releaseCommandTaskSchema.safeParse({ ...task, runId: 'jr_1' }).success).toBe(false);
		expect(releaseCommandTaskSchema.safeParse({ ...task, command: 'bin/migrate' }).success).toBe(false);
	});
});

describe('per-install CA (H24 "Trust")', () => {
	test('desired state carries public material only', () => {
		expect(nodeTrustDesiredSchema.safeParse({ generation: 1, caBundlePem: CERT + KEY }).success).toBe(false);
		expect(nodeTrustDesiredSchema.safeParse({ generation: 1, caBundlePem: CERT, certificatePem: KEY }).success).toBe(false);
		expect(nodeTrustDesiredSchema.safeParse({ generation: 1, caBundlePem: CERT + CERT }).success).toBe(true);
		expect(pemCertificateBundleSchema.safeParse(CERT + CERT + CERT + CERT).success).toBe(false);
		expect(pemCertificateBundleSchema.safeParse(`${CERT}junk`).success).toBe(false);
	});

	test('a CSR is a CSR, never a key', () => {
		expect(pemCsrSchema.safeParse(CSR).success).toBe(true);
		expect(pemCsrSchema.safeParse(KEY).success).toBe(false);
		expect(pemCsrSchema.safeParse(CSR + KEY).success).toBe(false);
	});

	test('enrolment and heartbeat take a CSR; older payloads parse without one', () => {
		const join = { token: 't'.repeat(24), name: 'node-a' };
		expect('csrPem' in nodeJoinSchema.parse(join)).toBe(false);
		expect(nodeJoinSchema.parse({ ...join, csrPem: CSR }).csrPem).toBe(CSR);
		const beat = { nodeId: 'nod_1', agentVersion: '0.15.3', actualStateVersion: 1, status: 'online', caddyOk: true };
		const parsed = heartbeatSchema.parse(beat);
		expect('nodeCsr' in parsed).toBe(false);
		expect('releaseCommandResults' in parsed).toBe(false);
		expect(heartbeatSchema.parse({ ...beat, nodeCsr: { csrPem: CSR, reason: 'enrol' } }).nodeCsr?.reason).toBe('enrol');
		expect(heartbeatSchema.safeParse({ ...beat, nodeCsr: { csrPem: KEY, reason: 'enrol' } }).success).toBe(false);
	});
});

describe('object-store targets (W3, G17)', () => {
	test('a stored config without a kind parses as s3 with today\'s behaviour', () => {
		expect(
			parseStoredObjectStoreTarget({
				endpoint: 'https://acc.r2.cloudflarestorage.com',
				bucket: 'yoal-backups',
				pathPrefix: 'yoal/backups',
				forcePathStyle: true,
				objectLock: false,
			}),
		).toEqual({
			kind: 's3',
			endpoint: 'https://acc.r2.cloudflarestorage.com',
			region: 'auto',
			bucket: 'yoal-backups',
			pathPrefix: 'yoal/backups',
			pathStyle: true,
			immutability: null,
		});
		const withRegion = parseStoredObjectStoreTarget({ bucket: 'b-1', region: 'eu-west-1', objectLock: true });
		expect(withRegion).toMatchObject({ kind: 's3', region: 'eu-west-1', endpoint: null, immutability: { retentionDays: null } });
	});

	test('azure and gcs targets parse; credentials never ride on a target', () => {
		const azure = objectStoreTargetSchema.parse({
			kind: 'azure',
			account: 'devstoreaccount1',
			container: 'yoal',
			endpoint: 'http://127.0.0.1:10000/devstoreaccount1',
			accountKey: 'should-be-dropped',
		});
		expect(azure).toEqual({
			kind: 'azure',
			account: 'devstoreaccount1',
			container: 'yoal',
			endpoint: 'http://127.0.0.1:10000/devstoreaccount1',
			pathPrefix: '',
			immutability: null,
		});
		expect(objectStoreTargetSchema.parse({ kind: 'gcs', bucket: 'yoal-ha', immutability: { retentionDays: 30 } })).toMatchObject({
			kind: 'gcs',
			endpoint: null,
			immutability: { retentionDays: 30 },
		});
		expect(objectStoreTargetSchema.safeParse({ kind: 'gcs', bucket: 'googlebucket' }).success).toBe(false);
		expect(objectStoreTargetSchema.safeParse({ kind: 's3', bucket: 'b-1', endpoint: 'https://u:p@host' }).success).toBe(false);
	});

	test('credentials: one Azure secret, a real service-account file', () => {
		expect(objectStoreCredentialsSchema.safeParse({ kind: 'azure', accountKey: 'k'.repeat(20), sasToken: 's'.repeat(20) }).success).toBe(false);
		expect(objectStoreCredentialsSchema.safeParse({ kind: 'azure', sasToken: 's'.repeat(20) }).success).toBe(true);
		expect(objectStoreCredentialsSchema.safeParse({ kind: 'gcs', serviceAccountJson: '{"client_email":"a@b"}' }).success).toBe(false);
		expect(
			objectStoreCredentialsSchema.safeParse({ kind: 'gcs', serviceAccountJson: JSON.stringify({ client_email: 'a@b.iam', private_key: 'k' }) }).success,
		).toBe(true);
	});

	test('azure and gcs are refused while their flags are off', () => {
		const off = { OBJECT_STORE_AZURE: false, OBJECT_STORE_GCS: false };
		expect(objectStoreKindIssue('s3', off)).toBeNull();
		expect(objectStoreKindIssue('azure', off)).toContain('YOAL_FEATURE_OBJECT_STORE_AZURE');
		expect(objectStoreKindIssue('gcs', off)).toContain('YOAL_FEATURE_OBJECT_STORE_GCS');
		expect(objectStoreKindIssue('azure', { ...off, OBJECT_STORE_AZURE: true })).toBeNull();
		expect(objectStoreKindIssue('gcs', { ...off, OBJECT_STORE_GCS: true })).toBeNull();
	});

	test('backup targets: today\'s views and creates parse unchanged; azure and gcs create shapes exist', () => {
		const view = {
			id: 'bt_1',
			orgId: null,
			name: 'r2-main',
			kind: 's3',
			path: null,
			endpoint: 'https://acc.r2.cloudflarestorage.com',
			bucket: 'yoal-backups',
			region: 'auto',
			pathPrefix: 'yoal/backups',
			forcePathStyle: true,
			writeOnly: false,
			objectLock: false,
			hasCredentials: true,
			status: 'ok',
			lastCheckedAt: null,
			lastError: null,
			lastTest: null,
			createdAt: '2026-11-01T00:00:00Z',
			updatedAt: '2026-11-01T00:00:00Z',
		};
		expect(backupTargetViewSchema.parse(view)).toEqual(view as never);
		const s3 = backupTargetCreateSchema.parse({ name: 'r2-main', kind: 's3', bucket: 'yoal-backups', accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret-value' });
		expect(s3).toMatchObject({ kind: 's3', region: 'us-east-1', forcePathStyle: true, objectLock: false });
		expect(
			backupTargetCreateSchema.safeParse({ name: 'az-main', kind: 'azure', account: 'acct1', container: 'yoal', accountKey: 'k'.repeat(20) }).success,
		).toBe(true);
		expect(backupTargetCreateSchema.safeParse({ name: 'az-main', kind: 'azure', account: 'acct1', container: 'yoal' }).success).toBe(false);
		expect(backupTargetCreateSchema.safeParse({ name: 'gcs-main', kind: 'gcs', bucket: 'yoal-ha', serviceAccountJson: '{"x":1}'.padEnd(30) }).success).toBe(true);
	});

	test('PITR repositories stored before W3 parse unchanged', () => {
		const repo = { kind: 's3', endpoint: null, bucket: 'pitr', region: 'us-east-1', pathPrefix: 'pg', forcePathStyle: true };
		expect(databasePitrRepoViewSchema.parse(repo)).toEqual(repo as never);
		expect('storeCredentials' in databasePitrRepoConfigSchema.parse({ ...repo, accessKeyId: 'AKIA', secretAccessKey: 'secret-1234' })).toBe(false);
	});

	test('the platform store kind keeps local and r2', () => {
		expect(parsePlatformObjectStoreKind(undefined)).toBe('local');
		expect(parsePlatformObjectStoreKind('r2')).toBe('r2');
		expect(parsePlatformObjectStoreKind('azure')).toBe('azure');
		expect(parsePlatformObjectStoreKind('ftp')).toBeNull();
	});
});

describe('rollout defaults are today\'s behaviour (reviewer item 5)', () => {
	test('an empty rollout invents no maxUnavailable, and there is no DEFAULT_ROLLOUT', async () => {
		const contracts = (await import('./index.ts')) as Record<string, unknown>;
		expect('DEFAULT_ROLLOUT' in contracts).toBe(false);
		const parsed = workloadSpecSchema.parse({ ...oldProcessSpec, rollout: {} });
		expect(parsed.rollout).toEqual({ canary: 0, soakSeconds: 0 });
		expect('maxUnavailable' in parsed.rollout!).toBe(false);
	});

	test('a canary needs a soak', () => {
		expect(workloadSpecSchema.safeParse({ ...oldProcessSpec, rollout: { canary: 1 } }).success).toBe(false);
	});
});

describe('spread precedence: app over project over cluster (reviewer item 6)', () => {
	test('resolvedSpread', async () => {
		const { resolvedSpread } = await import('./index.ts');
		expect(resolvedSpread({ spread: 'zone' }, { spread: 'node' }, 'node')).toBe('zone');
		expect(resolvedSpread({ spread: 'node' }, { spread: 'zone' }, 'zone')).toBe('node');
		expect(resolvedSpread(undefined, { spread: 'zone' }, 'node')).toBe('zone');
		expect(resolvedSpread({}, null, 'zone')).toBe('zone');
		expect(resolvedSpread(undefined, undefined, 'node')).toBe('node');
		expect(resolvedSpread(null, {}, 'node')).toBe('node');
	});
});

describe('trust in mixed versions (reviewer item 7)', () => {
	test('install-ca only when the provider and every allowed consumer advertise endpoints-gateway', async () => {
		const { endpointTrustMode } = await import('./index.ts');
		const capable = { capabilities: ['jobs', 'endpoints-gateway'] };
		const old = { capabilities: ['jobs'] };
		expect(endpointTrustMode(capable, [capable, capable])).toBe('install-ca');
		expect(endpointTrustMode(capable, [capable, old])).toBe('pinned');
		expect(endpointTrustMode(old, [capable])).toBe('pinned');
		expect(endpointTrustMode(capable, [{ capabilities: [] }])).toBe('pinned');
		// No consumer yet: nothing to be incompatible with.
		expect(endpointTrustMode(capable, [])).toBe('install-ca');
		expect(endpointTrustMode(old, [])).toBe('pinned');
	});
});
