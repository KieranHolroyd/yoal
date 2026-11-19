import { describe, expect, test } from 'bun:test';
import type { ManifestContext } from '@yoal/core';
import type { ChatOptions, ChatResult } from './assistant/provider';
import { kubernetesSystemPrompt, runPipeline, type GenerateProgress } from './kubernetes-ai-pipeline';

const config = { provider: 'openai-compatible' as const, baseUrl: 'http://model.test/v1', model: 'test-model' };
const context: ManifestContext = {
	cluster: 'lab',
	minor: '1.37',
	namespace: 'default',
	ingressClass: 'traefik',
	routeHosts: ['shop.sites.test'],
	contentDomain: 'sites.test',
	secrets: [{ namespace: 'default', name: 'yoal-shopdb', keys: ['URL', 'HOST', 'PASSWORD'], kind: 'database' }],
	storageClasses: ['local-path'],
	defaultStorageClass: 'local-path',
	allocatableMemoryMi: 1280,
	registryHost: null
};

const web = (image?: string) => ({
	apiVersion: 'apps/v1',
	kind: 'Deployment',
	metadata: { name: 'shop' },
	spec: {
		selector: { matchLabels: { app: 'shop' } },
		template: {
			metadata: { labels: { app: 'shop' } },
			spec: { containers: [{ name: 'shop', ...(image ? { image } : {}), envFrom: [{ secretRef: { name: 'yoal-shopdb' } }] }] }
		}
	}
});

/** A scripted model: each call returns the next reply and records what it was sent. */
function scripted(replies: ChatResult[]) {
	const calls: ChatOptions[] = [];
	const chat = async (_config: unknown, options: ChatOptions): Promise<ChatResult> => {
		calls.push(structuredClone({ ...options, signal: undefined }));
		const reply = replies.shift();
		if (!reply) throw new Error('no more replies');
		return reply;
	};
	return { chat: chat as never, calls };
}

const emit = (args: Record<string, unknown>, id = 'call_1'): ChatResult => ({
	text: '',
	toolCalls: [{ id, name: 'emit_manifests', arguments: JSON.stringify(args) }],
	finishReason: 'tool_calls'
});

describe('kubernetes config pipeline', () => {
	test('the prompt carries the cluster facts and the house rules', () => {
		const prompt = kubernetesSystemPrompt(context);
		expect(prompt).toContain('"claimedHosts": [\n    "shop.sites.test"');
		expect(prompt).toContain('yoal-shopdb');
		expect(prompt).toContain('There is no cloud load balancer');
		expect(prompt).toContain('Never add tls sections');
	});

	test('a lint error goes back to the model and the repaired set wins', async () => {
		const model = scripted([
			emit({ summary: 'Shop', manifests: [web()], assumptions: [], questions: [] }),
			emit({ summary: 'Shop on nginx', manifests: [web('nginx:1.27')], assumptions: ['nginx:1.27'], questions: [] }, 'call_2')
		]);
		const events: GenerateProgress[] = [];
		const result = await runPipeline(config, context, 'run my shop', null, undefined, model.chat, (event) => events.push(event));
		expect(result).toMatchObject({ ok: true, rounds: 2, summary: 'Shop on nginx', assumptions: ['nginx:1.27'] });
		expect(events).toEqual([
			{ stage: 'generating', round: 1 },
			{ stage: 'repairing', round: 2, errors: 1 }
		]);
		const second = model.calls[1]!;
		const feedback = second.messages[second.messages.length - 1]!;
		expect(feedback.role).toBe('tool');
		expect(feedback.content).toContain('has no image');
		expect(second.messages[second.messages.length - 2]!.tool_calls?.[0]?.id).toBe('call_1');
		expect(second.tools?.[0]?.function.name).toBe('emit_manifests');
	});

	test('it stops after three rounds and returns the last attempt with its errors', async () => {
		const bad = () => emit({ summary: 's', manifests: [web()], assumptions: [], questions: [] });
		const model = scripted([bad(), bad(), bad()]);
		const result = await runPipeline(config, context, 'x', null, undefined, model.chat);
		expect(result.ok).toBe(false);
		expect(result.rounds).toBe(3);
		expect(result.findings.some((finding) => finding.severity === 'error')).toBe(true);
	});

	test('questions without manifests are an answer, not a failure to repair', async () => {
		const model = scripted([emit({ summary: '', manifests: [], assumptions: [], questions: ['Which database should the shop use?'] })]);
		const result = await runPipeline(config, context, 'make it work', null, undefined, model.chat);
		expect(result.rounds).toBe(1);
		expect(result.ok).toBe(false);
		expect(result.questions).toEqual(['Which database should the shop use?']);
	});

	test('YAML in a code fence is accepted when a model ignores the tool', async () => {
		const model = scripted([
			{
				text: 'Here you go:\n```yaml\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: settings\ndata:\n  MODE: prod\n```\n',
				toolCalls: [],
				finishReason: 'stop'
			}
		]);
		const result = await runPipeline(config, context, 'a config map', null, undefined, model.chat);
		expect(result.ok).toBe(true);
		expect(result.manifests[0]).toMatchObject({ kind: 'ConfigMap', metadata: { name: 'settings', namespace: 'default' } });
	});

	test('manifests sent as YAML strings inside the tool call are parsed', async () => {
		const model = scripted([
			emit({ summary: 'cm', manifests: ['apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\n'], assumptions: [], questions: [] })
		]);
		const result = await runPipeline(config, context, 'x', null, undefined, model.chat);
		expect(result.manifests[0]).toMatchObject({ kind: 'ConfigMap' });
	});

	test('changing existing YAML sends it to the model', async () => {
		const model = scripted([emit({ summary: 's', manifests: [web('nginx:1.27')], assumptions: [], questions: [] })]);
		await runPipeline(config, context, 'three replicas', [web('nginx:1.27')], undefined, model.chat);
		const user = model.calls[0]!.messages[1]!.content!;
		expect(user).toContain('Change this configuration');
		expect(user).toContain('image: nginx:1.27');
		expect(user).toContain('Request: three replicas');
	});

	test('no usable reply in three rounds is an error', async () => {
		const text = (): ChatResult => ({ text: 'I cannot help with that.', toolCalls: [], finishReason: 'stop' });
		const model = scripted([text(), text(), text()]);
		await expect(runPipeline(config, context, 'x', null, undefined, model.chat)).rejects.toThrow(/did not return a configuration/);
	});
});
