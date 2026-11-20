/** Batch runs, shrinking and trace printing for the lease simulator. */
import { fileURLToPath } from 'node:url';
import { PROFILES, type Profile } from './profiles.ts';
import { fnv1a } from './rng.ts';
import { type Fault, type LeaseModule, type RunResult, type TraceEvent, contenderCount, generateFaults, runOnce } from './world.ts';

export const MODULES: Record<string, string> = {
	real: fileURLToPath(new URL('../../../packages/core/src/ha-lease.ts', import.meta.url)),
	planted: fileURLToPath(new URL('./fixtures/ha-lease-planted.ts', import.meta.url)),
};

export async function loadModule(name: string): Promise<{ path: string; module: LeaseModule }> {
	const path = MODULES[name] ?? name;
	const module = (await import(path)) as LeaseModule;
	if (typeof module.ControlLease !== 'function') throw new Error(`${path} does not export ControlLease`);
	return { path, module };
}

export function profileNamed(name: string): Profile {
	const profile = PROFILES[name];
	if (!profile) throw new Error(`unknown profile ${name}; known: ${Object.keys(PROFILES).join(', ')}`);
	return profile;
}

export interface BatchResult {
	runs: number;
	failures: RunResult[];
	stalls: RunResult[];
	events: number;
	takeovers: number;
	elapsedMs: number;
}

export async function runBatch(options: {
	module: LeaseModule;
	profile: Profile;
	firstSeed: number;
	runs: number;
	contenders?: number;
	stopAfterFailures?: number;
}): Promise<BatchResult> {
	const started = performance.now();
	const failures: RunResult[] = [];
	const stalls: RunResult[] = [];
	let events = 0;
	let takeovers = 0;
	let runs = 0;
	for (let seed = options.firstSeed; seed < options.firstSeed + options.runs; seed++) {
		const result = await runOnce({ seed, profile: options.profile, module: options.module, contenders: options.contenders });
		runs++;
		events += result.events;
		takeovers += result.takeovers;
		// Keep only the summary of passing runs; traces are rebuilt on replay.
		if (result.violation) failures.push(result);
		else if (result.liveness.stalled) stalls.push({ ...result, trace: [] });
		if (options.stopAfterFailures && failures.length >= options.stopAfterFailures) break;
	}
	return { runs, failures, stalls, events, takeovers, elapsedMs: performance.now() - started };
}

/**
 * Greedy delta-debugging over the fault schedule: drop each fault in turn and keep the drop when
 * the run still violates a property. Replaying the seed with the surviving fault ids is exact.
 */
export async function shrink(options: { seed: number; module: LeaseModule; profile: Profile; contenders?: number }): Promise<{
	keep: number[];
	result: RunResult;
}> {
	const contenders = options.contenders ?? contenderCount(options.seed, options.profile);
	let keep = generateFaults(options.seed, options.profile, contenders).map((f) => f.id);
	const run = (ids: number[]) =>
		runOnce({ seed: options.seed, profile: options.profile, module: options.module, contenders, keep: new Set(ids) });
	let best = await run(keep);
	if (!best.violation) throw new Error(`seed ${options.seed} does not fail`);
	for (let pass = 0; pass < 3; pass++) {
		let changed = false;
		for (const id of [...keep]) {
			const candidate = keep.filter((x) => x !== id);
			const result = await run(candidate);
			if (result.violation) {
				keep = candidate;
				best = result;
				changed = true;
			}
		}
		if (!changed) break;
	}
	return { keep, result: best };
}

export function describeFault(f: Fault): string {
	const node = `n${f.node}`;
	const secs = `${(f.durationMs / 1000).toFixed(1)}s`;
	switch (f.kind) {
		case 'partition':
			return `#${f.id} @${(f.at / 1000).toFixed(3)}s ${f.flag ? 'black-hole' : 'reject'} partition ${node}↔store ${secs}`;
		case 'slow':
			return `#${f.id} @${(f.at / 1000).toFixed(3)}s slow link ${node} legs≤${f.value}ms ${secs}`;
		case 'clock-step':
			return `#${f.id} @${(f.at / 1000).toFixed(3)}s wall clock step ${node} ${(f.value / 1000).toFixed(3)}s`;
		default:
			return `#${f.id} @${(f.at / 1000).toFixed(3)}s ${f.kind} ${node} ${secs}${f.value ? ` value=${f.value}` : ''}`;
	}
}

/** The printable trace: verbose lines dropped unless asked, consecutive renewals collapsed. */
export function formatTrace(trace: TraceEvent[], options: { verbose?: boolean; maxLines?: number } = {}): string[] {
	const lines: string[] = [];
	let collapsed: { node: string; count: number; from: number; to: number } | null = null;
	const flush = () => {
		if (!collapsed) return;
		lines.push(
			collapsed.count === 1
				? `  ${(collapsed.from / 1000).toFixed(3).padStart(9)}s ${collapsed.node.padEnd(5)} renewal applied`
				: `  ${(collapsed.from / 1000).toFixed(3).padStart(9)}s ${collapsed.node.padEnd(5)} … ${collapsed.count} renewals applied until ${(collapsed.to / 1000).toFixed(3)}s`,
		);
		collapsed = null;
	};
	for (const e of trace) {
		if (e.verbose && !options.verbose) continue;
		if (e.renewal && !options.verbose) {
			if (collapsed && collapsed.node === e.node) {
				collapsed.count++;
				collapsed.to = e.t;
			} else {
				flush();
				collapsed = { node: e.node, count: 1, from: e.t, to: e.t };
			}
			continue;
		}
		flush();
		lines.push(`  ${(e.t / 1000).toFixed(3).padStart(9)}s ${e.node.padEnd(5)} ${e.text}`);
	}
	flush();
	const max = options.maxLines ?? 400;
	if (lines.length > max) return [`  … ${lines.length - max} earlier lines omitted (use --verbose or --max-lines)`, ...lines.slice(-max)];
	return lines;
}

export function traceFingerprint(result: RunResult): string {
	return fnv1a(result.trace.map((e) => `${e.t}|${e.node}|${e.text}`).join('\n'));
}

export { PROFILES };
