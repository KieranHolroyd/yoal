import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Shared by provision.ts and suite.ts. No Yoal imports: the example treats Yoal as a black box. */

export const EXAMPLE_DIR = resolve(import.meta.dir, '..');
export const REPO_ROOT = resolve(EXAMPLE_DIR, '..', '..');
export const STATE_PATH = resolve(EXAMPLE_DIR, '.state.json');

export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly body: unknown,
	) {
		super(message);
		this.name = 'ApiError';
	}
}

/** Minimal bearer client for the Yoal REST API (`docs/API.md`), rooted at `/api/v1`. */
export class Api {
	readonly baseUrl: string;
	constructor(
		baseUrl: string,
		private readonly token: string,
	) {
		this.baseUrl = baseUrl.replace(/\/+$/, '');
	}

	get<T = any>(path: string) {
		return this.request<T>('GET', path);
	}
	post<T = any>(path: string, body?: unknown) {
		return this.request<T>('POST', path, body);
	}
	patch<T = any>(path: string, body?: unknown) {
		return this.request<T>('PATCH', path, body);
	}

	/** GET that turns a 404 into null. */
	async find<T = any>(path: string): Promise<T | null> {
		try {
			return await this.get<T>(path);
		} catch (error) {
			if (error instanceof ApiError && error.status === 404) return null;
			throw error;
		}
	}

	async request<T>(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
		const response = await fetch(`${this.baseUrl}/api/v1${path}`, {
			method,
			headers: {
				authorization: `Bearer ${this.token}`,
				accept: 'application/json',
				origin: this.baseUrl,
				...(body === undefined ? {} : { 'content-type': 'application/json' }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
		const text = await response.text();
		let data: unknown = text;
		try {
			data = text ? JSON.parse(text) : undefined;
		} catch {
			// keep the text
		}
		if (!response.ok) throw new ApiError(response.status, `${method} ${path} → ${response.status}: ${describe(data)}`, data);
		return data as T;
	}
}

function describe(data: unknown): string {
	if (data && typeof data === 'object') {
		const record = data as Record<string, any>;
		const issue = Array.isArray(record.issues) ? record.issues[0] : null;
		if (issue) return `${Array.isArray(issue.path) ? `${issue.path.join('.')}: ` : ''}${issue.message ?? issue}`;
		return String(record.message ?? record.error ?? JSON.stringify(data)).slice(0, 400);
	}
	return String(data ?? '').slice(0, 400);
}

export function apiFromEnv(flags: { url?: string; token?: string }): Api | null {
	const url = flags.url ?? process.env.YOAL_URL;
	const token = flags.token ?? process.env.YOAL_TOKEN;
	return url && token ? new Api(url, token) : null;
}

/** JSONC → JSON: drop comments and trailing commas, leaving string contents alone. */
export function parseJsonc(text: string): any {
	let out = '';
	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i]!;
		if (ch === '"') {
			const start = i;
			for (i += 1; i < text.length && text[i] !== '"'; i += 1) if (text[i] === '\\') i += 1;
			out += text.slice(start, i + 1);
		} else if (ch === '/' && text[i + 1] === '/') {
			while (i < text.length && text[i] !== '\n') i += 1;
			out += '\n';
		} else if (ch === '/' && text[i + 1] === '*') {
			i = text.indexOf('*/', i + 2) + 1;
		} else out += ch;
	}
	return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

export function readWrangler(path = resolve(EXAMPLE_DIR, 'wrangler.jsonc')): any {
	return parseJsonc(readFileSync(path, 'utf8'));
}

export interface State {
	url?: string;
	slug?: string;
	projectId?: string;
	companion?: string;
	storage?: string;
	bucket?: string;
	database?: string;
	broker?: string;
	queues?: string[];
	eventRuleId?: string;
	secretSha256?: string;
	idleStopSeconds?: number;
	provisionedAt?: string;
}

export function readState(): State {
	if (!existsSync(STATE_PATH)) return {};
	return JSON.parse(readFileSync(STATE_PATH, 'utf8')) as State;
}

/** Atomic, 0600: the state holds a secret digest, never the value. */
export function writeState(state: State): void {
	const tmp = `${STATE_PATH}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	chmodSync(tmp, 0o600);
	renameSync(tmp, STATE_PATH);
}

export async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return Buffer.from(digest).toString('hex');
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function poll<T>(what: string, timeoutMs: number, probe: () => Promise<T | null | undefined | false>, intervalMs = 2000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown = null;
	while (Date.now() < deadline) {
		try {
			const value = await probe();
			if (value) return value;
		} catch (error) {
			lastError = error;
		}
		await sleep(intervalMs);
	}
	throw new Error(`${what}: timed out after ${Math.round(timeoutMs / 1000)} s${lastError ? ` (${String(lastError)})` : ''}`);
}

const color = (code: number) => (text: string) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
export const green = color(32);
export const red = color(31);
export const yellow = color(33);
export const dim = color(2);
