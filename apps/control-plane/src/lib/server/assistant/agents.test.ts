import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ASSISTANT_SYSTEM } from './agents';
import { ASSISTANT_ONLY_TOOLS, CLOUD_SHELL_TOOL } from './constants';

const mcpSource = readFileSync(new URL('../mcp.ts', import.meta.url), 'utf8');
// Pipelines tools are declared in ../mcp-pipelines.ts and registered by mcp.ts in a loop.
const pipelineSource = readFileSync(new URL('../mcp-pipelines.ts', import.meta.url), 'utf8');
const pipelineToolNames = [...pipelineSource.matchAll(/\n\t\t\tname: '([a-z_]+)',/g)].map((match) => match[1]);
const registered = new Set([
	...[...mcpSource.matchAll(/\n\ttool\(\n\t\t'([a-z_]+)',/g)].map((match) => match[1]),
	...pipelineToolNames
]);
const gated = [...mcpSource.matchAll(/^\t([a-z_]+): '[a-zA-Z]+:[a-z-]+',?$/gm)].map(
	(match) => match[1]!
);

describe('assistant prompt', () => {
	test('every tool the prompt names is registered in the MCP catalog', () => {
		expect(registered.size).toBeGreaterThan(20);
		const named = new Set(
			[...ASSISTANT_SYSTEM.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)].map((match) => match[0])
		);
		for (const name of ASSISTANT_ONLY_TOOLS) named.delete(name);
		expect(named.size).toBeGreaterThan(10);
		for (const name of named)
			expect({ name, registered: registered.has(name) }).toMatchObject({ registered: true });
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
