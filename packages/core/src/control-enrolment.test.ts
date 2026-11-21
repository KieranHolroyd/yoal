import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	CONTROL_CONFIG_KEYS,
	controlConfigDigest,
	controlConfigEnvelope,
	masterKeyFingerprint,
	openControlBundle,
	readControlEnrolment,
	readControlReplicaStatus,
	sealControlBundle,
} from './control-enrolment.ts';

const masterKey = new Uint8Array(32).fill(7);

describe('control-standby enrolment (W9-SPEC §4.5)', () => {
	test('seals the master key and allowlisted config; only the code opens it', () => {
		const envelope = controlConfigEnvelope({
			YOAL_PLATFORM_ORIGIN: 'https://control.example.com',
			YOAL_CONTENT_DOMAIN: 'example.com',
			BETTER_AUTH_SECRET: 'session-secret',
			UNRELATED: 'must not travel',
		});
		const { bundle, activationCode } = sealControlBundle({
			nodeId: 'nod_b',
			primaryNodeId: 'nod_a',
			masterKey,
			envelope,
			activationCode: 'one-time-code',
			now: () => 1_000,
		});
		expect(bundle).toMatchObject({
			version: 1,
			nodeId: 'nod_b',
			primaryNodeId: 'nod_a',
			masterKeyFingerprint: masterKeyFingerprint(masterKey),
		});
		expect(bundle.configDigest).toBe(
			controlConfigDigest({
				YOAL_PLATFORM_ORIGIN: 'https://control.example.com',
				YOAL_CONTENT_DOMAIN: 'example.com',
				BETTER_AUTH_SECRET: 'session-secret',
			}),
		);
		// The sealed ciphertext never carries plaintext values.
		expect(JSON.stringify(bundle)).not.toContain('session-secret');
		expect(JSON.stringify(bundle)).not.toContain(Buffer.from(masterKey).toString('base64'));

		const opened = openControlBundle(bundle, activationCode);
		expect(Buffer.from(opened.masterKey, 'base64')).toEqual(Buffer.from(masterKey));
		expect(opened.config.YOAL_PLATFORM_ORIGIN).toBe('https://control.example.com');
		expect(opened.secrets.BETTER_AUTH_SECRET).toBe('session-secret');
		expect(opened.config.UNRELATED).toBeUndefined();
		expect(() => openControlBundle(bundle, 'wrong-code')).toThrow();
	});

	test('the digest is stable across key order and ignores values outside the allowlist', () => {
		const a = controlConfigDigest({ YOAL_CONTENT_DOMAIN: 'x', YOAL_PLATFORM_ORIGIN: 'y' });
		const b = controlConfigDigest({ YOAL_PLATFORM_ORIGIN: 'y', YOAL_CONTENT_DOMAIN: 'x' });
		expect(a).toBe(b);
		expect(controlConfigDigest({ YOAL_CONTENT_DOMAIN: 'x' })).not.toBe(a);
		expect(CONTROL_CONFIG_KEYS).toContain('YOAL_PLATFORM_ORIGIN');
	});

	test('reads the enrolment record and replica status, failing closed on absent files', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'yoal-control-enrol-'));
		expect(await readControlEnrolment(join(dir, 'missing.json'))).toBeNull();
		expect(await readControlReplicaStatus(join(dir, 'missing.json'))).toEqual({
			restored: false,
			lagSeconds: null,
			position: null,
		});
		const record = {
			version: 1 as const,
			nodeId: 'nod_b',
			primaryNodeId: 'nod_a',
			masterKeyFingerprint: 'aa',
			configDigest: 'bb',
			replica: { restored: true, lagSeconds: 0.5, position: 'ltx:1/2' },
			enrolledAt: '2026-11-20T00:00:00.000Z',
		};
		await writeFile(join(dir, 'enrol.json'), JSON.stringify(record));
		expect(await readControlEnrolment(join(dir, 'enrol.json'))).toEqual(record);
		expect(await readControlReplicaStatus(join(dir, 'missing.json'), record.replica)).toEqual(record.replica);
		await writeFile(join(dir, 'replica.json'), JSON.stringify({ restored: true, lagSeconds: 12, position: 'p' }));
		expect(await readControlReplicaStatus(join(dir, 'replica.json'))).toMatchObject({ restored: true, lagSeconds: 12 });
		expect(await readFile(join(dir, 'replica.json'), 'utf8')).toContain('"restored":true');
	});
});
