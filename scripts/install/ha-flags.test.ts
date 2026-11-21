import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { haInitPlan } from '../../packages/contracts/src/ha-init.ts';
import { parsePlatformObjectStoreKind } from '../../packages/contracts/src/platform-config.ts';
import { GCS_CREDENTIALS_COPY, objectStoreEnv, parseObjectStore, parseProfile, parseRoles, parseZone, profileFlagLines } from './ha-flags.ts';

describe('installer HA flags (HA-PLAN §8 steps 1–2)', () => {
	test('--profile writes exactly the flag lines yoal ha init prints, and single writes none', () => {
		expect(profileFlagLines('single')).toEqual([]);
		for (const profile of ['ha', 'ha-dr'] as const)
			expect(profileFlagLines(profile).map(([key, value]) => `${key}=${value}`)).toEqual(haInitPlan(profile).envLines.filter((line) => !line.startsWith('#')));
		expect(profileFlagLines('ha')).toContainEqual(['YOAL_FEATURE_STEERING', '1']);
		expect(profileFlagLines('ha').some(([key]) => key === 'YOAL_FEATURE_REGIONS')).toBe(false);
		expect(profileFlagLines('ha-dr')).toContainEqual(['YOAL_FEATURE_REGIONS', '1']);
		expect(() => parseProfile('cluster')).toThrow(/--profile must be/);
	});

	test('--zone and --roles are validated like Nodes → Edit node', () => {
		expect(parseZone('uksouth-2')).toBe('uksouth-2');
		expect(() => parseZone('UK South')).toThrow(/--zone/);
		expect(parseRoles('ingress, compute,ingress')).toEqual(['ingress', 'compute']);
		expect(() => parseRoles('ingress,router')).toThrow(/--roles/);
		expect(() => parseRoles('')).toThrow(/--roles/);
	});

	test('--object-store takes local, r2 and the W3 kinds with a container or bucket', () => {
		expect(parseObjectStore('local')).toEqual({ kind: 'local' });
		expect(parseObjectStore('azure://lynxnet-platform')).toEqual({ kind: 'azure', name: 'lynxnet-platform' });
		expect(parseObjectStore('gcs://yoal-platform/')).toEqual({ kind: 'gcs', name: 'yoal-platform' });
		expect(parseObjectStore('s3://yoal')).toEqual({ kind: 's3', name: 'yoal' });
		expect(() => parseObjectStore('azure://')).toThrow(/--object-store/);
		expect(() => parseObjectStore('azure://Bad_Name')).toThrow(/not a valid/);
		// The platform's own bucket rules (bucketNameSchema): no dots, no double hyphens.
		expect(() => parseObjectStore('s3://my.bucket')).toThrow(/not a valid/);
		expect(() => parseObjectStore('gcs://a--b')).toThrow(/not a valid/);
		expect(() => parseObjectStore('ftp://x')).toThrow(/--object-store must be/);
	});

	test('credentials come from the environment or the credentials file, and a missing one is named', () => {
		const azure = objectStoreEnv({ kind: 'azure', name: 'platform' }, { env: { YOAL_AZURE_ACCOUNT: 'acct' }, file: new Map([['YOAL_AZURE_SAS_TOKEN', 'sv=x'], ['UNRELATED', 'no']]) });
		expect(Object.fromEntries(azure.set)).toEqual({
			YOAL_OBJECT_STORE: 'azure',
			YOAL_FEATURE_OBJECT_STORE_AZURE: '1',
			YOAL_AZURE_ACCOUNT: 'acct',
			YOAL_AZURE_SAS_TOKEN: 'sv=x',
			YOAL_AZURE_CONTAINER: 'platform',
		});
		expect(azure.missing).toEqual([]);
		expect(objectStoreEnv({ kind: 'azure', name: 'platform' }, { env: {} }).missing).toEqual(['YOAL_AZURE_ACCOUNT', 'YOAL_AZURE_ACCOUNT_KEY or YOAL_AZURE_SAS_TOKEN']);

		// The service-account key is copied into /etc/yoal (root:yoal 0640) so the control plane can
		// read it, and yoal.env names the copy by its absolute path.
		const exists = (path: string) => path === '/root/sa.json' || path === '/srv/key.json';
		const gcs = objectStoreEnv({ kind: 'gcs', name: 'bucket-1' }, { env: {}, credentialsPath: '/root/sa.json', credentialsJson: true, exists });
		expect(Object.fromEntries(gcs.set)).toMatchObject({
			YOAL_OBJECT_STORE: 'gcs',
			YOAL_FEATURE_OBJECT_STORE_GCS: '1',
			YOAL_GCS_CREDENTIALS_FILE: GCS_CREDENTIALS_COPY,
			YOAL_GCS_BUCKET: 'bucket-1',
		});
		expect(gcs.copy).toEqual({ from: '/root/sa.json', to: GCS_CREDENTIALS_COPY });
		expect(GCS_CREDENTIALS_COPY).toBe('/etc/yoal/gcs-credentials.json');
		expect(objectStoreEnv({ kind: 'gcs', name: 'bucket-1' }, { env: { YOAL_GCS_CREDENTIALS_FILE: 'key.json' }, exists }).missing).toEqual([
			'YOAL_GCS_CREDENTIALS_FILE (an absolute path)',
		]);
		expect(objectStoreEnv({ kind: 'gcs', name: 'bucket-1' }, { env: { YOAL_GCS_CREDENTIALS_FILE: '/nope.json' }, exists }).missing).toEqual([
			'YOAL_GCS_CREDENTIALS_FILE (/nope.json does not exist)',
		]);
		expect(objectStoreEnv({ kind: 'gcs', name: 'bucket-1' }, { env: { YOAL_GCS_CREDENTIALS_FILE: '/srv/key.json' }, exists }).copy).toEqual({
			from: '/srv/key.json',
			to: GCS_CREDENTIALS_COPY,
		});

		// s3:// is the platform's S3 kind (YOAL_OBJECT_STORE=r2 parses as it) with an explicit endpoint
		// and region, and no placeholder account id.
		const s3 = objectStoreEnv(
			{ kind: 's3', name: 'yoal' },
			{ env: { R2_ACCESS_KEY_ID: 'AK' }, region: 'eu-west-2', existing: new Map([['R2_SECRET_ACCESS_KEY', 'old'], ['R2_ENDPOINT', 'https://s3.eu-west-2.amazonaws.com']]) },
		);
		expect(Object.fromEntries(s3.set)).toEqual({
			YOAL_OBJECT_STORE: 'r2',
			R2_ENDPOINT: 'https://s3.eu-west-2.amazonaws.com',
			R2_REGION: 'eu-west-2',
			R2_ACCESS_KEY_ID: 'AK',
			R2_SECRET_ACCESS_KEY: 'old',
			R2_BUCKET: 'yoal',
		});
		expect(parsePlatformObjectStoreKind(s3.set.get('YOAL_OBJECT_STORE'))).toBe('r2');
		expect(objectStoreEnv({ kind: 's3', name: 'yoal' }, { env: {} }).missing).toEqual([
			'R2_ENDPOINT',
			'--object-store-region (R2_REGION)',
			'R2_ACCESS_KEY_ID',
			'R2_SECRET_ACCESS_KEY',
		]);
		expect(objectStoreEnv({ kind: 's3', name: 'yoal' }, { env: { R2_ENDPOINT: 'http://s3.example.com' }, region: 'x' }).missing).toContain('R2_ENDPOINT (https://)');
	});
});

/** Runs the real installer entry point; it never gets past preflight off Linux, so nothing changes. */
function installer(args: string[], env: Record<string, string> = {}) {
	const result = Bun.spawnSync({
		cmd: [process.execPath, 'run', new URL('./main.ts', import.meta.url).pathname, '--public-address', '203.0.113.10', ...args],
		env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
		stdout: 'pipe',
		stderr: 'pipe',
	});
	return { code: result.exitCode, stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr) };
}

describe.skipIf(process.platform === 'linux')('install.sh --dry-run with the HA flags (off Linux: stops at preflight)', () => {
	test('prints the HA plan before anything else and refuses bad values with exit 64', () => {
		const dir = mkdtempSync(join(tmpdir(), 'yoal-install-flags-'));
		try {
			const credentials = join(dir, 'azure.env');
			writeFileSync(credentials, 'YOAL_AZURE_ACCOUNT=acct\nYOAL_AZURE_ACCOUNT_KEY=a2V5\n');
			const run = installer(
				['--dry-run', '--yes', '--profile', 'ha', '--zone', 'uksouth-1', '--object-store', 'azure://lynxnet-platform', '--object-store-credentials-file', credentials],
			);
			expect(run.stdout).toContain('HA flags:');
			expect(run.stdout).toContain('profile ha: YOAL_FEATURE_ENDPOINTS_GATEWAY=1');
			expect(run.stdout).toContain('zone uksouth-1 (sent with the join)');
			expect(run.stdout).toContain('object store azure://lynxnet-platform: YOAL_OBJECT_STORE, YOAL_FEATURE_OBJECT_STORE_AZURE, YOAL_AZURE_ACCOUNT, YOAL_AZURE_ACCOUNT_KEY, YOAL_AZURE_CONTAINER');
			// The key itself is never printed.
			expect(run.stdout).not.toContain('a2V5');
			expect(`${run.stdout}${run.stderr}`).toContain('Linux only');

			expect(installer(['--dry-run', '--yes', '--zone', 'Bad Zone'])).toMatchObject({ code: 64, stderr: expect.stringContaining('--zone') });
			expect(installer(['--dry-run', '--yes', '--profile', 'cluster'])).toMatchObject({ code: 64, stderr: expect.stringContaining('--profile') });
			expect(installer(['--dry-run', '--yes', '--roles', 'ingress'])).toMatchObject({ code: 64, stderr: expect.stringContaining('--roles is for a machine that joins') });
			expect(installer(['--dry-run', '--yes', '--object-store', 'azure://Bad_Name'])).toMatchObject({ code: 64 });
			const joining = installer(['--dry-run', '--yes', '--join', 'https://control.example.org', '--name', 'b', '--zone', 'uksouth-2', '--roles', 'ingress,data'], {
				YOAL_JOIN_TOKEN: 'j'.repeat(32),
			});
			expect(joining.stdout).toContain('roles ingress,data (sent with the join)');
			expect(installer(['--dry-run', '--yes', '--join', 'https://control.example.org', '--name', 'b', '--profile', 'ha'], { YOAL_JOIN_TOKEN: 'j'.repeat(32) })).toMatchObject({
				code: 64,
				stderr: expect.stringContaining('--profile is for the control-plane machine'),
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
