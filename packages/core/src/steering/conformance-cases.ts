import type { SteeringDriver, SteeringDriverKind } from '@yoal/contracts';

/**
 * The shared steering conformance suite (HA-PLAN H18, Wave 2).
 *
 * Every driver — `direct`, `external-lb`, `dns-failover`, later `vip` and `webhook` — is run
 * through the same contract cases, so a new driver cannot quietly skip the shape the UI, preflight
 * and controller rely on. Cases a driver cannot satisfy on its own (writer idempotence, the last
 * healthy record) are declared through hooks and are required when the driver says it writes.
 *
 * Lane D extends the hooks with `external-lb`; lane E supplies the `dns-failover` hooks from its
 * fake Cloudflare provider.
 */

export interface SteeringConformanceSubject {
	driver: SteeringDriver;
	expectedKind: SteeringDriverKind;
	/** Number of provider writes so far. Required when `capabilities.writes` is true. */
	writes?: () => number;
	/** The driver's leased apply. Defaults to the contract's `desired()`. */
	apply?: () => Promise<void>;
	/** A simulation that fails every ingress. Required for a driver that writes records. */
	lastHealthy?: () => Promise<{ withdrawn: string[]; records: string[] }> | { withdrawn: string[]; records: string[] };
	/**
	 * What a records-style driver does when every node fails. DNS keeps the last record (negative
	 * answers outlive the TTL); a floating address withdraws (a stale VIP is worse than none).
	 */
	lastHealthyAllFail?: 'keep' | 'withdraw';
	/** Driver-specific contract cases (a signature, a VRRP address) run beside the shared ones. */
	extraCases?: SteeringConformanceCase[];
}

export interface SteeringConformanceCase {
	name: string;
	run: () => Promise<void> | void;
}

export function steeringConformanceCases(subject: SteeringConformanceSubject): SteeringConformanceCase[] {
	const { driver } = subject;
	return [
		{
			name: 'declares its kind and a complete capability set',
			run: () => {
				expectEqual(driver.kind, subject.expectedKind, 'driver kind');
				const probes = driver.capabilities?.probes;
				const preserves = driver.capabilities?.preservesClientIp;
				expectEqual(typeof driver.capabilities?.writes, 'boolean', 'capabilities.writes');
				if (!['yoal', 'external', 'none'].includes(probes)) throw new Error(`bad probes capability: ${String(probes)}`);
				if (!['native', 'proxy-protocol', 'header'].includes(preserves)) throw new Error(`bad preservesClientIp: ${String(preserves)}`);
			},
		},
		{
			name: 'preflight returns findings rather than throwing',
			run: () => {
				const findings = driver.preflight();
				if (!Array.isArray(findings)) throw new Error('preflight did not return an array');
				for (const finding of findings) {
					if (typeof finding.reason !== 'string' || !finding.reason.trim()) throw new Error('a finding has no reason');
					if (finding.nodeId !== null && typeof finding.nodeId !== 'string') throw new Error('a finding has a bad nodeId');
				}
			},
		},
		{
			name: 'observe returns a plain object',
			run: async () => {
				const observed = await driver.observe();
				if (typeof observed !== 'object' || observed === null || Array.isArray(observed)) throw new Error('observe did not return an object');
			},
		},
		{
			name: 'two applies in a row write nothing the second time',
			run: async () => {
				if (!driver.capabilities.writes) return;
				if (!subject.writes) throw new Error('a writing driver must declare its write counter');
				const apply = subject.apply ?? (() => driver.desired());
				await apply();
				const before = subject.writes();
				await apply();
				expectEqual(subject.writes(), before, 'writes on the second apply');
			},
		},
		{
			name: 'never withdraws the last healthy record',
			run: async () => {
				if (!driver.capabilities.writes) return;
				if (!subject.lastHealthy) throw new Error('a writing driver must declare its last-healthy simulation');
				const result = await subject.lastHealthy();
				if (subject.lastHealthyAllFail === 'withdraw') {
					if (result.records.length) throw new Error('the record set kept a stale holder with every node failing');
					if (!result.withdrawn.length) throw new Error('no node was withdrawn with every node failing');
					return;
				}
				expectEqual(result.withdrawn.length, 0, 'withdrawals with every node failing');
				if (!result.records.length) throw new Error('the record set was emptied');
			},
		},
		...(subject.extraCases ?? []),
	];
}

function expectEqual(actual: unknown, expected: unknown, what: string): void {
	if (actual !== expected) throw new Error(`${what}: expected ${String(expected)}, got ${String(actual)}`);
}
