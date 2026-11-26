import { describe, expect, test } from 'bun:test';
import type { HelperLogEntry } from './helper-client.ts';
import {
	classifyLogContinuation,
	joinMultilineEntries,
	MULTILINE_MAX_CHARS,
	parseJoinedLogMessage,
} from './log-drain.ts';

const T0 = 1_700_000_000_000;

/** One entry per line, 1 ms apart, on stdout (priority 6) unless the line says otherwise. */
function entries(lines: string[], options: { priority?: number; stepMs?: number; start?: number } = {}): HelperLogEntry[] {
	const step = options.stepMs ?? 1;
	return lines.map((message, index) => ({
		cursor: `s=${(options.start ?? 0) + index + 1}`,
		ts: T0 + index * step,
		priority: options.priority ?? 6,
		message,
	}));
}

function messages(result: HelperLogEntry[]): string[] {
	return result.map((entry) => entry.message);
}

describe('classifyLogContinuation', () => {
	test('recognises frames, causes and traceback parts', () => {
		expect(classifyLogContinuation('\tat com.example.Main.run(Main.java:10)', false)).toBe('join');
		expect(classifyLogContinuation('    at handler (/app/index.js:4:11)', false)).toBe('join');
		expect(classifyLogContinuation('  File "/app/main.py", line 3, in <module>', false)).toBe('join');
		expect(classifyLogContinuation('\t... 12 more', false)).toBe('join');
		expect(classifyLogContinuation('Caused by: java.io.IOException: closed', false)).toBe('join');
		expect(classifyLogContinuation('Traceback (most recent call last):', false)).toBe('join-traceback');
		expect(classifyLogContinuation('ValueError: boom', true)).toBe('end-traceback');
		expect(
			classifyLogContinuation('During handling of the above exception, another exception occurred:', true),
		).toBe('join');
	});

	test('leaves ordinary lines alone', () => {
		expect(classifyLogContinuation('GET /health 200 1ms', false)).toBe('new');
		expect(classifyLogContinuation('ValueError: boom', false)).toBe('new');
		expect(classifyLogContinuation('   ', false)).toBe('new');
		expect(classifyLogContinuation('', false)).toBe('new');
		expect(classifyLogContinuation('[INFO] at the start', false)).toBe('new');
	});
});

describe('joinMultilineEntries', () => {
	test('joins a Java stack trace with causes and an elided frame count', () => {
		const result = joinMultilineEntries(
			entries(
				[
					'Exception in thread "main" java.lang.IllegalStateException: boom',
					'\tat com.example.Main.run(Main.java:10)',
					'\tat com.example.Main.main(Main.java:4)',
					'Caused by: java.io.IOException: closed',
					'\tat com.example.Io.read(Io.java:7)',
					'\t... 2 more',
					'next request handled',
				],
				{ priority: 3 },
			),
		);
		expect(result).toHaveLength(2);
		expect(result[0]!.message.split('\n')).toHaveLength(6);
		expect(result[0]).toMatchObject({ cursor: 's=6', ts: T0, priority: 3 });
		expect(result[1]).toEqual({ cursor: 's=7', ts: T0 + 6, priority: 3, message: 'next request handled' });
	});

	test('joins a Node error and its frames', () => {
		const result = joinMultilineEntries(
			entries([
				'TypeError: Cannot read properties of undefined (reading "id")',
				'    at handler (/app/index.js:4:11)',
				'    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
				'listening on :3000',
			]),
		);
		expect(messages(result)).toEqual([
			'TypeError: Cannot read properties of undefined (reading "id")\n    at handler (/app/index.js:4:11)\n    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
			'listening on :3000',
		]);
	});

	test('joins a Python traceback through its final exception line and chained banners', () => {
		const result = joinMultilineEntries(
			entries(
				[
					'ERROR:app:request failed',
					'Traceback (most recent call last):',
					'  File "/app/main.py", line 3, in <module>',
					'    run()',
					'KeyError: \'id\'',
					'',
					'During handling of the above exception, another exception occurred:',
					'worker restarted',
				].filter((line) => line !== ''),
				{ priority: 3 },
			),
		);
		expect(messages(result)).toEqual([
			"ERROR:app:request failed\nTraceback (most recent call last):\n  File \"/app/main.py\", line 3, in <module>\n    run()\nKeyError: 'id'",
			'During handling of the above exception, another exception occurred:',
			'worker restarted',
		]);
	});

	test('a bare traceback header still collects its own frames', () => {
		const result = joinMultilineEntries(
			entries(['Traceback (most recent call last):', '  File "x.py", line 1', 'ZeroDivisionError: division by zero', 'ok']),
		);
		expect(messages(result)).toEqual([
			'Traceback (most recent call last):\n  File "x.py", line 1\nZeroDivisionError: division by zero',
			'ok',
		]);
	});

	test('never joins across a gap of more than one second', () => {
		const result = joinMultilineEntries(entries(['Error: boom', '    at a (x.js:1:1)'], { stepMs: 1_500 }));
		expect(result).toHaveLength(2);
		const close = joinMultilineEntries(entries(['Error: boom', '    at a (x.js:1:1)'], { stepMs: 1_000 }));
		expect(close).toHaveLength(1);
	});

	test('never joins stdout to stderr', () => {
		const input = [
			{ cursor: 's=1', ts: T0, priority: 3, message: 'Error: boom' },
			{ cursor: 's=2', ts: T0 + 1, priority: 6, message: '  stdout detail' },
		];
		expect(joinMultilineEntries(input)).toEqual(input);
	});

	test('keeps the most severe priority of the joined lines', () => {
		const result = joinMultilineEntries([
			{ cursor: 's=1', ts: T0, priority: 6, message: 'warning: deprecated call' },
			{ cursor: 's=2', ts: T0 + 1, priority: 5, message: '  at old()' },
		]);
		expect(result).toEqual([{ cursor: 's=2', ts: T0, priority: 5, message: 'warning: deprecated call\n  at old()' }]);
	});

	test('caps a record at 200 lines and starts a new one', () => {
		const lines = ['Error: deep', ...Array.from({ length: 450 }, (_, index) => `    at f${index} (x.js:1:1)`)];
		const result = joinMultilineEntries(entries(lines, { stepMs: 0 }));
		expect(result.map((entry) => entry.message.split('\n').length)).toEqual([200, 200, 51]);
		expect(result.at(-1)!.cursor).toBe('s=451');
	});

	test('caps a record at 16 KiB', () => {
		const frame = `    at ${'x'.repeat(1_000)}`;
		const result = joinMultilineEntries(entries(['Error: wide', ...Array.from({ length: 40 }, () => frame)], { stepMs: 0 }));
		expect(result.length).toBeGreaterThan(1);
		for (const entry of result) expect(entry.message.length).toBeLessThanOrEqual(MULTILINE_MAX_CHARS);
		expect(result.reduce((sum, entry) => sum + entry.message.split('\n').length, 0)).toBe(41);
	});

	test('flushes at the end of the batch and leaves single lines untouched', () => {
		const input = entries(['one', 'two', '  indented continuation']);
		const result = joinMultilineEntries(input);
		expect(messages(result)).toEqual(['one', 'two\n  indented continuation']);
		expect(result[0]).toEqual(input[0]!);
		expect(joinMultilineEntries([])).toEqual([]);
	});

	test('a continuation at the start of a batch ships on its own', () => {
		expect(messages(joinMultilineEntries(entries(['    at tail (x.js:1:1)', 'next'])))).toEqual([
			'    at tail (x.js:1:1)',
			'next',
		]);
	});
});

describe('parseJoinedLogMessage', () => {
	test('parses the first line and keeps the frames verbatim', () => {
		const parsed = parseJoinedLogMessage('{"level":"error","msg":"boom"}\n    at a (x.js:1:1)');
		expect(parsed.level).toBe('error');
		expect(parsed.message).toBe('boom\n    at a (x.js:1:1)');
	});

	test('is plain parseLogLine for a single line', () => {
		expect(parseJoinedLogMessage('level=warn msg="slow request"').message).toBe('slow request');
	});
});
