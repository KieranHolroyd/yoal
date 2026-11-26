import { describe, expect, test } from 'bun:test';
import type { LogRecord } from '@yoal/contracts';
import { collectForExport, csvCell, exportFilename, toCsv, toNdjson } from './export';

function record(id: number, overrides: Partial<LogRecord> = {}): LogRecord {
	return {
		id: `le:${id}`,
		ts: Date.UTC(2026, 10, 25, 14, 2, 11, 204) + id,
		observedTs: null,
		orgId: 'org_1',
		scope: { kind: 'project', id: 'prj_1' },
		scopeName: 'api',
		stream: 'deployment:dep_1',
		source: 'runtime',
		channel: 'stdout',
		severityNumber: 9,
		severity: 'info',
		body: `line ${id}`,
		attributes: {},
		resource: {},
		traceId: null,
		spanId: null,
		requestId: null,
		patternId: null,
		projectId: 'prj_1',
		deploymentId: 'dep_1',
		buildId: null,
		jobRunId: null,
		nodeId: null,
		replica: 0,
		...overrides
	};
}

describe('NDJSON export', () => {
	test('one record per line, parseable', () => {
		const text = toNdjson([record(1), record(2)]);
		const lines = text.trimEnd().split('\n');
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[1]!).id).toBe('le:2');
		expect(text.endsWith('\n')).toBe(true);
	});

	test('empty input is empty output', () => {
		expect(toNdjson([])).toBe('');
	});
});

describe('CSV export', () => {
	test('header and rows', () => {
		const text = toCsv([record(1, { requestId: 'req_1', attributes: { 'http.status': '502' } })]);
		const [header, row] = text.split('\r\n');
		expect(header).toBe(
			'ts,severity,scope,service,stream,source,channel,body,request_id,trace_id,attributes'
		);
		expect(row).toBe(
			'2026-11-25T14:02:11.205Z,info,project:prj_1,api,deployment:dep_1,runtime,stdout,line 1,req_1,,"{""http.status"":""502""}"'
		);
	});

	test('quotes commas, quotes and newlines', () => {
		expect(csvCell('a,b')).toBe('"a,b"');
		expect(csvCell('say "hi"')).toBe('"say ""hi"""');
		expect(csvCell('two\nlines')).toBe('"two\nlines"');
		expect(csvCell(null)).toBe('');
		expect(csvCell(42)).toBe('42');
	});

	test('guards against formula injection', () => {
		expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
		expect(csvCell('+1')).toBe("'+1");
		expect(csvCell('-rf')).toBe("'-rf");
		expect(csvCell('@sum')).toBe("'@sum");
		// Numbers are numbers, not formulas.
		expect(csvCell(-1)).toBe('-1');
	});

	test('ANSI escapes are stripped from bodies', () => {
		const text = toCsv([record(1, { body: '\u001b[31mred\u001b[0m' })]);
		expect(text).toContain(',red,');
	});
});

describe('collecting pages for export', () => {
	test('follows `older` cursors until they run out, de-duplicating', async () => {
		const pages: Record<
			string,
			{ records: LogRecord[]; cursor: { older: string | null; newer: null } }
		> = {
			start: { records: [record(3), record(2)], cursor: { older: 'c1', newer: null } },
			c1: { records: [record(2), record(1)], cursor: { older: null, newer: null } }
		};
		const calls: Array<string | undefined> = [];
		const result = await collectForExport(async (cursor) => {
			calls.push(cursor);
			return pages[cursor ?? 'start']!;
		});
		expect(calls).toEqual([undefined, 'c1']);
		expect(result.records.map((item) => item.id)).toEqual(['le:3', 'le:2', 'le:1']);
		expect(result.capped).toBe(false);
	});

	test('stops at the cap', async () => {
		let n = 0;
		const progress: number[] = [];
		const result = await collectForExport(
			async (_cursor, limit) => {
				const records = Array.from({ length: limit }, () => record(++n));
				return { records, cursor: { older: `c${n}`, newer: null } };
			},
			{ cap: 25, pageSize: 10, onProgress: (count) => progress.push(count) }
		);
		expect(result.records).toHaveLength(25);
		expect(result.capped).toBe(true);
		expect(progress).toEqual([10, 20, 25]);
	});

	test('never exceeds 100,000 rows whatever cap is asked for', async () => {
		let pages = 0;
		const result = await collectForExport(
			async (_cursor, limit) => {
				pages++;
				return {
					records: Array.from({ length: limit }, (_, i) => record(pages * 1_000_000 + i)),
					cursor: { older: `p${pages}`, newer: null }
				};
			},
			{ cap: 1_000_000, pageSize: 1_000 }
		);
		expect(result.records).toHaveLength(100_000);
		expect(pages).toBe(100);
	});

	test('a repeated cursor ends the loop', async () => {
		let calls = 0;
		const result = await collectForExport(async () => {
			calls++;
			return { records: [record(calls)], cursor: { older: 'same', newer: null } };
		});
		expect(calls).toBe(2);
		expect(result.records).toHaveLength(2);
	});

	test('cancellation rejects', async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			collectForExport(async () => ({ records: [], cursor: { older: null, newer: null } }), {
				signal: controller.signal
			})
		).rejects.toThrow('Export cancelled');
	});
});

describe('export filename', () => {
	test('is safe and stamped', () => {
		expect(exportFilename('api logs / prod', 'ndjson', Date.UTC(2026, 10, 25, 14, 2))).toBe(
			'api-logs-prod-20261125T1402Z.ndjson'
		);
		expect(exportFilename('', 'csv', 0)).toBe('logs-19700101T0000Z.csv');
	});
});
