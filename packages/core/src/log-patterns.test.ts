import { describe, expect, test } from 'bun:test';
import { DrainMiner, LOG_PATTERN_PLACEHOLDERS, logPatternId, maskLogLine, type DrainMinerSnapshot, type LogPatternMiner } from './log-patterns.ts';

/** Reference FNV-1a 64 with BigInt, to check the limb implementation. */
function fnv1a64(text: string): string {
	let h = 0xcbf29ce484222325n;
	for (const byte of new TextEncoder().encode(text)) {
		h ^= BigInt(byte);
		h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
	}
	return h.toString(16).padStart(16, '0');
}

describe('maskLogLine (LOGS.md §8.1)', () => {
	const cases: [string, string][] = [
		['GET /api/v1/users/42 200 12ms', 'GET <PATH> <NUM> <DUR>'],
		['took 1.2s then 250µs then 1h30m', 'took <DUR> then <DUR> then <DUR>'],
		['id=550e8400-e29b-41d4-a716-446655440000 done', 'id=<UUID> done'],
		['commit 3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39', 'commit <HEX>'],
		['ptr 0xdeadbeef and 0x1f', 'ptr <HEX> and <HEX>'],
		['hash deadbeefcafe but abcdef1234', 'hash deadbeefcafe but <HEX>'],
		['from 10.0.0.1:443 and 192.168.1.20', 'from <IP> and <IP>'],
		['bind [::1]:5432 and fe80::1 and 2001:db8:0:0:0:0:0:1', 'bind [<IP>]:<NUM> and <IP> and <IP>'],
		['at 2026-11-25T10:00:00.123Z', 'at <TS>'],
		['at 2026-11-25 10:00:01,123 and 2026-11-25', 'at <TS> and <TS>'],
		['clock 10:00:00.5 only', 'clock <TS> only'],
		['[25/Nov/2026:14:02:11 +0000] "GET / HTTP/1.1"', '[<TS>] <STR>'],
		['mail alice@example.com now', 'mail <EMAIL> now'],
		['open https://example.com/a/b?c=d now', 'open <PATH> now'],
		['read /var/log/app.log and ./src/app.ts but /health', 'read <PATH> and <PATH> but /health'],
		["can't open 'config.yml'", "can't open <STR>"],
		['say "hello world" twice', 'say <STR> twice'],
		['{"level":"info","n":3}', '{"level":<STR>,"n":<NUM>}'],
		['heap 512MB/1024MB 40% -5 3.5e10', 'heap <NUM>/<NUM> <NUM> <NUM> <NUM>'],
		['node-3 v1.2.3 user42 std::vector', 'node-<NUM> v1.2.3 user42 std::vector'],
		['no variables here at all', 'no variables here at all'],
	];
	for (const [input, expected] of cases) test(input, () => expect(maskLogLine(input)).toBe(expected));

	test('only documented placeholders appear', () => {
		const masked = maskLogLine('a 1 0xff 550e8400-e29b-41d4-a716-446655440000 1.1.1.1 5ms 2026-01-01 "x" /a/b b@c.io');
		for (const token of masked.match(/<[A-Z*]+>/g) ?? []) expect(LOG_PATTERN_PLACEHOLDERS).toContain(token as never);
	});
});

describe('logPatternId', () => {
	test('is FNV-1a 64 over UTF-8, as 16 hex characters', () => {
		expect(logPatternId('')).toBe('cbf29ce484222325');
		expect(logPatternId('a')).toBe('af63dc4c8601ec8c');
		expect(logPatternId('foobar')).toBe('85944171f73967e8');
		for (const s of ['GET <PATH> <NUM> <DUR>', 'héllo wörld 🚀 <*>', 'x'.repeat(5000), '\u0000￿']) {
			expect(logPatternId(s)).toBe(fnv1a64(s));
			expect(logPatternId(s)).toMatch(/^[0-9a-f]{16}$/);
		}
	});
});

describe('DrainMiner', () => {
	test('lines that differ only in variables share one template', () => {
		const miner = new DrainMiner();
		const a = miner.patternFor('s', 'GET /api/v1/orders/1 200 12ms');
		const b = miner.patternFor('s', 'GET /api/v1/users/99 404 3ms');
		expect(a.template).toBe('GET <PATH> <NUM> <DUR>');
		expect(b.id).toBe(a.id);
		expect(a.isNew).toBe(true);
		expect(b.isNew).toBe(false);
	});

	test('differing literal tokens become <*> and the id follows the template', () => {
		const miner = new DrainMiner();
		const a = miner.patternFor('s', 'retrying call to payment-svc attempt 1 after 100ms');
		const b = miner.patternFor('s', 'retrying call to auth attempt 2 after 50ms');
		expect(b.template).toBe('retrying call to <*> attempt <NUM> after <DUR>');
		expect(b.isNew).toBe(true);
		expect(b.id).toBe(logPatternId(b.template));
		expect(b.id).not.toBe(a.id);
		const c = miner.patternFor('s', 'retrying call to search attempt 3 after 10ms');
		expect(c.id).toBe(b.id);
		expect(c.isNew).toBe(false);
	});

	test('dissimilar lines of the same length stay separate (similarity 0.4)', () => {
		const miner = new DrainMiner();
		const a = miner.patternFor('s', 'user logged in successfully today');
		const b = miner.patternFor('s', 'user payment failed card declined');
		expect(a.id).not.toBe(b.id);
		expect(miner.templates('s')).toHaveLength(2);
	});

	test('different token counts never merge', () => {
		const miner = new DrainMiner();
		const a = miner.patternFor('s', 'cache miss for key');
		const b = miner.patternFor('s', 'cache miss for key again');
		expect(a.id).not.toBe(b.id);
	});

	test('the first tokens route the tree: a different first word is a different template', () => {
		const miner = new DrainMiner();
		const get = miner.patternFor('s', 'GET /a/b 200 1ms');
		const post = miner.patternFor('s', 'POST /a/b 200 1ms');
		expect(get.id).not.toBe(post.id);
	});

	test('ids are stable across miners, scopes and restarts', () => {
		const one = new DrainMiner().patternFor('a', 'worker 3 started on 10.0.0.1:8080');
		const two = new DrainMiner().patternFor('b', 'worker 7 started on 10.0.0.9:9090');
		expect(one.id).toBe(two.id);
		expect(one.template).toBe('worker <NUM> started on <IP>');
	});

	test('scopes are independent', () => {
		const miner = new DrainMiner();
		miner.patternFor('a', 'alpha beta gamma delta');
		miner.patternFor('b', 'alpha beta zeta delta');
		expect(miner.templates('a')[0]!.template).toBe('alpha beta gamma delta');
		expect(miner.templates('b')[0]!.template).toBe('alpha beta zeta delta');
		expect(miner.stats()).toEqual({ scopes: 2, templates: 2 });
	});

	test('multiline records are mined on their first line; Python tracebacks on the exception', () => {
		const miner = new DrainMiner();
		const a = miner.patternFor('s', "TypeError: Cannot read properties of undefined (reading 'id')\n    at f (/app/a.ts:1:2)");
		const b = miner.patternFor('s', "TypeError: Cannot read properties of undefined (reading 'name')\n    at g (/app/b.ts:9:9)\n    at h");
		expect(b.id).toBe(a.id);
		const py = miner.patternFor('s', 'Traceback (most recent call last):\n  File "/app/w.py", line 3, in run\n    x()\nKeyError: \'user_id\'\n');
		expect(py.template).toBe('KeyError: <STR>');
	});

	test('empty and whitespace bodies have a template too', () => {
		const miner = new DrainMiner();
		const a = miner.patternFor('s', '');
		const b = miner.patternFor('s', '   ');
		expect(a.template).toBe('');
		expect(b.id).toBe(a.id);
	});

	test('very long lines are capped (tokens and characters)', () => {
		const miner = new DrainMiner({ maxTokens: 10 });
		const line = Array.from({ length: 50 }, (_, i) => `w${String.fromCharCode(97 + (i % 26))}`).join(' ');
		const r = miner.patternFor('s', line);
		expect(r.template.split(' ')).toHaveLength(10);
		expect(r.template.endsWith('<*>')).toBe(true);
		const huge = new DrainMiner().patternFor('s', 'z'.repeat(100_000));
		expect(huge.template.length).toBe(2048);
	});

	test('a full node sends new tokens to <*> (maxChildren)', () => {
		const miner = new DrainMiner({ maxChildren: 3 });
		const templates = new Set<string>();
		for (const word of ['alpha', 'bravo', 'charlie', 'delta', 'echo'])
			templates.add(miner.patternFor('s', `${word} event happened here now`).template);
		// alpha and bravo get children; the rest share the wildcard branch and merge there.
		expect(templates.has('alpha event happened here now')).toBe(true);
		expect(templates.has('<*> event happened here now')).toBe(true);
	});

	test('per-scope LRU evicts the least recently used template', () => {
		const miner = new DrainMiner({ maxTemplatesPerScope: 2 });
		const a = miner.patternFor('s', 'first kind of line here');
		miner.patternFor('s', 'second sort of message entirely');
		miner.patternFor('s', 'first kind of line here'); // touch a
		miner.patternFor('s', 'third unrelated words appear now');
		const ids = miner.templates('s').map((t) => t.id);
		expect(ids).toHaveLength(2);
		expect(ids).toContain(a.id);
		expect(miner.templates('s').map((t) => t.template)).not.toContain('second sort of message entirely');
	});

	test('scope LRU drops the least recently used scope', () => {
		const miner = new DrainMiner({ maxScopes: 2 });
		miner.patternFor('a', 'x y z');
		miner.patternFor('b', 'x y z');
		miner.patternFor('a', 'x y z');
		miner.patternFor('c', 'x y z');
		expect(miner.templates('b')).toEqual([]);
		expect(miner.templates('a')).toHaveLength(1);
		expect(miner.stats().scopes).toBe(2);
	});

	test('counts and recency order', () => {
		const miner = new DrainMiner();
		miner.patternFor('s', 'one two three');
		miner.patternFor('s', 'four five six seven');
		miner.patternFor('s', 'one two three');
		const list = miner.templates('s');
		expect(list[0]).toMatchObject({ template: 'one two three', count: 2 });
		expect(list[1]).toMatchObject({ template: 'four five six seven', count: 1 });
	});

	test('forget drops a scope', () => {
		const miner = new DrainMiner();
		miner.patternFor('s', 'a b c');
		miner.forget('s');
		expect(miner.templates('s')).toEqual([]);
	});

	test('snapshot and restore keep ids, counts and matching behaviour', () => {
		const miner = new DrainMiner();
		const lines = [
			'GET /api/v1/orders/1 200 12ms',
			'retrying call to payment-svc attempt 1 after 100ms',
			'retrying call to auth attempt 2 after 50ms',
			'user alice@example.com logged in from 10.0.0.1',
			'deployed commit 3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39 to production',
		];
		for (const line of lines) miner.patternFor('org:project:p1', line);
		miner.patternFor('org:project:p2', 'something else entirely here');
		const snapshot: DrainMinerSnapshot = JSON.parse(JSON.stringify(miner.snapshot()));
		const restored = new DrainMiner();
		restored.restore(snapshot);
		expect(restored.templates('org:project:p1')).toEqual(miner.templates('org:project:p1'));
		expect(restored.templates('org:project:p2')).toEqual(miner.templates('org:project:p2'));
		// A new line of a known shape lands on the restored template, not a new one.
		const next = restored.patternFor('org:project:p1', 'retrying call to search attempt 4 after 1ms');
		expect(next.isNew).toBe(false);
		expect(next.template).toBe('retrying call to <*> attempt <NUM> after <DUR>');
		const get = restored.patternFor('org:project:p1', 'GET /api/v1/users/7 500 99ms');
		expect(get.id).toBe(logPatternId('GET <PATH> <NUM> <DUR>'));
		expect(get.isNew).toBe(false);
	});

	test('restore ignores malformed snapshots and replaces named scopes', () => {
		const miner = new DrainMiner();
		miner.patternFor('s', 'old line here');
		miner.restore({ version: 2 } as unknown as DrainMinerSnapshot);
		miner.restore(null as unknown as DrainMinerSnapshot);
		expect(miner.templates('s')).toHaveLength(1);
		miner.restore({ version: 1, scopes: [{ key: 's', templates: [{ template: 'new <NUM> line', count: 5 }, { bad: 1 } as never] }] });
		expect(miner.templates('s')).toEqual([{ id: logPatternId('new <NUM> line'), template: 'new <NUM> line', count: 5 }]);
	});

	test('rejects a depth below 3', () => {
		expect(() => new DrainMiner({ depth: 2 })).toThrow(RangeError);
	});

	test('satisfies the PatternMiner interface the indexer injects', () => {
		const miner: LogPatternMiner = new DrainMiner();
		const result: { id: string; template: string } = miner.patternFor('s', 'hello 1');
		expect(result.id).toMatch(/^[0-9a-f]{16}$/);
	});

	test('a realistic mixed stream converges to a handful of templates', () => {
		const miner = new DrainMiner();
		const methods = ['GET', 'POST'];
		for (let i = 0; i < 2_000; i++) {
			miner.patternFor('s', `${methods[i % 2]} /api/v1/orders/${i} ${i % 3 ? 200 : 500} ${i % 97}ms`);
			miner.patternFor('s', `2026-11-25T10:00:${String(i % 60).padStart(2, '0')}Z INFO user u${i}@example.com logged in from 10.0.${i % 255}.1`);
			miner.patternFor('s', `slow query (${i}ms): SELECT * FROM orders WHERE id = ${i}`);
		}
		expect(miner.stats().templates).toBe(4);
	});
});
