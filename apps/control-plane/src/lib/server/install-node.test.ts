import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderNodeScript } from './install-node.js';

const source = { repo: 'KieranHolroyd/yoal', channel: 'canary' } as const;

describe('node installer script', () => {
	test('bakes the origin and keeps the token out of the script', () => {
		const script = renderNodeScript('https://control.example.com/', source);
		expect(script).toContain('ORIGIN=https://control.example.com');
		expect(script).toContain('--network-mode yoal');
		expect(script).toContain('join "$ORIGIN"');
		expect(script).not.toContain('skn1_');
	});

	test('quotes an origin that is not shell-safe', () => {
		const script = renderNodeScript("https://control.example.com/it's", source);
		expect(script).toContain("'https://control.example.com/it'\\''s'");
	});

	test('falls through to the worker install from the control plane repo and channel', () => {
		const script = renderNodeScript('https://control.example.com', { repo: 'acme/yoal', channel: 'stable' });
		expect(script).toContain('REPO=acme/yoal');
		expect(script).toContain('CHANNEL=stable');
		expect(script).toContain('https://raw.githubusercontent.com/$REPO/main/install.sh');
		expect(script).toContain('--yes --join "$ORIGIN" --name "$NAME"');
		expect(script).toContain('YOAL_JOIN_TOKEN=$TOKEN');
		expect(script).not.toContain('Install the signed Yoal release bundle first');
	});

	test('takes --zone, --roles and the token from a file or stdin, validates them, and forwards them', () => {
		const script = renderNodeScript('https://control.example.com', source);
		expect(script).toContain('[ -z "$ZONE" ] || set -- "$@" --zone "$ZONE"');
		expect(script).toContain('[ -z "$ROLES" ] || set -- "$@" --roles "$ROLES"');
		// The existing-agent path passes the token in the environment too.
		expect(script).toContain('YOAL_JOIN_TOKEN=$TOKEN yoal-agent "$@"');
		// Only an older agent, which cannot read the variable, still gets it as an argument.
		expect(script).toContain('yoal-agent join --help 2>&1 | grep -q YOAL_JOIN_TOKEN');
		expect(Bun.spawnSync({ cmd: ['sh', '-n', '/dev/stdin'], stdin: new TextEncoder().encode(script) }).exitCode).toBe(0);
		// stdin is the script itself under `curl | sh`, so the usage says to save it first.
		expect(script).toContain('--token-file - reads the token from stdin, so save node.sh first: it does not work with curl ... | sh');

		const dir = mkdtempSync(join(tmpdir(), 'yoal-node-sh-'));
		try {
			const path = join(dir, 'node.sh');
			const tokenFile = join(dir, 'token');
			writeFileSync(path, script);
			writeFileSync(tokenFile, 'j'.repeat(32) + '\n');
			const runScript = (args: string[], stdin = '') => {
				const result = Bun.spawnSync({ cmd: ['sh', path, ...args], stdin: new TextEncoder().encode(stdin), stderr: 'pipe' });
				return { code: result.exitCode, stderr: new TextDecoder().decode(result.stderr) };
			};
			expect(runScript(['--token-file', tokenFile, '--name', 'b', '--zone', 'Bad_Zone'])).toMatchObject({ code: 2, stderr: expect.stringContaining('--zone') });
			expect(runScript(['--token-file', tokenFile, '--name', 'b', '--roles', 'ingress,router'])).toMatchObject({ code: 2, stderr: expect.stringContaining('router') });
			expect(runScript(['--token-file', join(dir, 'empty'), '--name', 'b']).code).not.toBe(0);
			expect(runScript(['--token-file', '-', '--name', 'b'], '').code).toBe(2);
			// Valid flags get past parsing; the next stop is the root check (never reached as root here).
			if (process.getuid?.() !== 0) {
				expect(runScript(['--token-file', tokenFile, '--name', 'b', '--zone', 'uksouth-2', '--roles', 'ingress,compute,data,control'])).toMatchObject({
					code: 1,
					stderr: expect.stringContaining('run as root'),
				});
				expect(runScript(['--token-file', '-', '--name', 'b'], `${'j'.repeat(32)}\n`).stderr).toContain('run as root');
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
