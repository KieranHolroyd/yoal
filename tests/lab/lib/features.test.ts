import { describe, expect, test } from 'bun:test';
import { FEATURE_FLAGS } from '../../../packages/contracts/src/features.ts';
import { featureEnvFiles, formatFeatures, mergeFeatures, parseFeatureArgs, renderFeatureEnv } from './features.ts';

describe('lab up --feature', () => {
	test('parses repeatable NAME=VALUE flags against the registry', () => {
		expect(parseFeatureArgs(['up', '--feature', 'ENDPOINTS_GATEWAY=1', '--only', 'lab-a', '--feature', 'release_phase=true', '--feature', 'STEERING=0'])).toEqual({
			ENDPOINTS_GATEWAY: true,
			RELEASE_PHASE: true,
			STEERING: false,
		});
		expect(parseFeatureArgs(['up'])).toEqual({});
	});

	test('refuses an unknown flag, a bad value, or a missing value', () => {
		expect(() => parseFeatureArgs(['--feature', 'NOT_A_FLAG=1'])).toThrow(/unknown feature flag NOT_A_FLAG/);
		expect(() => parseFeatureArgs(['--feature', 'RELEASE_PHASE=maybe'])).toThrow(/0, 1, true or false/);
		expect(() => parseFeatureArgs(['--feature', 'RELEASE_PHASE'])).toThrow(/NAME=VALUE/);
		expect(() => parseFeatureArgs(['--feature'])).toThrow(/NAME=VALUE/);
		expect(() => parseFeatureArgs(['--feature', 'DB_CONSOLE=1'])).toThrow(/unknown feature flag/);
	});

	test('a later up keeps earlier flags and lets a new value win', () => {
		expect(mergeFeatures({ RELEASE_PHASE: true, STEERING: true }, { STEERING: false, INGRESS_SET: true })).toEqual({ RELEASE_PHASE: true, STEERING: false, INGRESS_SET: true });
		expect(mergeFeatures(undefined, {})).toEqual({});
		expect(formatFeatures({ RELEASE_PHASE: true, STEERING: false })).toBe('RELEASE_PHASE=1, STEERING=0');
		expect(formatFeatures({})).toBe('none');
	});

	test('renders YOAL_FEATURE_* lines into an env file: replaces, appends, keeps everything else', () => {
		const before = 'NODE_ENV=production\nYOAL_FEATURE_RELEASE_PHASE=0\n# comment\nYOAL_DATA_DIR=/var/lib/yoal/data\n';
		const out = renderFeatureEnv(before, { RELEASE_PHASE: true, ENDPOINTS_GATEWAY: true });
		expect(out.changed).toBe(true);
		expect(out.text).toBe('NODE_ENV=production\nYOAL_FEATURE_RELEASE_PHASE=1\n# comment\nYOAL_DATA_DIR=/var/lib/yoal/data\nYOAL_FEATURE_ENDPOINTS_GATEWAY=1\n');
		// Idempotent: a second render changes nothing, so no unit restarts.
		expect(renderFeatureEnv(out.text, { RELEASE_PHASE: true, ENDPOINTS_GATEWAY: true })).toEqual({ text: out.text, changed: false });
		// A quoted value the installer may write is still recognised.
		expect(renderFeatureEnv('YOAL_FEATURE_STEERING="1"\n', { STEERING: true }).changed).toBe(true);
		expect(renderFeatureEnv('A=1', { STEERING: false }).text).toBe('A=1\nYOAL_FEATURE_STEERING=0\n');
		expect(renderFeatureEnv('', {})).toEqual({ text: '', changed: false });
	});

	test('the env files each role reads: the control plane on the control node, the agent everywhere', () => {
		expect(featureEnvFiles('control')).toEqual([
			{ file: '/etc/yoal/yoal.env', unit: 'yoal-control-plane.service' },
			{ file: '/etc/yoal/agent.env', unit: 'yoal-agent.service' },
		]);
		expect(featureEnvFiles('worker')).toEqual([{ file: '/etc/yoal/agent.env', unit: 'yoal-agent.service' }]);
	});

	test('every registry flag is accepted', () => {
		for (const name of Object.keys(FEATURE_FLAGS)) expect(parseFeatureArgs(['--feature', `${name}=1`])).toEqual({ [name]: true });
	});
});
