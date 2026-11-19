import { describe, expect, test } from 'bun:test';
import type { KubernetesGenerateResult } from '@yoal/contracts';
import {
	WriteConfigError,
	createSseParser,
	groupFindings,
	objectsInYaml,
	postApply,
	progressLabel,
	streamGenerate,
	type GenerateProgress
} from './write-config.js';

const result: KubernetesGenerateResult = {
	summary: 'nginx',
	yaml: 'kind: Deployment\n',
	objects: [{ kind: 'Deployment', name: 'web', namespace: null }],
	findings: [],
	assumptions: [],
	questions: [],
	ok: true,
	rounds: 1,
	model: 'm',
	dryRun: null
};

const frame = (event: string, data: unknown) =>
	`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** A fetch that answers with `text`, delivered `size` bytes at a time. */
function streamingFetch(text: string, size: number, status = 200) {
	const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
	const impl = (async (url: string, init?: RequestInit) => {
		calls.push({ url, init });
		const bytes = new TextEncoder().encode(text);
		let offset = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (offset >= bytes.length) return controller.close();
				controller.enqueue(bytes.slice(offset, offset + size));
				offset += size;
			}
		});
		return new Response(body, { status });
	}) as unknown as typeof fetch;
	return { impl, calls };
}

describe('createSseParser', () => {
	test('frames, comments, multi-line data and CRLF', () => {
		const parser = createSseParser();
		expect(
			parser.push(': keep-alive\n\nevent: progress\r\ndata: {"a":\r\ndata: 1}\r\n\r\n')
		).toEqual([{ event: 'progress', data: '{"a":\n1}' }]);
		expect(parser.push('data: x\n\n')).toEqual([{ event: 'message', data: 'x' }]);
	});

	test('a last frame without its blank line is still delivered at the end', () => {
		const parser = createSseParser();
		expect(parser.push('event: result\ndata: {}')).toEqual([]);
		expect(parser.end()).toEqual([{ event: 'result', data: '{}' }]);
	});
});

describe('streamGenerate', () => {
	test('posts with Accept: text/event-stream, reports progress and returns the result', async () => {
		const text =
			': keep-alive\n\n' +
			frame('progress', { stage: 'generating', round: 1 }) +
			frame('progress', { stage: 'repairing', round: 2, errors: 2 }) +
			frame('progress', { stage: 'dry-run' }) +
			frame('result', result);
		for (const size of [1, 9, 4096]) {
			const { impl, calls } = streamingFetch(text, size);
			const seen: GenerateProgress[] = [];
			const got = await streamGenerate(
				'/api/v1/kubernetes/lab/generate',
				{ prompt: 'nginx', namespace: 'default', dryRun: true },
				{ fetch: impl, onProgress: (progress) => seen.push(progress) }
			);
			expect(got).toEqual(result);
			expect(seen.map(progressLabel)).toEqual([
				'Writing…',
				'Fixing 2 problems…',
				'Checking with the cluster…'
			]);
			const headers = calls[0]!.init!.headers as Record<string, string>;
			expect(headers.accept).toBe('text/event-stream');
			expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({
				prompt: 'nginx',
				namespace: 'default',
				dryRun: true
			});
		}
	});

	test('an error event and a fast failure both carry the server message and status', async () => {
		const failing = streamingFetch(
			frame('error', { error: 'upstream', message: 'The provider failed.', status: 502 }),
			5
		);
		const streamed = await streamGenerate(
			'/x',
			{ prompt: 'p', namespace: 'default', dryRun: false },
			{ fetch: failing.impl }
		).catch((error: unknown) => error);
		expect(streamed).toBeInstanceOf(WriteConfigError);
		expect((streamed as WriteConfigError).message).toBe('The provider failed.');
		expect((streamed as WriteConfigError).status).toBe(502);

		const unavailable = (async () =>
			Response.json(
				{ error: 'unavailable', message: 'Needs a model provider.' },
				{ status: 503 }
			)) as unknown as typeof fetch;
		const fast = await streamGenerate(
			'/x',
			{ prompt: 'p', namespace: 'default', dryRun: false },
			{ fetch: unavailable }
		).catch((error: unknown) => error);
		expect((fast as WriteConfigError).status).toBe(503);
		expect((fast as WriteConfigError).code).toBe('unavailable');
	});

	test('a stream that ends without a result is an error', async () => {
		const { impl } = streamingFetch(frame('progress', { stage: 'generating', round: 1 }), 3);
		await expect(
			streamGenerate('/x', { prompt: 'p', namespace: 'default', dryRun: false }, { fetch: impl })
		).rejects.toThrow(/closed before the config was ready/);
	});
});

describe('helpers', () => {
	test('postApply returns the result or throws the server message', async () => {
		const ok = (async () =>
			Response.json({
				dryRun: true,
				ok: true,
				outcomes: [],
				findings: []
			})) as unknown as typeof fetch;
		expect(
			(await postApply('/a', { yaml: 'x', dryRun: true, namespace: 'default' }, { fetch: ok }))
				.dryRun
		).toBe(true);
		const forbidden = (async () =>
			Response.json(
				{ error: 'forbidden', message: 'Missing permission kubernetes:edit' },
				{ status: 403 }
			)) as unknown as typeof fetch;
		await expect(
			postApply('/a', { yaml: 'x', dryRun: false, namespace: 'default' }, { fetch: forbidden })
		).rejects.toThrow('Missing permission kubernetes:edit');
	});

	test('objectsInYaml reads kinds and metadata names from edited YAML', () => {
		const yaml = [
			'apiVersion: apps/v1',
			'kind: Deployment',
			'metadata:',
			'  name: web',
			'  namespace: shop',
			'  labels:',
			'    name: not-this',
			'spec:',
			'  template:',
			'    metadata:',
			'      name: nor-this',
			'---',
			'# a comment',
			'apiVersion: v1',
			'kind: Service',
			'metadata:',
			'  name: "web"',
			'---',
			''
		].join('\n');
		expect(objectsInYaml(yaml)).toEqual([
			{ kind: 'Deployment', name: 'web', namespace: 'shop' },
			{ kind: 'Service', name: 'web', namespace: null }
		]);
		expect(objectsInYaml('')).toEqual([]);
	});

	test('groupFindings keeps each severity', () => {
		const base = { document: 0, object: null, path: null, fixed: false };
		const groups = groupFindings([
			{ ...base, severity: 'warning', message: 'w' },
			{ ...base, severity: 'error', message: 'e' },
			{ ...base, severity: 'info', message: 'i', fixed: true }
		]);
		expect(groups.error.map((item) => item.message)).toEqual(['e']);
		expect(groups.warning.map((item) => item.message)).toEqual(['w']);
		expect(groups.info.map((item) => item.message)).toEqual(['i']);
	});
});
