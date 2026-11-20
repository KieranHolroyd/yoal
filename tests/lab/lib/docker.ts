/**
 * Docker plumbing for the nested-container lab. argv only (no shell on the host side), and every
 * object this touches is a `yoal-w0-*` name: `assertLabName` refuses anything else, so a typo can
 * never stop or delete a container the lab did not create.
 */
import { existsSync } from 'node:fs';
import { LAB } from '../lab.config.ts';

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

export function assertLabName(name: string): string {
	if (!name.startsWith(`${LAB.prefix}-`) || !/^[a-z0-9][a-z0-9_.-]*$/.test(name)) throw new Error(`refusing to touch "${name}": not a ${LAB.prefix}-* object`);
	return name;
}

export function run(argv: string[], options: { stdin?: string | Uint8Array; allowFailure?: boolean; env?: Record<string, string> } = {}): RunResult {
	const result = Bun.spawnSync(argv, {
		stdin: options.stdin === undefined ? 'ignore' : typeof options.stdin === 'string' ? new TextEncoder().encode(options.stdin) : options.stdin,
		stdout: 'pipe',
		stderr: 'pipe',
		env: { ...process.env, ...(options.env ?? {}) },
	});
	const out = { code: result.exitCode ?? 1, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
	if (out.code !== 0 && !options.allowFailure)
		throw new Error(`${argv.slice(0, 4).join(' ')} … exited ${out.code}: ${(out.stderr || out.stdout).trim().slice(-1500)}`);
	return out;
}

/** Stream a long command's output to a log file and the terminal prefix; resolve with its exit code. */
export async function stream(argv: string[], logPath: string, prefix: string, options: { stdin?: Uint8Array } = {}): Promise<number> {
	const child = Bun.spawn(argv, { stdin: options.stdin ?? 'ignore', stdout: 'pipe', stderr: 'pipe' });
	const file = Bun.file(logPath).writer();
	const pump = async (readable: ReadableStream<Uint8Array>) => {
		const decoder = new TextDecoder();
		let carry = '';
		for await (const chunk of readable) {
			file.write(chunk);
			carry += decoder.decode(chunk, { stream: true });
			const lines = carry.split('\n');
			carry = lines.pop() ?? '';
			for (const line of lines) {
				// Section headings and failures only; the full log is in logPath.
				const plain = line.replace(/\x1b\[[0-9;]*m/g, '');
				if (/^[A-Z][A-Za-z ()-]+$/.test(plain.trim()) || /error|fail|warning/i.test(plain)) console.log(`  ${prefix} │ ${plain.slice(0, 200)}`);
			}
		}
	};
	await Promise.all([pump(child.stdout), pump(child.stderr)]);
	const code = await child.exited;
	await file.end();
	return code;
}

export function docker(args: string[], options: Parameters<typeof run>[1] = {}): RunResult {
	return run(['docker', ...args], options);
}

/** Run argv inside a lab container as root. */
export function exec(container: string, argv: string[], options: Parameters<typeof run>[1] & { env?: Record<string, string> } = {}): RunResult {
	const envArgs = Object.entries(options.env ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
	return run(['docker', 'exec', ...(options.stdin === undefined ? [] : ['-i']), ...envArgs, assertLabName(container), ...argv], { ...options, env: {} });
}

export function containerState(name: string): 'running' | 'exited' | 'created' | 'missing' | string {
	const result = docker(['inspect', '-f', '{{.State.Status}}', assertLabName(name)], { allowFailure: true });
	return result.code === 0 ? result.stdout.trim() : 'missing';
}

export function labContainers(): string[] {
	return docker(['ps', '-a', '--filter', `label=${LAB.label}`, '--format', '{{.Names}}'])
		.stdout.split('\n')
		.filter((name) => name.startsWith(`${LAB.prefix}-`));
}

export function labVolumes(): string[] {
	return docker(['volume', 'ls', '--filter', `label=${LAB.label}`, '--format', '{{.Name}}'])
		.stdout.split('\n')
		.filter((name) => name.startsWith(`${LAB.prefix}-`));
}

export function imageExists(ref: string): boolean {
	return docker(['image', 'inspect', ref], { allowFailure: true }).code === 0;
}

/** The checkout as a tar: tracked and untracked files, minus ignored ones and deletions. */
export function checkoutTar(repo: string): Uint8Array {
	const list = run(['git', '-C', repo, 'ls-files', '-z', '--cached', '--others', '--exclude-standard']);
	const files = list.stdout.split('\0').filter((file) => file && existsSync(`${repo}/${file}`));
	const tar = Bun.spawnSync(['tar', '--no-xattrs', '-C', repo, '-cf', '-', '--null', '-T', '-'], {
		stdin: new TextEncoder().encode(files.join('\0')),
		stdout: 'pipe',
		stderr: 'pipe',
		env: { ...process.env, COPYFILE_DISABLE: '1' },
	});
	if (tar.exitCode !== 0) throw new Error(`tar of the checkout failed: ${tar.stderr.toString()}`);
	return tar.stdout;
}
