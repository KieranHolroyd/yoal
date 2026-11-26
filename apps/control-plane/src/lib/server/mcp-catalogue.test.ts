import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

/**
 * The MCP docs catalogue (packages/docs/content/clients/mcp.md) and the README "For agents" table
 * must list exactly the tools `mcp.ts` and `mcp-pipelines.ts` register, and the page's tool count
 * and confirmed-tools sentence must match. Tool names may contain digits.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const mcpSource = read('./mcp.ts');
const pipelineSource = read('./mcp-pipelines.ts');
const catalogue = read('../../../../../packages/docs/content/clients/mcp.md');
const readme = read('../../../../../README.md');

const registered = [
	...[...mcpSource.matchAll(/\n\ttool\(\n\t\t'([a-z0-9_]+)',/g)].map((match) => match[1]!),
	...[...pipelineSource.matchAll(/\n\t\t\tname: '([a-z0-9_]+)',/g)].map((match) => match[1]!)
];

const sorted = (names: Iterable<string>) => [...names].sort();

const NUMBER_WORDS: Record<string, number> = {
	one: 1,
	two: 2,
	three: 3,
	four: 4,
	five: 5,
	six: 6,
	seven: 7,
	eight: 8,
	nine: 9,
	ten: 10,
	eleven: 11,
	twelve: 12,
	thirteen: 13,
	fourteen: 14,
	fifteen: 15,
	sixteen: 16,
	seventeen: 17,
	eighteen: 18,
	nineteen: 19,
	twenty: 20,
	thirty: 30,
	forty: 40,
	fifty: 50
};

/** "Twenty-four" → 24. */
function wordsToNumber(text: string): number {
	return text
		.toLowerCase()
		.split('-')
		.reduce((sum, word) => sum + (NUMBER_WORDS[word] ?? Number.NaN), 0);
}

describe('MCP tool catalogue sync', () => {
	test('every tool is registered once', () => {
		expect(registered.length).toBeGreaterThan(200);
		expect(new Set(registered).size).toBe(registered.length);
	});

	test('the docs tables list exactly the registered tools, once each', () => {
		const documented = [...catalogue.matchAll(/^\| `([a-z0-9_]+)` \|/gm)].map((match) => match[1]!);
		expect(new Set(documented).size).toBe(documented.length);
		expect(sorted(documented)).toEqual(sorted(registered));
	});

	test('the tool count matches', () => {
		const count = /There are (\d+) tools\./.exec(catalogue);
		expect(count).not.toBeNull();
		expect(Number(count![1])).toBe(registered.length);
	});

	test('the confirmed-tools sentence names registered tools and counts them right', () => {
		const sentence =
			/^([A-Z][a-z]+(?:-[a-z]+)?) tools ask a person to confirm before they act: (.+)$/m.exec(
				catalogue
			);
		expect(sentence).not.toBeNull();
		const named = [...sentence![2]!.matchAll(/`([a-z0-9_]+)`/g)].map((match) => match[1]!);
		for (const name of named)
			expect({ name, registered: registered.includes(name) }).toEqual({ name, registered: true });
		expect(new Set(named).size).toBe(wordsToNumber(sentence![1]!));
	});

	test('the README "For agents" table lists exactly the registered tools', () => {
		const section = readme.slice(readme.indexOf('## For agents'));
		const table = section.slice(section.indexOf('| Area | Tools |'));
		const rows = table
			.split('\n')
			.filter(
				(line, index, lines) =>
					line.startsWith('|') && lines.slice(0, index).every((before) => before.startsWith('|'))
			);
		const listed = rows
			.slice(2)
			.flatMap((row) =>
				[...(row.split('|')[2] ?? '').matchAll(/`([a-z0-9_]+)`/g)].map((match) => match[1]!)
			);
		expect(new Set(listed).size).toBe(listed.length);
		expect(sorted(listed)).toEqual(sorted(registered));
	});
});
