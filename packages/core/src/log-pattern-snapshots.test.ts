import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	attachLogPatternMiner,
	logPatternSnapshotPath,
	restoreLogPatternSnapshot,
	saveLogPatternSnapshot,
} from './log-pattern-snapshots.ts';
import { DrainMiner } from './log-patterns.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-log-patterns-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('pattern miner snapshots', () => {
	test('a saved snapshot restores the same templates and ids', () => {
		const path = join(dir, 'a', 'log-patterns.json');
		const miner = new DrainMiner();
		const first = miner.patternFor('org_1:project:prj_1', 'GET /v1/orders 502 1234ms');
		miner.patternFor('org_1:project:prj_1', 'GET /v1/orders 200 12ms');
		expect(saveLogPatternSnapshot(miner, path)).toBe(true);
		const warm = new DrainMiner();
		expect(restoreLogPatternSnapshot(warm, path)).toBeGreaterThan(0);
		expect(warm.templates('org_1:project:prj_1')).toEqual(miner.templates('org_1:project:prj_1'));
		expect(warm.patternFor('org_1:project:prj_1', 'GET /v1/orders 404 9ms').id).toBe(miner.templates('org_1:project:prj_1')[0]!.id);
		expect(first.id).toMatch(/^[0-9a-f]{16}$/);
	});

	test('an empty miner never overwrites a snapshot; a bad file is a cold start', () => {
		const path = join(dir, 'b.json');
		writeFileSync(path, '{"version":1,"scopes":[{"key":"k","templates":[{"template":"a <NUM>","count":2}]}]}');
		expect(saveLogPatternSnapshot(new DrainMiner(), path)).toBe(false);
		expect(readFileSync(path, 'utf8')).toContain('a <NUM>');
		writeFileSync(path, 'not json');
		expect(restoreLogPatternSnapshot(new DrainMiner(), path)).toBe(0);
		expect(restoreLogPatternSnapshot(new DrainMiner(), join(dir, 'missing.json'))).toBe(0);
	});

	test('attach restores, hands the miner to the indexer and saves on demand', () => {
		const data = join(dir, 'data');
		const seed = new DrainMiner();
		seed.patternFor('s', 'worker 7 started');
		saveLogPatternSnapshot(seed, logPatternSnapshotPath(data));
		const injected: unknown[] = [];
		const handle = attachLogPatternMiner({ setPatternMiner: (miner) => injected.push(miner) }, data, { intervalMs: 60_000 });
		try {
			expect(injected).toEqual([handle.miner]);
			expect(handle.miner.stats().templates).toBe(1);
			handle.miner.patternFor('s', 'completely different line shape here');
			handle.save();
			const reloaded = new DrainMiner();
			restoreLogPatternSnapshot(reloaded, logPatternSnapshotPath(data));
			expect(reloaded.stats().templates).toBe(2);
			expect(existsSync(`${logPatternSnapshotPath(data)}.${process.pid}.tmp`)).toBe(false);
		} finally {
			handle.stop();
		}
	});
});
