import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DrainMiner, type DrainMinerSnapshot } from './log-patterns.ts';

/**
 * Index-time pattern mining (docs/LOGS.md §8.1): one `DrainMiner` per control plane, handed to the
 * indexer, with its templates persisted to the data dir so a restart keeps pattern ids warm.
 *
 * The snapshot is written every `LOG_PATTERN_SNAPSHOT_INTERVAL_MS` and on shutdown, atomically
 * (temp file + rename), and only once the miner has learnt something, so an idle process never
 * overwrites a good snapshot with an empty one. A missing, unreadable or malformed snapshot just
 * means a cold miner: pattern ids are template hashes, so they stay stable either way.
 */

export const LOG_PATTERN_SNAPSHOT_FILE = 'log-patterns.json';
export const LOG_PATTERN_SNAPSHOT_INTERVAL_MS = 10 * 60_000;

export function logPatternSnapshotPath(dataDir: string): string {
	return join(dataDir, LOG_PATTERN_SNAPSHOT_FILE);
}

/** Load a snapshot into the miner. Returns the number of templates restored (0 when there was none). */
export function restoreLogPatternSnapshot(miner: DrainMiner, path: string): number {
	let snapshot: DrainMinerSnapshot;
	try {
		snapshot = JSON.parse(readFileSync(path, 'utf8')) as DrainMinerSnapshot;
	} catch {
		return 0;
	}
	miner.restore(snapshot);
	return miner.stats().templates;
}

/** Write the miner's snapshot atomically. Skips (returns false) while the miner holds no templates. */
export function saveLogPatternSnapshot(miner: DrainMiner, path: string): boolean {
	if (miner.stats().templates === 0) return false;
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, JSON.stringify(miner.snapshot()), { mode: 0o600 });
	renameSync(temp, path);
	return true;
}

export interface LogPatternMinerHandle {
	miner: DrainMiner;
	/** Write the snapshot now (shutdown). Never throws; errors go to `onError`. */
	save(): void;
	/** Stop the periodic save. */
	stop(): void;
}

/**
 * Create the miner, restore the last snapshot, give it to the indexer, and save every interval.
 * The timer is unref'd, so it never keeps a process alive.
 */
export function attachLogPatternMiner(
	indexer: { setPatternMiner(miner: DrainMiner | null): void },
	dataDir: string,
	options: { intervalMs?: number; onError?: (error: unknown) => void; miner?: DrainMiner } = {},
): LogPatternMinerHandle {
	const path = logPatternSnapshotPath(dataDir);
	const miner = options.miner ?? new DrainMiner();
	restoreLogPatternSnapshot(miner, path);
	indexer.setPatternMiner(miner);
	const save = (): void => {
		try {
			saveLogPatternSnapshot(miner, path);
		} catch (error) {
			options.onError?.(error);
		}
	};
	const timer = setInterval(save, options.intervalMs ?? LOG_PATTERN_SNAPSHOT_INTERVAL_MS);
	timer.unref?.();
	return { miner, save, stop: () => clearInterval(timer) };
}
