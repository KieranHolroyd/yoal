import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeLogBatchSchema, PLATFORM_LOG_UNIT_NAMES, type NodeLogBatch, type PlatformLogUnit } from '@yoal/contracts';
import { PLATFORM_LOG_UNITS } from '../../helper/src/platform-logs.ts';
import type { HelperLogEntry, HelperLogResult, LogReadOptions } from './helper-client.ts';
import { PlatformLogDrain, platformLogRecords, type PlatformLogReader } from './platform-log-drain.ts';

const T0 = 1_700_000_000_000;
const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function statePath(): Promise<string> {
	const dir = await fs.mkdtemp(join(tmpdir(), 'yoal-platform-logs-'));
	directories.push(dir);
	return join(dir, 'state', 'platform-log-cursors.json');
}

/** A journal per unit: entries after the cursor, `lines` at a time (journalctl -n with --after-cursor). */
class FakeJournal implements PlatformLogReader {
	journal = new Map<PlatformLogUnit, HelperLogEntry[]>();
	reads: Array<{ unit: PlatformLogUnit; cursor?: string; lines?: number }> = [];
	fail = new Set<PlatformLogUnit>();

	add(unit: PlatformLogUnit, messages: string[], priority = 6): void {
		const list = this.journal.get(unit) ?? [];
		for (const message of messages)
			list.push({ cursor: `${unit}:${list.length + 1}`, ts: T0 + list.length * 2_000, priority, message });
		this.journal.set(unit, list);
	}

	async platformLogs(unit: PlatformLogUnit, options: LogReadOptions = {}): Promise<HelperLogResult> {
		this.reads.push({ unit, ...options });
		if (this.fail.has(unit)) throw new Error('helper 404: not_found');
		const list = this.journal.get(unit) ?? [];
		const from = options.cursor ? list.findIndex((entry) => entry.cursor === options.cursor) + 1 : Math.max(0, list.length - (options.lines ?? 200));
		const entries = list.slice(from, from + (options.lines ?? 200));
		return { entries, nextCursor: entries.at(-1)?.cursor ?? options.cursor ?? null };
	}
}

interface ControlPlane {
	batches: NodeLogBatch[];
	status: number;
	disabled: boolean;
	fetch: typeof fetch;
}

function controlPlane(): ControlPlane {
	const plane: ControlPlane = {
		batches: [],
		status: 200,
		disabled: false,
		fetch: (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			expect(String(input)).toBe('https://control.test/api/agent/log-records');
			expect(new Headers(init?.headers).get('authorization')).toBe('Bearer node-token');
			const batch = nodeLogBatchSchema.parse(JSON.parse(String(init?.body)));
			if (plane.status !== 200) return new Response('down', { status: plane.status });
			plane.batches.push(batch);
			if (plane.disabled) return Response.json({ ok: true, stored: 0, disabled: true });
			return Response.json({ ok: true, stored: batch.records.length });
		}) as unknown as typeof fetch,
	};
	return plane;
}

function drain(helper: PlatformLogReader, plane: ControlPlane, path: string, units?: PlatformLogUnit[]): PlatformLogDrain {
	return new PlatformLogDrain({
		helper,
		controlUrl: 'https://control.test/',
		nodeToken: 'node-token',
		statePath: path,
		...(units ? { units } : {}),
		fetch: plane.fetch,
		sleep: async () => undefined,
	});
}

describe('platform log allow-list', () => {
	test('the helper maps exactly the contract keys', () => {
		expect(Object.keys(PLATFORM_LOG_UNITS).sort()).toEqual([...PLATFORM_LOG_UNIT_NAMES].sort());
	});
});

describe('platformLogRecords', () => {
	test('maps priority, declared level and time, and joins multi-line output', () => {
		const records = platformLogRecords('yoal-control-plane', [
			{ cursor: 'c1', ts: T0, priority: 3, message: 'Error: database is locked' },
			{ cursor: 'c2', ts: T0 + 1, priority: 3, message: '    at run (core.js:1:1)' },
			{ cursor: 'c3', ts: T0 + 5_000, priority: 6, message: '{"level":"warn","time":1700000000123,"msg":"slow tick"}' },
			{ cursor: 'c4', ts: T0 + 6_000, priority: 2, message: 'out of memory' },
			{ cursor: 'c5', ts: T0 + 7_000, priority: 7, message: 'tick' },
		]);
		expect(records).toEqual([
			{
				ts: T0,
				source: 'platform',
				severityNumber: 17,
				body: 'Error: database is locked\n    at run (core.js:1:1)',
				attributes: {},
				resource: { 'service.name': 'yoal-control-plane' },
				channel: 'stderr',
			},
			expect.objectContaining({ ts: 1_700_000_000_123, severityNumber: 13, body: 'slow tick', channel: 'stdout' }),
			expect.objectContaining({ severityNumber: 21, body: 'out of memory', channel: 'stderr' }),
			expect.objectContaining({ severityNumber: 5, body: 'tick' }),
		]);
		for (const record of records) expect(() => nodeLogBatchSchema.parse({ target: { kind: 'platform', unit: 'caddy' }, records: [record] })).not.toThrow();
	});
});

describe('PlatformLogDrain', () => {
	test('posts one batch per unit with new lines and persists each cursor', async () => {
		const helper = new FakeJournal();
		helper.add('yoal-agent', ['agent up', 'reconciled 3 workloads']);
		helper.add('caddy', ['certificate renewed'], 4);
		const plane = controlPlane();
		const path = await statePath();
		const client = drain(helper, plane, path);

		expect(await client.drain()).toBe(3);
		expect(plane.batches.map((batch) => batch.target)).toEqual([
			{ kind: 'platform', unit: 'yoal-agent' },
			{ kind: 'platform', unit: 'caddy' },
		]);
		expect(plane.batches[0]!.records.map((record) => record.body)).toEqual(['agent up', 'reconciled 3 workloads']);
		// Every allow-listed unit is read; the ones not installed here read empty and post nothing.
		expect(new Set(helper.reads.map((read) => read.unit))).toEqual(new Set(PLATFORM_LOG_UNIT_NAMES));
		expect(JSON.parse(await fs.readFile(path, 'utf8'))).toEqual({
			version: 1,
			cursors: { 'yoal-agent': 'yoal-agent:2', caddy: 'caddy:1' },
		});

		// Nothing new: no posts, the reads resume after the stored cursors.
		helper.reads = [];
		expect(await client.drain()).toBe(0);
		expect(plane.batches).toHaveLength(2);
		expect(helper.reads.find((read) => read.unit === 'yoal-agent')?.cursor).toBe('yoal-agent:2');
	});

	test('a restart resumes from the persisted cursors instead of re-shipping', async () => {
		const helper = new FakeJournal();
		helper.add('yoal-helper', ['one', 'two']);
		const path = await statePath();
		const first = controlPlane();
		await drain(helper, first, path, ['yoal-helper']).drain();
		expect(first.batches).toHaveLength(1);

		helper.add('yoal-helper', ['three']);
		const second = controlPlane();
		const restarted = drain(helper, second, path, ['yoal-helper']);
		expect(await restarted.drain()).toBe(1);
		expect(second.batches[0]!.records.map((record) => record.body)).toEqual(['three']);
		expect(restarted.cursorFor('yoal-helper')).toBe('yoal-helper:3');
	});

	test('does not move a cursor when the control plane rejects the batch', async () => {
		const helper = new FakeJournal();
		helper.add('yoal-agent', ['lost?']);
		const plane = controlPlane();
		plane.status = 502;
		const path = await statePath();
		const client = drain(helper, plane, path, ['yoal-agent']);
		await expect(client.drain()).rejects.toThrow('platform log drain -> 502');
		expect(client.cursorFor('yoal-agent')).toBeNull();
		await expect(fs.readFile(path, 'utf8')).rejects.toThrow();

		plane.status = 200;
		expect(await client.drain()).toBe(1);
		expect(plane.batches[0]!.records[0]!.body).toBe('lost?');
	});

	test('pages through a busy unit within one tick', async () => {
		const helper = new FakeJournal();
		const path = await statePath();
		const plane = controlPlane();
		const client = drain(helper, plane, path, ['yoal-control-plane']);
		// Seed a cursor so the drain reads forward from it rather than from the tail.
		helper.add('yoal-control-plane', ['seed']);
		await client.drain();
		helper.add('yoal-control-plane', Array.from({ length: 450 }, (_, index) => `request ${index}`));
		plane.batches = [];
		expect(await client.drain()).toBe(450);
		expect(plane.batches.map((batch) => batch.records.length)).toEqual([200, 200, 50]);
		expect(client.cursorFor('yoal-control-plane')).toBe('yoal-control-plane:451');
	});

	test('warns once per distinct error and keeps draining the readable units', async () => {
		const helper = new FakeJournal();
		helper.fail.add('yoal-agent');
		helper.fail.add('yoal-helper');
		helper.add('caddy', ['ok']);
		const plane = controlPlane();
		const warnings: string[] = [];
		const client = new PlatformLogDrain({
			helper,
			controlUrl: 'https://control.test',
			nodeToken: 'node-token',
			statePath: await statePath(),
			units: ['yoal-agent', 'yoal-helper', 'caddy'],
			fetch: plane.fetch,
			log: (_level, message) => warnings.push(message),
		});
		expect(await client.drain()).toBe(1);
		await client.drain();
		expect(warnings).toEqual(['Could not read platform logs (yoal-agent): helper 404: not_found']);
		// Once every unit reads again, a new failure is reported again.
		helper.fail.clear();
		await client.drain();
		helper.fail.add('yoal-helper');
		await client.drain();
		expect(warnings).toHaveLength(2);
	});

	test('the PLATFORM_LOGS kill switch stops reading and probes until it is back on', async () => {
		const helper = new FakeJournal();
		helper.add('yoal-agent', ['first']);
		const plane = controlPlane();
		plane.disabled = true;
		const path = await statePath();
		const client = drain(helper, plane, path, ['yoal-agent', 'caddy']);

		expect(await client.drain()).toBe(0);
		expect(client.isDisabled).toBe(true);
		// The discarded batch did not move the cursor, and the second unit was not read.
		expect(client.cursorFor('yoal-agent')).toBeNull();
		expect(helper.reads.map((read) => read.unit)).toEqual(['yoal-agent']);

		helper.reads = [];
		plane.batches = [];
		expect(await client.drain()).toBe(0);
		expect(helper.reads).toEqual([]);
		expect(plane.batches).toEqual([{ target: { kind: 'platform', unit: 'yoal-agent' }, records: [], dropped: 0 }]);

		plane.disabled = false;
		plane.batches = [];
		expect(await client.drain()).toBe(1);
		expect(client.isDisabled).toBe(false);
		expect(plane.batches.at(-1)!.records[0]!.body).toBe('first');
	});

	test('a corrupt cursor file starts from the journal tail', async () => {
		const path = await statePath();
		await fs.mkdir(join(path, '..'), { recursive: true });
		await fs.writeFile(path, '{not json');
		const helper = new FakeJournal();
		helper.add('yoal-mail', ['queued']);
		const plane = controlPlane();
		expect(await drain(helper, plane, path, ['yoal-mail']).drain()).toBe(1);
		expect(JSON.parse(await fs.readFile(path, 'utf8')).cursors).toEqual({ 'yoal-mail': 'yoal-mail:1' });
	});
});
