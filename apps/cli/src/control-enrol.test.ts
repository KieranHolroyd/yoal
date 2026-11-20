import { describe, expect, test } from 'bun:test';
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	controlConfigDigest,
	installControlEnrolment,
	masterKeyFingerprint,
	mergeEnvFile,
	openControlBundle,
	parseSealedControlBundle,
	type SealedControlBundle,
} from './control-enrol.ts';

/** The server's `sealControlBundle`, mirrored for the test fixture. */
function seal(input: {
	nodeId: string;
	primaryNodeId: string;
	masterKey: Buffer;
	config: Record<string, string>;
	secrets: Record<string, string>;
	activationCode: string;
}): SealedControlBundle {
	const salt = randomBytes(16);
	const payload = {
		masterKey: input.masterKey.toString('base64'),
		config: input.config,
		secrets: input.secrets,
	};
	const key = scryptSync(input.activationCode.normalize('NFKC').trim(), salt, 32);
	const nonce = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key, nonce);
	const encrypted = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload))), cipher.final()]);
	return {
		version: 1,
		nodeId: input.nodeId,
		primaryNodeId: input.primaryNodeId,
		createdAt: '2026-11-20T00:00:00.000Z',
		configDigest: controlConfigDigest({ ...input.config, ...input.secrets }),
		masterKeyFingerprint: masterKeyFingerprint(input.masterKey),
		salt: salt.toString('base64'),
		sealed: {
			ciphertext: Buffer.concat([encrypted, cipher.getAuthTag()]).toString('base64'),
			nonce: nonce.toString('base64'),
		},
	};
}

const masterKey = Buffer.alloc(32, 7);
const config = { YOAL_PLATFORM_ORIGIN: 'https://control.example.com', YOAL_CONTENT_DOMAIN: 'example.com' };
const secrets = { BETTER_AUTH_SECRET: 'session-secret', YOAL_SITE_COOKIE_SECRET: 'cookie-secret' };

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), 'yoal-cli-enrol-'));
	const bundle = seal({ nodeId: 'nod_b', primaryNodeId: 'nod_a', masterKey, config, secrets, activationCode: 'code-123' });
	return { dir, bundle };
}

describe('standby control enrolment (W9-SPEC §4.5)', () => {
	test('writes the key 0400, merges the allowlisted env 0600 and writes the record 0600', async () => {
		const { dir, bundle } = fixture();
		const dataDir = join(dir, 'data');
		mkdirSync(dataDir, { recursive: true });
		writeFileSync(
			join(dataDir, 'ha-control-replica.json'),
			JSON.stringify({ restored: true, lagSeconds: 0.5, position: 'ltx:1/2' }),
		);
		const envPath = join(dir, 'etc', 'yoal.env');
		mkdirSync(join(dir, 'etc'), { recursive: true });
		writeFileSync(envPath, '# keep me\nYOAL_DATA_DIR=/var/lib/yoal/data\nBETTER_AUTH_SECRET=old\n');
		const installed = await installControlEnrolment({
			bundle,
			activationCode: 'code-123',
			dataDir,
			masterKeyPath: join(dir, 'etc', 'master.key'),
			envPath,
			now: () => 1_000,
		});

		const keyText = readFileSync(join(dir, 'etc', 'master.key'), 'utf8').trim();
		expect(keyText).toBe(masterKey.toString('base64'));
		expect(statSync(join(dir, 'etc', 'master.key')).mode & 0o777).toBe(0o400);

		const env = readFileSync(envPath, 'utf8');
		expect(env).toContain('# keep me');
		expect(env).toContain('YOAL_DATA_DIR=/var/lib/yoal/data');
		expect(env).toContain('BETTER_AUTH_SECRET=session-secret');
		expect(env).not.toContain('BETTER_AUTH_SECRET=old');
		expect(env).toContain('YOAL_CONTENT_DOMAIN=example.com');
		expect(statSync(envPath).mode & 0o777).toBe(0o600);

		const record = JSON.parse(readFileSync(join(dataDir, 'ha-control-enrolment.json'), 'utf8'));
		expect(record).toMatchObject({
			version: 1,
			nodeId: 'nod_b',
			primaryNodeId: 'nod_a',
			masterKeyFingerprint: bundle.masterKeyFingerprint,
			configDigest: bundle.configDigest,
			replica: { restored: true, lagSeconds: 0.5, position: 'ltx:1/2' },
			enrolledAt: '1970-01-01T00:00:01.000Z',
		});
		expect(statSync(join(dataDir, 'ha-control-enrolment.json')).mode & 0o777).toBe(0o600);
		expect(installed.nodeId).toBe('nod_b');
	});

	test('a wrong code or a tampered fingerprint writes nothing', async () => {
		const { dir, bundle } = fixture();
		const masterKeyPath = join(dir, 'etc', 'master.key');
		await expect(
			installControlEnrolment({
				bundle,
				activationCode: 'wrong',
				dataDir: join(dir, 'data'),
				masterKeyPath,
				envPath: join(dir, 'etc', 'yoal.env'),
			}),
		).rejects.toThrow(/activation code/);
		expect(existsSync(masterKeyPath)).toBe(false);

		const tampered = { ...bundle, masterKeyFingerprint: '00'.repeat(32) };
		await expect(
			installControlEnrolment({
				bundle: tampered,
				activationCode: 'code-123',
				dataDir: join(dir, 'data'),
				masterKeyPath,
				envPath: join(dir, 'etc', 'yoal.env'),
			}),
		).rejects.toThrow(/fingerprint/);
		expect(existsSync(masterKeyPath)).toBe(false);
		expect(existsSync(join(dir, 'data', 'ha-control-enrolment.json'))).toBe(false);
	});

	test('the bundle parser rejects the wrong shape and the opener verifies both digests', () => {
		const { bundle } = fixture();
		expect(parseSealedControlBundle(JSON.stringify(bundle))).toEqual(bundle);
		expect(parseSealedControlBundle(JSON.stringify({ bundle, certificate: { serial: 's' } }))).toEqual(bundle);
		expect(() => parseSealedControlBundle('not json')).toThrow(/valid JSON/);
		expect(() => parseSealedControlBundle(JSON.stringify({ ...bundle, version: 2 }))).toThrow(/version 1/);
		expect(openControlBundle(bundle, 'code-123')).toMatchObject({ config, secrets });
		expect(() => openControlBundle({ ...bundle, configDigest: 'ff' }, 'code-123')).toThrow(/config/);
	});

	test('env merging keeps comments and unrelated settings', () => {
		const merged = mergeEnvFile('# comment\nOTHER=1\nYOAL_PLATFORM_ORIGIN="old"\n', {
			masterKey: '',
			config: { YOAL_PLATFORM_ORIGIN: 'https://new.example.com' },
			secrets: {},
		});
		expect(merged).toContain('# comment');
		expect(merged).toContain('OTHER=1');
		expect(merged).toContain('YOAL_PLATFORM_ORIGIN=https://new.example.com');
		expect(merged.endsWith('\n')).toBe(true);
	});
});
