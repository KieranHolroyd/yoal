import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseLogQuery } from '@yoal/contracts';
import { ASSISTANT_SYSTEM, LOG_QUERY_GUIDE } from './agents';
import { ASSISTANT_ONLY_TOOLS, CLOUD_SHELL_TOOL } from './constants';

const mcpSource = readFileSync(new URL('../mcp.ts', import.meta.url), 'utf8');
// Pipelines tools are declared in ../mcp-pipelines.ts and registered by mcp.ts in a loop.
const pipelineSource = readFileSync(new URL('../mcp-pipelines.ts', import.meta.url), 'utf8');
const pipelineToolNames = [...pipelineSource.matchAll(/\n\t\t\tname: '([a-z0-9_]+)',/g)].map(
	(match) => match[1]
);
const registered = new Set([
	...[...mcpSource.matchAll(/\n\ttool\(\n\t\t'([a-z0-9_]+)',/g)].map((match) => match[1]),
	...pipelineToolNames
]);
const gated = [...mcpSource.matchAll(/^\t([a-z_]+): '[a-zA-Z]+:[a-z-]+',?$/gm)].map(
	(match) => match[1]!
);

describe('assistant prompt', () => {
	test('every tool the prompt names is registered in the MCP catalog', () => {
		expect(registered.size).toBeGreaterThan(20);
		const named = new Set(
			[...ASSISTANT_SYSTEM.matchAll(/\b[a-z0-9]+(?:_[a-z0-9]+)+\b/g)].map((match) => match[0])
		);
		for (const name of ASSISTANT_ONLY_TOOLS) named.delete(name);
		expect(named.size).toBeGreaterThan(10);
		for (const name of named)
			expect({ name, registered: registered.has(name) }).toMatchObject({ registered: true });
	});

	test('the log query guide names registered tools and its examples parse (docs/LOGS.md §6)', () => {
		const grammarWords = new Set(['needs_clickhouse']);
		const named = [...LOG_QUERY_GUIDE.matchAll(/\b[a-z0-9]+(?:_[a-z0-9]+)+\b/g)]
			.map((match) => match[0])
			.filter((word) => !grammarWords.has(word));
		expect(named).toContain('query_logs');
		for (const name of named)
			expect({ name, registered: registered.has(name) }).toMatchObject({ registered: true });
		for (const example of [
			'timeout',
			'"connection reset"',
			'level:error',
			'level:=warn',
			'@http.status:>=500',
			'@path:/api/*',
			'@user.id:*',
			'@msg:/time(out|d out)/',
			'-term',
			'NOT term',
			'a OR b',
			'level:error | stats count() by bin(1m), service',
			'| fields ts, level, body',
			'| dedup body',
			'| patterns',
			'| stats count() by bin(5m), level | sort count desc | limit 20'
		])
			expect({ example, ok: parseLogQuery(example).ok }).toEqual({ example, ok: true });
		const link = /\(\/logs\?q=([^&)]+)/.exec(LOG_QUERY_GUIDE);
		expect(link).not.toBeNull();
		expect(parseLogQuery(decodeURIComponent(link![1]!)).ok).toBe(true);
	});

	test('MCP clients never get the cloud shell tool (D237)', () => {
		expect(registered.has(CLOUD_SHELL_TOOL)).toBe(false);
		expect(mcpSource).not.toContain(`'${CLOUD_SHELL_TOOL}'`);
	});

	test('every permission-gated write tool exists', () => {
		expect(gated.length).toBeGreaterThan(20);
		for (const name of gated)
			expect({ name, registered: registered.has(name) }).toMatchObject({ registered: true });
	});
});
