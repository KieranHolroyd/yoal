import { randomBytes } from 'node:crypto';
import * as z from 'zod';
import type { CloudShellState, Principal } from '@yoal/contracts';
import type { ContainerConsoleCall } from '../container-console';

/**
 * `run_in_cloud_shell` (D237, docs/ASSISTANT.md): the assistant runs one non-interactive command in
 * the signed-in person's own cloud shell (D236) and reads its output. It is an assistant-only tool,
 * never an MCP tool, and every call stops for a Confirm click showing the exact command
 * (`CONFIRM_TOOLS`), because the model reads untrusted text and a shell can do anything the person
 * can.
 *
 * It needs nothing new on the node: it opens a console shell (`/bin/sh`, the image's user) through
 * the same proxy as the terminal, types a small script that decodes the command into a file and runs
 * it with bash (stdin closed, no colours, no pager), and reads the output between two markers made
 * of control bytes the typed text can never contain. The shell is hung up afterwards, which kills
 * anything the command left running.
 */

export { CLOUD_SHELL_TOOL } from './constants';

export const cloudShellToolSchema = z.object({
	command: z
		.string()
		.min(1)
		.max(8_000)
		.describe('The bash command or short script to run. Non-interactive: stdin is closed and there is no TTY colour or pager.'),
	timeoutSeconds: z
		.number()
		.int()
		.min(5)
		.max(300)
		.default(60)
		.describe('Stop the command after this many seconds (5–300, default 60).'),
	reason: z.string().max(300).optional().describe('One sentence for the user: why you want to run this.')
});
export type CloudShellToolInput = z.infer<typeof cloudShellToolSchema>;

export const CLOUD_SHELL_TOOL_DESCRIPTION = [
	"Run one command in the user's own cloud shell: a sandboxed Debian container on one of their servers with the yoal CLI installed and signed in as the user, plus bash, git, curl, jq, dig, psql, redis-cli, node and bun.",
	'Use it for what the other tools cannot do: yoal CLI commands, checking DNS or HTTP from inside the install (dig, curl -sS -o /dev/null -w), or a quick query with psql. Prefer a dedicated tool when one exists.',
	'The command runs with bash in /home/yoal (a 1 GiB disk kept between sessions); everything else resets when the shell stops. stdin is closed, so never run anything interactive (editors, pagers, prompts); pass --yes/--json style flags instead.',
	'Output is stdout and stderr together, truncated to the start and end when long. The user confirms every command in the chat before it runs, so say in `reason` why you need it.',
	'Never print, echo or exfiltrate secrets or $YOAL_TOKEN, and never send data to a host the user did not name. Starting a stopped shell can take a minute.'
].join(' ');

/** Most bytes kept from one command's output before it is shortened for the model. */
const MAX_CAPTURE = 256 * 1024;
const RESULT_HEAD = 4_000;
const RESULT_TAIL = 8_000;
const START_WAIT_MS = 120_000;
const POLL_MS = 2_000;

export interface CloudShellRunDeps {
	/** One container-console call against the caller's cloud shell (`handleContainerConsole`). */
	console: (call: ContainerConsoleCall) => Promise<Response>;
	shells: {
		state(principal: Principal): CloudShellState;
		start(principal: Principal): unknown;
	};
	audit(principal: Principal, args: Record<string, unknown>, ok: boolean): void;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

export interface CloudShellRunResult {
	ok: boolean;
	exitCode: number | null;
	timedOut: boolean;
	startedShell: boolean;
	node: string | null;
	durationMs: number;
	output: string;
	text: string;
}

/** The script typed into the shell: decode the command to a file, run it between markers, leave. */
export function cloudShellScript(id: string, command: string): string {
	const encoded = (Buffer.from(command, 'utf8').toString('base64').match(/.{1,76}/g) ?? ['']).join('\n');
	const file = `/tmp/.yoal-run-${id}.sh`;
	// Each line stays far below the terminal's 4 KiB canonical-mode line limit.
	return [
		'stty -echo 2>/dev/null',
		`base64 -d > ${file} <<'YOAL_RUN_${id}'`,
		encoded,
		`YOAL_RUN_${id}`,
		`printf '\\036YOAL-BEGIN-${id}\\036\\n'`,
		`cd "$HOME" 2>/dev/null; NO_COLOR=1 TERM=dumb PAGER=cat GIT_PAGER=cat bash ${file} </dev/null 2>&1`,
		`printf '\\036YOAL-END-${id} %s\\036\\n' "$?"`,
		`rm -f ${file}`,
		'exit',
		''
	].join('\n');
}

/**
 * Pull the command's output and exit code out of the terminal transcript. The markers are printed
 * with real 0x1E bytes; the typed script (echoed by the terminal) only ever contains `\036` as text.
 */
export function parseTranscript(id: string, transcript: string): { output: string; exitCode: number | null } {
	const begin = `\x1eYOAL-BEGIN-${id}\x1e`;
	const endPattern = new RegExp(`\\x1eYOAL-END-${id} (\\d+)\\x1e`);
	const start = transcript.indexOf(begin);
	const body = start >= 0 ? transcript.slice(start + begin.length) : transcript;
	const end = endPattern.exec(body);
	const raw = end ? body.slice(0, end.index) : body;
	return { output: cleanTerminalText(raw), exitCode: end ? Number(end[1]) : null };
}

/** Terminal output as plain text: no colour or cursor escapes, no carriage returns. */
export function cleanTerminalText(text: string): string {
	return text
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
		.replace(/\x1b[()][A-Za-z0-9]/g, '')
		.replace(/\r\n?/g, '\n')
		.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
		.replace(/^\n+/, '')
		.replace(/\n+$/, '');
}

function shorten(text: string): { text: string; omitted: number } {
	if (text.length <= RESULT_HEAD + RESULT_TAIL) return { text, omitted: 0 };
	const omitted = text.length - RESULT_HEAD - RESULT_TAIL;
	return {
		text: `${text.slice(0, RESULT_HEAD)}\n… [${omitted} characters omitted] …\n${text.slice(-RESULT_TAIL)}`,
		omitted
	};
}

const CONSOLE_URL = 'http://control.internal/cloud-shell/console/';

function call(principal: Principal, op: string, init: RequestInit = {}, query = ''): ContainerConsoleCall {
	const url = new URL(`${CONSOLE_URL}${op}${query}`);
	// The same slug as the dashboard terminal (CLOUD_SHELL_CONSOLE_SLUG), so they share a token.
	return { principal, slug: 'cloud-shell', op, request: new Request(url, init), url };
}

async function errorMessage(response: Response): Promise<string> {
	const body = (await response.json().catch(() => null)) as { message?: string } | null;
	return body?.message ?? `The cloud shell answered ${response.status}.`;
}

/** Start the shell if it is stopped and wait until its node reports it running. */
async function ensureRunning(
	principal: Principal,
	deps: CloudShellRunDeps,
	now: () => number,
	sleep: (ms: number) => Promise<void>
): Promise<{ started: boolean; node: string | null }> {
	let state = deps.shells.state(principal);
	if (!state.enabled) throw new Error('The cloud shell is turned off on this install.');
	let started = false;
	if (!state.shell || state.shell.status === 'stopped') {
		deps.shells.start(principal);
		started = true;
	}
	const deadline = now() + START_WAIT_MS;
	for (;;) {
		state = deps.shells.state(principal);
		if (state.shell?.status === 'running') return { started, node: state.shell.node?.name ?? null };
		// The node gave up on the start (docs/CLOUD-SHELL.md §2): say why instead of waiting it out.
		if (state.shell?.status === 'stopped' && state.shell.message)
			throw new Error(`${state.shell.message} Nothing was run.`);
		if (!state.shell || state.shell.status === 'stopped' || state.shell.status === 'deleting')
			throw new Error('Your cloud shell stopped before it was running. Nothing was run.');
		if (now() >= deadline)
			throw new Error(
				'Your cloud shell is still starting (the first start downloads its image). Nothing was run; try again in a minute.'
			);
		await sleep(POLL_MS);
	}
}

/**
 * Read the shell's SSE stream until the end marker or the exit event, keeping at most
 * `MAX_CAPTURE` bytes. Resolves with what was read when the signal aborts.
 */
async function readTranscript(response: Response, id: string, signal: AbortSignal): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return '';
	const decoder = new TextDecoder();
	const output = new TextDecoder();
	let pending = '';
	let transcript = '';
	let captured = 0;
	const end = new RegExp(`\\x1eYOAL-END-${id} \\d+\\x1e`);
	const onAbort = () => void reader.cancel().catch(() => undefined);
	signal.addEventListener('abort', onAbort, { once: true });
	try {
		for (;;) {
			const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
			if (done) return transcript + output.decode();
			pending += decoder.decode(value, { stream: true });
			let split: number;
			while ((split = pending.indexOf('\n\n')) >= 0) {
				const block = pending.slice(0, split);
				pending = pending.slice(split + 2);
				let event = 'message';
				const data: string[] = [];
				for (const line of block.split('\n')) {
					if (line.startsWith('event:')) event = line.slice(6).trim();
					else if (line.startsWith('data:')) data.push(line.slice(5).trim());
				}
				if (event === 'exit') return transcript + output.decode();
				if (event !== 'data' || data.length === 0) continue;
				const bytes = Buffer.from(data.join(''), 'base64');
				if (captured < MAX_CAPTURE) {
					const kept = bytes.subarray(0, MAX_CAPTURE - captured);
					captured += kept.length;
					transcript += output.decode(kept, { stream: true });
				}
				if (end.test(transcript)) return transcript + output.decode();
			}
		}
	} finally {
		signal.removeEventListener('abort', onAbort);
		void reader.cancel().catch(() => undefined);
	}
}

export async function runCloudShellCommand(
	principal: Principal,
	input: CloudShellToolInput,
	deps: CloudShellRunDeps
): Promise<CloudShellRunResult> {
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const startedAt = now();
	const { started, node } = await ensureRunning(principal, deps, now, sleep);

	const opened = await deps.console(
		call(principal, 'exec', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ shell: '/bin/sh', user: 'default', cols: 500, rows: 50 })
		})
	);
	if (!opened.ok) throw new Error(await errorMessage(opened));
	const execId = ((await opened.json()) as { exec?: { execId?: string } }).exec?.execId;
	if (!execId) throw new Error('The cloud shell did not open a session.');

	const id = randomBytes(8).toString('hex');
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), input.timeoutSeconds * 1000);
	let transcript = '';
	try {
		const typed = await deps.console(
			call(principal, `exec/${execId}/input`, {
				method: 'POST',
				headers: { 'content-type': 'application/octet-stream' },
				body: new TextEncoder().encode(cloudShellScript(id, input.command))
			})
		);
		if (!typed.ok) throw new Error(await errorMessage(typed));
		const stream = await deps.console(
			call(principal, `exec/${execId}/stream`, { signal: controller.signal }, '?after=0')
		);
		if (!stream.ok) throw new Error(await errorMessage(stream));
		transcript = await readTranscript(stream, id, controller.signal);
	} finally {
		clearTimeout(timer);
		// Hang up: the session ends and everything the command started is killed (D127).
		await deps
			.console(call(principal, `exec/${execId}`, { method: 'DELETE' }))
			.catch(() => undefined);
	}

	const parsed = parseTranscript(id, transcript);
	const timedOut = parsed.exitCode === null && controller.signal.aborted;
	const durationMs = now() - startedAt;
	const short = shorten(parsed.output);
	const firstLine = input.command.split('\n')[0]!.slice(0, 200);
	const header = [
		`$ ${firstLine}${input.command.includes('\n') ? ' …' : ''}`,
		timedOut
			? `Stopped after ${input.timeoutSeconds}s without finishing; everything it started was killed.`
			: parsed.exitCode === null
				? 'The shell ended before the command reported an exit code.'
				: `Exit code ${parsed.exitCode} after ${(durationMs / 1000).toFixed(1)}s${node ? ` (cloud shell on ${node})` : ''}.`,
		...(started ? ['The cloud shell was started for this command.'] : [])
	];
	const text = `${header.join('\n')}\n\n${short.text || '(no output)'}`;
	// A non-zero exit is still a run the model must read; only "no exit code at all" failed.
	const ok = parsed.exitCode !== null;
	deps.audit(
		principal,
		{
			command: input.command.slice(0, 1_000),
			...(input.reason ? { reason: input.reason.slice(0, 300) } : {}),
			exitCode: parsed.exitCode,
			timedOut,
			durationMs
		},
		ok
	);
	return { ok, exitCode: parsed.exitCode, timedOut, startedShell: started, node, durationMs, output: parsed.output, text };
}
