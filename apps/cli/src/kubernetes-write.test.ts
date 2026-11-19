import { describe, expect, test } from 'bun:test';
import { ApiClient } from './api.ts';
import { ApiError, CliError } from './errors.ts';
import {
	formatApplyResult,
	formatFinding,
	formatGenerateResult,
	generateFailed,
	progressLine,
	readGenerateEvents,
	visibleFindings,
	type KubernetesApplyResult,
	type KubernetesGenerateProgress,
	type KubernetesGenerateResult,
	type KubernetesManifestFinding,
} from './kubernetes-write.ts';
import { readSse } from './sse.ts';

const finding = (severity: KubernetesManifestFinding['severity'], message: string, fixed = false): KubernetesManifestFinding => ({
	severity,
	document: 0,
	object: 'Deployment/web',
	path: 'spec.template',
	message,
	fixed,
});

const result = (extra: Partial<KubernetesGenerateResult> = {}): KubernetesGenerateResult => ({
	summary: 'nginx on shop.sites.test with 2 replicas.',
	yaml: 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n',
	objects: [
		{ kind: 'Deployment', name: 'web', namespace: 'default' },
		{ kind: 'Ingress', name: 'web', namespace: 'default' },
	],
	findings: [finding('info', 'Added default resources.', true), finding('warning', 'No readiness probe.'), finding('error', 'Image has no tag.')],
	assumptions: ['Port 80.'],
	questions: ['Which image tag?'],
	ok: false,
	rounds: 3,
	model: 'test-model',
	dryRun: null,
	...extra,
});

/** A body that delivers `text` in chunks of `size` bytes, so frames split anywhere. */
function chunked(text: string, size: number): ReadableStream<Uint8Array> {
	const bytes = new TextEncoder().encode(text);
	let offset = 0;
	return new ReadableStream({
		pull(controller) {
			if (offset >= bytes.length) return controller.close();
			controller.enqueue(bytes.slice(offset, offset + size));
			offset += size;
		},
	});
}

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

describe('readGenerateEvents', () => {
	test('reports progress, skips keep-alives and returns the result, whatever the chunking', async () => {
		const stream =
			': keep-alive\n\n' +
			frame('progress', { stage: 'generating', round: 1 }) +
			frame('progress', { stage: 'repairing', round: 2, errors: 2 }) +
			': keep-alive\n\n' +
			frame('progress', { stage: 'dry-run' }) +
			frame('result', result({ ok: true, findings: [] }));
		for (const size of [1, 7, 64, 100_000]) {
			const seen: KubernetesGenerateProgress[] = [];
			const got = await readGenerateEvents(readSse(chunked(stream, size)), (progress) => seen.push(progress));
			expect(seen.map((progress) => progress.stage)).toEqual(['generating', 'repairing', 'dry-run']);
			expect(got.ok).toBe(true);
			expect(got.objects).toHaveLength(2);
		}
	});

	test('an error event throws with the server message and code', async () => {
		const stream = frame('progress', { stage: 'generating', round: 1 }) + frame('error', { error: 'upstream', message: 'The model provider failed.', status: 502 });
		const error = await readGenerateEvents(readSse(chunked(stream, 5))).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(CliError);
		expect((error as CliError).message).toBe('The model provider failed.');
		expect((error as CliError).code).toBe('upstream');
		expect((error as CliError).details).toMatchObject({ status: 502 });
	});

	test('a stream that ends without a result is an error, not a silent success', async () => {
		const stream = frame('progress', { stage: 'generating', round: 1 });
		await expect(readGenerateEvents(readSse(chunked(stream, 3)))).rejects.toThrow(/closed before the config was ready/);
	});

	test('unreadable data is a protocol error', async () => {
		await expect(readGenerateEvents(readSse(chunked('event: result\ndata: {nope\n\n', 4)))).rejects.toThrow(/unreadable result event/);
	});
});

describe('formatting', () => {
	test('progress lines', () => {
		expect(progressLine({ stage: 'generating', round: 1 })).toBe('Writing…');
		expect(progressLine({ stage: 'generating', round: 2 })).toBe('Writing… (round 2)');
		expect(progressLine({ stage: 'repairing', round: 2, errors: 1 })).toBe('Fixing 1 problem… (round 2)');
		expect(progressLine({ stage: 'repairing', round: 3, errors: 2 })).toBe('Fixing 2 problems… (round 3)');
		expect(progressLine({ stage: 'dry-run' })).toBe('Checking with the cluster…');
	});

	test('findings: errors first, infos only when verbose, fixes marked', () => {
		const findings = result().findings;
		expect(visibleFindings(findings).map((item) => item.severity)).toEqual(['error', 'warning']);
		expect(visibleFindings(findings, true).map((item) => item.severity)).toEqual(['error', 'warning', 'info']);
		expect(formatFinding(findings[0]!)).toBe('info    Deployment/web spec.template: Added default resources. (fixed automatically)');
		expect(formatFinding({ ...findings[1]!, object: null, path: null })).toBe('warning No readiness probe.');
	});

	test('the generate report lists summary, objects, findings, assumptions and questions', () => {
		const text = formatGenerateResult(result());
		expect(text.split('\n')[0]).toBe('nginx on shop.sites.test with 2 replicas.');
		expect(text).toContain('  Deployment/web (default)');
		expect(text).toContain('error   Deployment/web spec.template: Image has no tag.');
		expect(text).not.toContain('Added default resources');
		expect(text).toContain('Assumptions:\n  - Port 80.');
		expect(text).toContain('Questions:\n  - Which image tag?');
		expect(text).toContain('still has errors');
		expect(text).not.toContain('test-model');
		expect(formatGenerateResult(result(), { verbose: true })).toContain('Model test-model, 3 rounds.');
	});

	test('apply outcomes, failures and lint stops', () => {
		const applied: KubernetesApplyResult = {
			dryRun: false,
			ok: false,
			outcomes: [
				{ kind: 'Deployment', name: 'web', namespace: 'shop', ok: true, result: 'created', message: null },
				{ kind: 'Ingress', name: 'web', namespace: 'shop', ok: false, result: 'Forbidden', message: 'cannot patch' },
			],
			findings: [],
		};
		const text = formatApplyResult(applied, { cluster: 'lab' });
		expect(text.split('\n')[0]).toMatch(/^KIND\s+NAME\s+NAMESPACE\s+RESULT\s+MESSAGE$/);
		expect(text).toContain('FAILED: Forbidden');
		expect(text).toContain('1 of 2 objects failed on "lab".');
		const dry = formatApplyResult({ ...applied, dryRun: true, ok: true, outcomes: [applied.outcomes[0]!] }, { cluster: 'lab' });
		expect(dry).toContain('Dry run passed on "lab": the API server accepted 1 object. Nothing was changed.');
		const stopped = formatApplyResult({ dryRun: true, ok: false, outcomes: [], findings: [finding('error', 'Missing apiVersion.')] });
		expect(stopped).toContain('Nothing was sent to the cluster');
		expect(stopped).toContain('Missing apiVersion.');
	});

	test('exit status follows result.ok and the dry run', () => {
		expect(generateFailed(result())).toBe(true);
		expect(generateFailed(result({ ok: true }))).toBe(false);
		expect(generateFailed(result({ ok: true, dryRun: { dryRun: true, ok: false, outcomes: [], findings: [] } }))).toBe(true);
	});
});

describe('ApiClient config generation', () => {
	test('asks for an event stream and applies with the YAML as given', async () => {
		const seen: Array<{ path: string; accept: string | null; body: unknown }> = [];
		const server = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			async fetch(request) {
				const path = new URL(request.url).pathname;
				seen.push({ path, accept: request.headers.get('accept'), body: await request.json() });
				if (path.endsWith('/generate'))
					return new Response(frame('progress', { stage: 'generating', round: 1 }) + frame('result', result({ ok: true })), {
						headers: { 'content-type': 'text/event-stream' },
					});
				return Response.json({ dryRun: true, ok: true, outcomes: [], findings: [] });
			},
		});
		try {
			const client = new ApiClient({ baseUrl: `http://127.0.0.1:${server.port}`, token: 'sk_test' });
			const stages: string[] = [];
			const got = await client.generateKubernetesConfig('lab', { prompt: 'nginx', namespace: 'shop' }, { onProgress: (p) => stages.push(p.stage) });
			expect(got.ok).toBe(true);
			expect(stages).toEqual(['generating']);
			expect(seen[0]).toEqual({ path: '/api/v1/kubernetes/lab/generate', accept: 'text/event-stream', body: { prompt: 'nginx', namespace: 'shop' } });
			const { result: applied } = await client.applyKubernetesConfig('lab', { yaml: 'kind: X', dryRun: true });
			expect(applied.dryRun).toBe(true);
			expect(seen[1]!.body).toEqual({ yaml: 'kind: X', dryRun: true });
		} finally {
			server.stop(true);
		}
	});

	test('fast failures keep their status as an ApiError', async () => {
		const server = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			fetch: () => Response.json({ error: 'unavailable', message: 'Writing configs from text needs a model provider.' }, { status: 503 }),
		});
		try {
			const client = new ApiClient({ baseUrl: `http://127.0.0.1:${server.port}`, token: 'sk_test' });
			const error = await client.generateKubernetesConfig('lab', { prompt: 'nginx' }).catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(ApiError);
			expect((error as ApiError).status).toBe(503);
			expect((error as ApiError).message).toContain('needs a model provider');
		} finally {
			server.stop(true);
		}
	});
});
