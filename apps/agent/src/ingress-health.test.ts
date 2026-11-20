import { describe, expect, test } from 'bun:test';
import { INGRESS_DRIFT_WINDOW_MS } from '@yoal/contracts';
import { ingressHealth, ingressHealthWord, normalizeFingerprint, type IngressHealthInput } from './ingress-health.ts';

const base: IngressHealthInput = {
	draining: false,
	caddyOk: true,
	desiredStateVersion: 12,
	appliedStateVersion: 12,
	lastConvergedAt: 1_000,
	now: 2_000,
};

describe('ingress health decision (HA-PLAN H19)', () => {
	test('200 only when every condition holds', () => {
		const health = ingressHealth(base);
		expect(health).toEqual({
			status: 'ok',
			reason: null,
			desiredStateVersion: 12,
			appliedStateVersion: 12,
			certificateFingerprint: null,
		});
		expect(ingressHealthWord(health)).toBe('ok');
	});

	test('503 caddy when Caddy has not loaded a config', () => {
		const health = ingressHealth({ ...base, caddyOk: false });
		expect(health).toMatchObject({ status: 'unready', reason: 'caddy' });
		expect(ingressHealthWord(health)).toBe('caddy');
	});

	test('503 desired-state when the routes are past the drift window', () => {
		const drifting = ingressHealth({
			...base,
			appliedStateVersion: 11,
			lastConvergedAt: base.now - INGRESS_DRIFT_WINDOW_MS - 1,
		});
		expect(drifting).toMatchObject({ status: 'unready', reason: 'desired-state' });
		expect(ingressHealthWord(drifting)).toBe('desired-state');
		// The same lag inside the window still serves: a reload is not an outage.
		expect(
			ingressHealth({ ...base, appliedStateVersion: 11, lastConvergedAt: base.now - INGRESS_DRIFT_WINDOW_MS + 1 }),
		).toMatchObject({ status: 'ok' });
		// Before the first converge, or before any desired state, there is nothing to serve.
		expect(ingressHealth({ ...base, appliedStateVersion: null })).toMatchObject({ reason: 'desired-state' });
		expect(ingressHealth({ ...base, desiredStateVersion: null })).toMatchObject({ reason: 'desired-state' });
		expect(ingressHealth({ ...base, lastConvergedAt: null, appliedStateVersion: 11 })).toMatchObject({
			reason: 'desired-state',
		});
	});

	test('503 releases when a release the applied routes need is not on disk', () => {
		const health = ingressHealth({ ...base, missingReleases: ['a'.repeat(64)] });
		expect(health).toMatchObject({ status: 'unready', reason: 'releases' });
		expect(ingressHealthWord(health)).toBe('releases');
	});

	test('503 certificates on a fingerprint mismatch, and no check when none is expected', () => {
		const expected = 'ab'.repeat(32);
		expect(
			ingressHealth({
				...base,
				expectedCertificateFingerprint: expected,
				loadedCertificateFingerprint: 'cd'.repeat(32),
			}),
		).toMatchObject({ reason: 'certificates' });
		expect(
			ingressHealth({ ...base, expectedCertificateFingerprint: expected, loadedCertificateFingerprint: null }),
		).toMatchObject({ reason: 'certificates' });
		// Caddy writes colons and upper case; the comparison does not care.
		const health = ingressHealth({
			...base,
			expectedCertificateFingerprint: expected,
			loadedCertificateFingerprint: expected.toUpperCase().match(/../g)!.join(':'),
		});
		expect(health).toMatchObject({ status: 'ok', certificateFingerprint: expected });
		// No fleet fingerprint (single node, SHARED_CERTIFICATES off): nothing to compare.
		expect(ingressHealth({ ...base, expectedCertificateFingerprint: null })).toMatchObject({ status: 'ok' });
	});

	test('the lame duck wins over every failure: 503 draining while still serving', () => {
		const health = ingressHealth({ ...base, draining: true, caddyOk: false, missingReleases: ['x'] });
		expect(health).toMatchObject({ status: 'draining', reason: null });
		expect(ingressHealthWord(health)).toBe('draining');
	});

	test('the conditions are checked in order, so one word names the first failure', () => {
		expect(
			ingressHealth({
				...base,
				caddyOk: false,
				appliedStateVersion: 1,
				missingReleases: ['x'],
				expectedCertificateFingerprint: 'ab',
			}).reason,
		).toBe('caddy');
		expect(
			ingressHealth({
				...base,
				now: 200_000,
				appliedStateVersion: 1,
				lastConvergedAt: 0,
				missingReleases: ['x'],
				expectedCertificateFingerprint: 'ab',
			}).reason,
		).toBe('desired-state');
		expect(ingressHealth({ ...base, missingReleases: ['x'], expectedCertificateFingerprint: 'ab' }).reason).toBe('releases');
	});

	test('fingerprints normalise to bare lower-case hex', () => {
		expect(normalizeFingerprint('AB:CD:EF')).toBe('abcdef');
		expect(normalizeFingerprint('')).toBeNull();
		expect(normalizeFingerprint(null)).toBeNull();
	});
});
