import { describe, expect, test } from 'bun:test';
import { changeFields, envDiff, highlight, isRisky, pendingChanges, type ToggleView } from './changes.js';

function toggle(overrides: Partial<ToggleView>): ToggleView {
	return {
		key: 'YOAL_FEATURE_MEDIA',
		label: 'Media',
		area: 'storage',
		description: 'Image and video uploads.',
		default: true,
		optIn: false,
		risky: null,
		value: true,
		raw: null,
		...overrides
	};
}

describe('System page changes', () => {
	const media = toggle({});
	const jobs = toggle({ key: 'YOAL_FEATURE_JOBS', label: 'Jobs', value: false, raw: '0' });
	const twoFactor = toggle({ key: 'YOAL_OWNER_2FA', label: 'Owner second factor', risky: 'off' });

	test('only toggles that move are pending, and a return to the default removes the key', () => {
		const changes = pendingChanges([media, jobs, twoFactor], {
			YOAL_FEATURE_MEDIA: true, // unchanged
			YOAL_FEATURE_JOBS: true, // back to default
			YOAL_OWNER_2FA: false
		});
		expect(changes.map((change) => change.toggle.key)).toEqual(['YOAL_FEATURE_JOBS', 'YOAL_OWNER_2FA']);
		expect(changes[0]!.line).toBeNull();
		expect(changes[1]!.line).toBe('YOAL_OWNER_2FA=0');
		expect(changes[1]!.risky).toBe(true);
		expect(changeFields(changes)).toEqual({ YOAL_FEATURE_JOBS: '1', YOAL_OWNER_2FA: '0' });
	});

	test('the env diff removes the old line and adds the new one', () => {
		const changes = pendingChanges([jobs, twoFactor], { YOAL_FEATURE_JOBS: true, YOAL_OWNER_2FA: false });
		expect(envDiff(changes)).toEqual([
			{ sign: '-', text: 'YOAL_FEATURE_JOBS=0' },
			{ sign: '+', text: 'YOAL_OWNER_2FA=0' }
		]);
	});

	test('risk follows the direction', () => {
		expect(isRisky({ risky: 'on' }, true)).toBe(true);
		expect(isRisky({ risky: 'on' }, false)).toBe(false);
		expect(isRisky({ risky: 'off' }, false)).toBe(true);
		expect(isRisky({ risky: null }, false)).toBe(false);
	});

	test('highlight splits around every match, ignoring case', () => {
		expect(highlight('Database TLS for databases', 'data')).toEqual([
			{ text: 'Data', match: true },
			{ text: 'base TLS for ', match: false },
			{ text: 'data', match: true },
			{ text: 'bases', match: false }
		]);
		expect(highlight('Jobs', ' ')).toEqual([{ text: 'Jobs', match: false }]);
	});
});
