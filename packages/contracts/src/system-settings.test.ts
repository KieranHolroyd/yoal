import { describe, expect, test } from 'bun:test';
import { FEATURE_FLAG_NAMES, featureEnvKey } from './features.ts';
import { PLATFORM_CONFIG_SECTIONS, applyPlatformConfig, parsePlatformConfigRequest, type PlatformConfigRequest } from './platform-config.ts';
import { SYSTEM_TOGGLES, SYSTEM_TOGGLE_KEYS, systemToggleChanges, systemToggleValue } from './system-settings.ts';

const base = { id: 'req_0123456789', requestedAt: '2026-11-25T12:00:00.000Z', by: 'user_1' };

describe('system toggles', () => {
	test('every feature flag is a toggle, plus the core booleans', () => {
		for (const name of FEATURE_FLAG_NAMES) expect(SYSTEM_TOGGLE_KEYS).toContain(featureEnvKey(name) as never);
		expect(SYSTEM_TOGGLE_KEYS).toContain('YOAL_OPEN_SIGNUP');
		expect(SYSTEM_TOGGLE_KEYS).toContain('YOAL_OWNER_2FA');
		expect(SYSTEM_TOGGLE_KEYS).toContain('YOAL_MCP_ALLOW_DCR');
		expect(new Set(SYSTEM_TOGGLE_KEYS).size).toBe(SYSTEM_TOGGLE_KEYS.length);
		expect(PLATFORM_CONFIG_SECTIONS.system).toEqual(SYSTEM_TOGGLE_KEYS);
	});

	test('each core setting is read the way the control plane reads it', () => {
		expect(systemToggleValue('YOAL_OWNER_2FA', {})).toBe(true);
		expect(systemToggleValue('YOAL_OWNER_2FA', { YOAL_OWNER_2FA: '0' })).toBe(false);
		expect(systemToggleValue('YOAL_OWNER_2FA', { YOAL_OWNER_2FA: 'true' })).toBe(false);
		expect(systemToggleValue('YOAL_OPEN_SIGNUP', {})).toBe(false);
		expect(systemToggleValue('YOAL_OPEN_SIGNUP', { YOAL_OPEN_SIGNUP: 'yes' })).toBe(false);
		expect(systemToggleValue('YOAL_MCP_ALLOW_DCR', {})).toBe(true);
		expect(systemToggleValue('YOAL_FEATURE_JOBS', { YOAL_FEATURE_JOBS: 'off' })).toBe(false);
		expect(systemToggleValue('YOAL_FEATURE_REGIONS', { YOAL_FEATURE_REGIONS: 'nonsense' })).toBe(false);
	});

	test('changes touch only keys whose value moves, and unset a return to the default', () => {
		const env = { YOAL_FEATURE_JOBS: '0', YOAL_FEATURE_QUOTAS: '1', YOAL_OWNER_2FA: 'true' };
		const changes = systemToggleChanges(
			{
				YOAL_FEATURE_JOBS: true, // back to the default: removed
				YOAL_FEATURE_QUOTAS: true, // unchanged: left alone
				YOAL_FEATURE_REGIONS: true, // opt-in turned on: written
				YOAL_FEATURE_MEDIA: false, // kill switch: written
				YOAL_OWNER_2FA: true, // a malformed value read as off, back on: removed
				NODE_ENV: false as never, // not a toggle: ignored
			},
			env,
		);
		expect(changes.set).toEqual({ YOAL_FEATURE_REGIONS: '1', YOAL_FEATURE_MEDIA: '0' });
		expect(changes.unset.sort()).toEqual(['YOAL_FEATURE_JOBS', 'YOAL_OWNER_2FA']);
	});

	test('the system section only accepts 0 or 1 for its own keys', () => {
		const ok = parsePlatformConfigRequest({
			...base,
			action: 'configure',
			section: 'system',
			set: { YOAL_FEATURE_MEDIA: '0' },
			unset: ['YOAL_OPEN_SIGNUP'],
		});
		expect(ok.ok).toBe(true);
		for (const set of [{ YOAL_FEATURE_MEDIA: 'off' }, { YOAL_FEATURE_MEDIA: '1\nX=1' }, { YOAL_SMTP_HOST: 'mail.example.com' }])
			expect(parsePlatformConfigRequest({ ...base, action: 'configure', section: 'system', set }).ok).toBe(false);
		// And the other sections cannot reach a toggle.
		expect(
			parsePlatformConfigRequest({ ...base, action: 'configure', section: 'alerts', set: { YOAL_OPEN_SIGNUP: '1' } }).ok,
		).toBe(false);
	});

	test('applying a system change has no required keys', () => {
		const env = new Map([['YOAL_FEATURE_JOBS', '0']]);
		const request = parsePlatformConfigRequest({
			...base,
			action: 'configure',
			section: 'system',
			set: { YOAL_FEATURE_MEDIA: '0' },
			unset: ['YOAL_FEATURE_JOBS'],
		});
		if (!request.ok) throw new Error(request.error);
		const changed = applyPlatformConfig(env, request.request as Extract<PlatformConfigRequest, { action: 'configure' }>);
		expect(changed.sort()).toEqual(['YOAL_FEATURE_JOBS', 'YOAL_FEATURE_MEDIA']);
		expect(Object.fromEntries(env)).toEqual({ YOAL_FEATURE_MEDIA: '0' });
	});

	test('every toggle has a label and a description', () => {
		for (const toggle of SYSTEM_TOGGLES) {
			expect(toggle.label.length).toBeGreaterThan(1);
			expect(toggle.description.length).toBeGreaterThan(10);
		}
	});
});
