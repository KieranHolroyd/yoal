import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * The published CLI is built with `--target=node` and runs under Node, where `Bun` is not defined.
 * A bare `Bun.sleep` in `yoal jobs run --follow` broke one-off jobs under Node; keep every Bun API
 * out of the shipped sources except where it is feature-checked or Bun-only by design.
 */
const BUN_ONLY = new Set(['pipelines-local.ts']);

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return sources(path);
		return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
	});
}

describe('Node compatibility', () => {
	test('shipped CLI sources call no Bun API outside feature checks', () => {
		const root = join(import.meta.dir);
		const offenders: string[] = [];
		for (const file of sources(root)) {
			if (BUN_ONLY.has(relative(root, file))) continue;
			readFileSync(file, 'utf8')
				.split('\n')
				.forEach((line, index) => {
					// Drop comments and string contents (error messages may name Bun APIs).
					const code = line.replace(/\/\/.*$/, '').replace(/(['"`])(?:\\.|(?!\1).)*\1/g, "''");
					// `globalThis.Bun?.YAML` style feature checks are fine; a bare `Bun.x` is not.
					if (/(^|[^.?\w])Bun\.[a-zA-Z]/.test(code)) offenders.push(`${relative(root, file)}:${index + 1}: ${line.trim()}`);
				});
		}
		expect(offenders).toEqual([]);
	});
});
