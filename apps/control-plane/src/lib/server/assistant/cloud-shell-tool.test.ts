import { describe, expect, test } from 'bun:test';
import type { CloudShellState, Principal } from '@yoal/contracts';
import type { ContainerConsoleCall } from '../container-console';
import {
	cleanTerminalText,
	cloudShellScript,
	cloudShellToolSchema,
	parseTranscript,
	runCloudShellCommand,
	type CloudShellRunDeps
} from './cloud-shell-tool';
import { CONFIRM_TOOLS } from './confirm-policy';

const principal = { userId: 'user_1', orgId: 'org_1', kind: 'user', credential: 'session' } as unknown as Principal;

function state(status: 'stopped' | 'starting' | 'running' | null): CloudShellState {
	return {
		enabled: true,
		shell: status
			? ({ id: 'csh_1', status, message: null, node: { id: 'node_1', name: 'edge', online: true } } as CloudShellState['shell'])
			: null,
		limits: { diskMb: 1024, memoryMb: 512, idleMinutes: 20 }
	};
}

/** What the node would do: echo the typed script, run the command, print the real markers. */
function fakeConsole(run: (command: string) => { output: string; code: number } | 'hang') {
	const calls: string[] = [];
	let typed = '';
	const sse = (chunks: string[], exit: boolean) => {
		const encoder = new TextEncoder();
		return new ReadableStream<Uint8Array>({
			start(controller) {
				let offset = 0;
				for (const chunk of chunks) {
					const bytes = Buffer.from(chunk, 'utf8');
					controller.enqueue(encoder.encode(`event: data\nid: ${offset}\ndata: ${bytes.toString('base64')}\n\n`));
					offset += bytes.length;
				}
				if (exit) {
					controller.enqueue(encoder.encode('event: exit\ndata: {"code":0}\n\n'));
					controller.close();
				}
			}
		});
	};
	const console = async (call: ContainerConsoleCall): Promise<Response> => {
		calls.push(`${call.request.method} ${call.op}${call.url.search}`);
		if (call.op === 'exec' && call.request.method === 'POST')
			return Response.json({ exec: { execId: 'cx_aaaaaaaaaaaaaaaaaaaaaaaa' } });
		if (call.op.endsWith('/input')) {
			typed = new TextDecoder().decode(await call.request.arrayBuffer());
			return Response.json({ ok: true });
		}
		if (call.op.endsWith('/stream')) {
			const id = /YOAL_RUN_([0-9a-f]+)/.exec(typed)![1]!;
			const encoded = typed.split(`<<'YOAL_RUN_${id}'\n`)[1]!.split(`\nYOAL_RUN_${id}`)[0]!.replace(/\n/g, '');
			const command = Buffer.from(encoded, 'base64').toString('utf8');
			// The terminal echoes the typed text first; it only contains `\036` as text.
			const echo = typed.replace(/\n/g, '\r\n');
			const result = run(command);
			if (result === 'hang') return new Response(sse([echo, `\x1eYOAL-BEGIN-${id}\x1e\r\n`, 'working…\r\n'], false));
			return new Response(
				sse([echo, `\x1eYOAL-BEGIN-${id}\x1e\r\n`, result.output, `\x1eYOAL-END-${id} ${result.code}\x1e\r\n`], true)
			);
		}
		if (call.request.method === 'DELETE') return Response.json({ ok: true });
		return Response.json({ message: 'unexpected' }, { status: 404 });
	};
	return { console, calls, typed: () => typed };
}

function deps(
	consoleImpl: CloudShellRunDeps['console'],
	statuses: Array<'stopped' | 'starting' | 'running' | null>,
	audits: Array<{ args: Record<string, unknown>; ok: boolean }> = []
): CloudShellRunDeps & { started: number } {
	let index = 0;
	const out = {
		started: 0,
		console: consoleImpl,
		shells: {
			state: () => state(statuses[Math.min(index++, statuses.length - 1)]!),
			start: () => {
				out.started += 1;
			}
		},
		audit: (_who: Principal, args: Record<string, unknown>, ok: boolean) => audits.push({ args, ok }),
		sleep: async () => undefined
	};
	return out;
}

describe('cloud shell tool', () => {
	test('is always confirmed and validates its input', () => {
		expect(CONFIRM_TOOLS.has('run_in_cloud_shell')).toBe(true);
		expect(cloudShellToolSchema.parse({ command: 'ls' })).toEqual({ command: 'ls', timeoutSeconds: 60 });
		expect(cloudShellToolSchema.safeParse({ command: '' }).success).toBe(false);
		expect(cloudShellToolSchema.safeParse({ command: 'ls', timeoutSeconds: 3_600 }).success).toBe(false);
	});

	test('the typed script keeps every line short and the markers out of the echo', () => {
		const script = cloudShellScript('abc123', `echo ${'x'.repeat(6_000)}\necho "two"`);
		for (const line of script.split('\n')) expect(line.length).toBeLessThan(200);
		expect(script).not.toContain('\x1e');
		expect(script).toContain("printf '\\036YOAL-BEGIN-abc123\\036\\n'");
		expect(script).toContain('</dev/null 2>&1');
	});

	test('reads output and exit code between the markers, ignoring the echoed script', () => {
		const script = cloudShellScript('f00d', 'yoal projects');
		const transcript = `${script.replace(/\n/g, '\r\n')}\x1eYOAL-BEGIN-f00d\x1e\r\n\x1b[32mweb\x1b[0m  running\r\n\x1eYOAL-END-f00d 3\x1e\r\n$ `;
		expect(parseTranscript('f00d', transcript)).toEqual({ output: 'web  running', exitCode: 3 });
		expect(cleanTerminalText('\x1b]0;title\x07a\r\nb\x1b[2K\r\n')).toBe('a\nb');
	});

	test('runs a command in a running shell and hangs up afterwards', async () => {
		const fake = fakeConsole((command) => ({ output: `ran: ${command}\r\n`, code: 0 }));
		const audits: Array<{ args: Record<string, unknown>; ok: boolean }> = [];
		const run = deps(fake.console, ['running'], audits);
		const result = await runCloudShellCommand(principal, { command: 'yoal projects --json', timeoutSeconds: 30, reason: 'list projects' }, run);
		expect(result).toMatchObject({ ok: true, exitCode: 0, timedOut: false, startedShell: false, node: 'edge', output: 'ran: yoal projects --json' });
		expect(result.text).toContain('Exit code 0');
		expect(run.started).toBe(0);
		expect(fake.calls).toEqual([
			'POST exec',
			'POST exec/cx_aaaaaaaaaaaaaaaaaaaaaaaa/input',
			'GET exec/cx_aaaaaaaaaaaaaaaaaaaaaaaa/stream?after=0',
			'DELETE exec/cx_aaaaaaaaaaaaaaaaaaaaaaaa'
		]);
		expect(audits).toEqual([
			{ args: expect.objectContaining({ command: 'yoal projects --json', reason: 'list projects', exitCode: 0, timedOut: false }), ok: true }
		]);
	});

	test('a non-zero exit is reported, not hidden', async () => {
		const fake = fakeConsole(() => ({ output: 'Error: not found\r\n', code: 1 }));
		const result = await runCloudShellCommand(principal, { command: 'yoal projects show nope', timeoutSeconds: 30 }, deps(fake.console, ['running']));
		expect(result).toMatchObject({ ok: true, exitCode: 1, output: 'Error: not found' });
		expect(result.text).toContain('Exit code 1');
	});

	test('starts a stopped shell and waits for it to run', async () => {
		const fake = fakeConsole(() => ({ output: 'ok\r\n', code: 0 }));
		const run = deps(fake.console, ['stopped', 'starting', 'starting', 'running']);
		const result = await runCloudShellCommand(principal, { command: 'true', timeoutSeconds: 30 }, run);
		expect(run.started).toBe(1);
		expect(result.startedShell).toBe(true);
		expect(result.text).toContain('was started for this command');
	});

	test('gives up on a shell that never starts without running anything', async () => {
		const fake = fakeConsole(() => ({ output: '', code: 0 }));
		let clock = 0;
		const run = { ...deps(fake.console, ['stopped', 'starting']), now: () => (clock += 30_000) };
		await expect(runCloudShellCommand(principal, { command: 'true', timeoutSeconds: 30 }, run)).rejects.toThrow(/still starting/);
		expect(fake.calls).toEqual([]);
	});

	test('a start the node gave up on is reported with its reason', async () => {
		const fake = fakeConsole(() => ({ output: '', code: 0 }));
		const failed = state('stopped');
		failed.shell!.message = 'edge could not start your cloud shell: its container exited 5 times in a row.';
		const run = { ...deps(fake.console, ['stopped']), shells: { state: () => failed, start: () => undefined } };
		await expect(runCloudShellCommand(principal, { command: 'true', timeoutSeconds: 30 }, run)).rejects.toThrow(
			/exited 5 times in a row\. Nothing was run/
		);
		expect(fake.calls).toEqual([]);
	});

	test('stops a command at its timeout and kills what it started', async () => {
		const fake = fakeConsole(() => 'hang');
		const audits: Array<{ args: Record<string, unknown>; ok: boolean }> = [];
		const result = await runCloudShellCommand(principal, { command: 'sleep 999', timeoutSeconds: 5 }, deps(fake.console, ['running'], audits));
		expect(result).toMatchObject({ ok: false, exitCode: null, timedOut: true, output: 'working…' });
		expect(result.text).toContain('Stopped after 5s');
		expect(fake.calls.at(-1)).toBe('DELETE exec/cx_aaaaaaaaaaaaaaaaaaaaaaaa');
		expect(audits[0]!.ok).toBe(false);
	}, 10_000);

	test('a refusal from the console is passed on', async () => {
		const refusing: CloudShellRunDeps['console'] = async () =>
			Response.json({ message: 'A container can have at most 4 shells open. Close one first.' }, { status: 429 });
		await expect(
			runCloudShellCommand(principal, { command: 'ls', timeoutSeconds: 30 }, deps(refusing, ['running']))
		).rejects.toThrow(/at most 4 shells/);
	});
});
