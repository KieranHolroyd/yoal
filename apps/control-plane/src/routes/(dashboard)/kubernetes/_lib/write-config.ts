import type { KubernetesGenerateProgress } from '@yoal/contracts';
import type {
	KubernetesApplyResult,
	KubernetesGenerateResult,
	KubernetesManifestFinding,
	KubernetesObjectRef
} from '@yoal/contracts';

/**
 * The "Write config" tab's client side (docs/KUBERNETES.md §18): reading the generate endpoint's
 * event stream from a POST (so `fetch`, not `EventSource`), progress wording, and small helpers
 * for the YAML the person may have edited. Pure, so it is tested without a browser.
 */

/** The stream's progress events (shared with the server in contracts). */
export type GenerateProgress = KubernetesGenerateProgress;

export interface SseFrame {
	event: string;
	data: string;
}

/**
 * Incremental `text/event-stream` parser: `event:` and `data:` lines, `:` comments (the server's
 * keep-alives) skipped, frames dispatched on a blank line. Chunks may split anywhere.
 */
export function createSseParser() {
	let buffer = '';
	let event = '';
	let data: string[] = [];
	const line = (text: string): SseFrame | null => {
		if (text === '') {
			const frame = data.length > 0 ? { event: event || 'message', data: data.join('\n') } : null;
			event = '';
			data = [];
			return frame;
		}
		if (text.startsWith(':')) return null;
		const colon = text.indexOf(':');
		const field = colon === -1 ? text : text.slice(0, colon);
		let value = colon === -1 ? '' : text.slice(colon + 1);
		if (value.startsWith(' ')) value = value.slice(1);
		if (field === 'event') event = value;
		else if (field === 'data') data.push(value);
		return null;
	};
	return {
		push(chunk: string): SseFrame[] {
			buffer += chunk;
			const frames: SseFrame[] = [];
			for (;;) {
				const match = /\r\n|\r|\n/.exec(buffer);
				if (!match) break;
				// A trailing `\r` may be half of `\r\n`: wait for the next chunk.
				if (match[0] === '\r' && match.index === buffer.length - 1) break;
				const frame = line(buffer.slice(0, match.index));
				buffer = buffer.slice(match.index + match[0].length);
				if (frame) frames.push(frame);
			}
			return frames;
		},
		/** End of stream: a final frame missing its blank line still counts. */
		end(): SseFrame[] {
			const rest = buffer;
			buffer = '';
			const frames = rest ? this.push(`${rest}\n`) : [];
			const last = line('');
			return last ? [...frames, last] : frames;
		}
	};
}

/** A failure with the server's message and HTTP status (503 when no provider is configured). */
export class WriteConfigError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code?: string
	) {
		super(message);
		this.name = 'WriteConfigError';
	}
}

async function responseError(response: Response, fallback: string): Promise<WriteConfigError> {
	let message = `${fallback} (${response.status}).`;
	let code: string | undefined;
	try {
		const body = (await response.json()) as { message?: unknown; error?: unknown };
		if (typeof body?.message === 'string' && body.message) message = body.message;
		if (typeof body?.error === 'string') code = body.error;
	} catch {
		// Not JSON; keep the status message.
	}
	return new WriteConfigError(message, response.status, code);
}

/** Handle one parsed frame; returns the result when it is the final `result` event. */
export function handleFrame(
	frame: SseFrame,
	onProgress: (progress: GenerateProgress) => void
): KubernetesGenerateResult | null {
	let body: unknown;
	try {
		body = JSON.parse(frame.data);
	} catch {
		throw new WriteConfigError('The server sent an unreadable update.', 502);
	}
	if (frame.event === 'progress') {
		onProgress(body as GenerateProgress);
		return null;
	}
	if (frame.event === 'result') return body as KubernetesGenerateResult;
	if (frame.event === 'error') {
		const error = body as { message?: unknown; status?: unknown; error?: unknown };
		throw new WriteConfigError(
			typeof error.message === 'string' && error.message
				? error.message
				: 'Writing the config failed.',
			typeof error.status === 'number' ? error.status : 500,
			typeof error.error === 'string' ? error.error : undefined
		);
	}
	return null;
}

/**
 * POST to `/generate` asking for an event stream; report progress until the one `result` (or
 * `error`) event. Fast failures (no provider, permission, bad YAML) come back as plain JSON errors.
 */
export async function streamGenerate(
	url: string,
	body: { prompt: string; namespace: string; yaml?: string; dryRun: boolean },
	options: {
		signal?: AbortSignal;
		onProgress?: (progress: GenerateProgress) => void;
		fetch?: typeof fetch;
	} = {}
): Promise<KubernetesGenerateResult> {
	const response = await (options.fetch ?? fetch)(url, {
		method: 'POST',
		headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
		body: JSON.stringify(body),
		signal: options.signal
	});
	if (!response.ok) throw await responseError(response, 'Could not write the config');
	if (!response.body) throw new WriteConfigError('The server sent no response.', 502);
	const onProgress = options.onProgress ?? (() => undefined);
	const parser = createSseParser();
	const decoder = new TextDecoder();
	const reader = response.body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			const frames = done
				? [...parser.push(decoder.decode()), ...parser.end()]
				: parser.push(decoder.decode(value, { stream: true }));
			for (const frame of frames) {
				const result = handleFrame(frame, onProgress);
				if (result) return result;
			}
			if (done) break;
		}
	} finally {
		reader.releaseLock();
	}
	throw new WriteConfigError('The connection closed before the config was ready. Try again.', 502);
}

/** POST to `/apply` (or a dry run) with the YAML as it stands. */
export async function postApply(
	url: string,
	body: { yaml: string; dryRun: boolean; namespace: string },
	options: { fetch?: typeof fetch } = {}
): Promise<KubernetesApplyResult> {
	const response = await (options.fetch ?? fetch)(url, {
		method: 'POST',
		headers: { accept: 'application/json', 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	if (!response.ok)
		throw await responseError(
			response,
			body.dryRun ? 'The dry run failed' : 'Could not apply the config'
		);
	return (await response.json()) as KubernetesApplyResult;
}

/** "Writing…", "Fixing 2 problems…", "Checking with the cluster…". */
export function progressLabel(progress: GenerateProgress | null): string {
	if (!progress) return 'Starting…';
	if (progress.stage === 'dry-run') return 'Checking with the cluster…';
	if (progress.stage === 'repairing')
		return `Fixing ${progress.errors} ${progress.errors === 1 ? 'problem' : 'problems'}…`;
	return progress.round > 1 ? `Writing (round ${progress.round})…` : 'Writing…';
}

export type FindingGroups = Record<
	KubernetesManifestFinding['severity'],
	KubernetesManifestFinding[]
>;

export function groupFindings(findings: KubernetesManifestFinding[]): FindingGroups {
	const groups: FindingGroups = { error: [], warning: [], info: [] };
	for (const finding of findings) groups[finding.severity].push(finding);
	return groups;
}

/**
 * The objects in a YAML stream, read loosely for the apply confirmation: top-level `kind:` and
 * the `name:`/`namespace:` under `metadata:`. The server parses it properly; this only labels the
 * dialog, so the edited YAML (not the generated object list) is what the person confirms.
 */
export function objectsInYaml(yaml: string): KubernetesObjectRef[] {
	const objects: KubernetesObjectRef[] = [];
	for (const document of yaml.split(/^---[^\S\r\n]*(?:#.*)?$/m)) {
		const kind = /^kind:\s*["']?([^\s"'#]+)/m.exec(document)?.[1];
		if (!kind) continue;
		const metadata =
			/^metadata:[^\S\r\n]*\r?\n((?:[ \t]+.*(?:\r?\n|$)|[^\S\r\n]*(?:\r?\n|$))*)/m.exec(
				document
			)?.[1];
		const indentOf = metadata ? (/^([ \t]+)\S/m.exec(metadata)?.[1] ?? '  ') : '  ';
		const field = (name: string) =>
			metadata
				? new RegExp(`^${indentOf}${name}:\\s*["']?([^\\s"'#]+)`, 'm').exec(metadata)?.[1]
				: undefined;
		objects.push({ kind, name: field('name') ?? '?', namespace: field('namespace') ?? null });
	}
	return objects;
}

export function objectLabel(object: KubernetesObjectRef): string {
	return `${object.kind}/${object.name}`;
}
