/**
 * Mutants of packages/core/src/ha-lease.ts for the lease simulator: each is the real source with
 * one documented timing rule broken, built at load time by exact text replacement (a replacement
 * that no longer matches exactly once throws, so a mutant never silently turns into the real code).
 * `bun tests/ha/sim/run.ts --module mutant:<name>` runs one; sim.test.ts asserts each is caught.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fnv1a } from '../rng.ts';

export interface Mutant {
	description: string;
	replacements: [from: string, to: string][];
}

export const MUTANTS: Record<string, Mutant> = {
	'no-observe-wait': {
		description: 'takeover skips the 40 s unchanged-ETag wait (expiry by the store clock alone)',
		replacements: [
			[
				'const takeover = record.released || (expired && observedFor >= this.policy.takeoverAfterMs);',
				'const takeover = record.released || expired;',
			],
		],
	},
	'takeover-31s': {
		description: 'takeoverAfterMs is 31 s instead of 40 s',
		replacements: [['takeoverAfterMs: 40_000,', 'takeoverAfterMs: 31_000,']],
	},
	'fence-29s': {
		description: 'fenceAfterMs is 29 s instead of 20 s',
		replacements: [['fenceAfterMs: 20_000,', 'fenceAfterMs: 29_000,']],
	},
	'holds-ignores-fence': {
		description: 'holds() checks the role only, not the fence timer',
		replacements: [
			[
				"this.#role === 'primary' &&\n\t\t\tthis.#lastConfirmedAt !== null &&\n\t\t\tthis.#monotonic() - this.#lastConfirmedAt < this.policy.fenceAfterMs",
				"this.#role === 'primary'",
			],
		],
	},
	'fence-wall-clock': {
		description: 'the fence timer (lastConfirmedAt, holds(), the unreachable check) runs on the wall clock',
		replacements: [
			['this.#monotonic() - this.#lastConfirmedAt < this.policy.fenceAfterMs', 'this.#wallClock() - this.#lastConfirmedAt < this.policy.fenceAfterMs'],
			['this.#lastConfirmedAt = this.#monotonic();', 'this.#lastConfirmedAt = this.#wallClock();'],
			[': this.#monotonic() - this.#lastConfirmedAt;', ': this.#wallClock() - this.#lastConfirmedAt;'],
		],
	},
};

export const REAL_LEASE = fileURLToPath(new URL('../../../../packages/core/src/ha-lease.ts', import.meta.url));

/** The mutant's source: the real file with its replacements applied, each matching exactly once. */
export function mutantSource(name: string, original = readFileSync(REAL_LEASE, 'utf8')): string {
	const mutant = MUTANTS[name];
	if (!mutant) throw new Error(`unknown mutant ${name}; known: ${Object.keys(MUTANTS).join(', ')}`);
	let source = original;
	for (const [from, to] of mutant.replacements) {
		const count = source.split(from).length - 1;
		if (count !== 1) throw new Error(`mutant ${name}: expected one match of ${JSON.stringify(from)} in ha-lease.ts, found ${count}`);
		source = source.replace(from, () => to);
	}
	// The real file imports types only from './object-store.ts'; point that at the real module.
	return source.replace("from './object-store.ts'", `from ${JSON.stringify(REAL_LEASE.replace(/ha-lease\.ts$/, 'object-store.ts'))}`);
}

/** Write the mutant to a temp file (named by its content hash) and return the path to import. */
export function materializeMutant(name: string): string {
	const source = mutantSource(name);
	const dir = join(tmpdir(), 'yoal-ha-sim-mutants');
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `ha-lease-${name}-${fnv1a(source)}.ts`);
	writeFileSync(path, source);
	return path;
}
