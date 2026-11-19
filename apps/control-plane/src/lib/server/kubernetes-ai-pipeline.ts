import type { KubernetesGenerateProgress } from '@yoal/contracts';
import {
	CoreError,
	lintManifests,
	manifestsToYaml,
	parseManifestYaml,
	type Manifest,
	type ManifestContext,
	type ManifestFinding
} from '@yoal/core';
import type { AssistantRuntimeConfig } from './assistant/config';
import { streamChat, type ProviderMessage, type ProviderTool } from './assistant/provider';

/**
 * The model half of Kubernetes configs from natural language (docs/KUBERNETES.md §18): the system
 * prompt, the `emit_manifests` tool, and the generate → lint → repair loop. No core state, so it is
 * testable with a fake provider.
 */

const MAX_ROUNDS = 3;
const MAX_TOKENS = 8_000;

const EMIT_TOOL: ProviderTool = {
	type: 'function',
	function: {
		name: 'emit_manifests',
		description:
			'Return the complete set of Kubernetes objects for the request. Always call this exactly once per answer, with every object (not a diff).',
		parameters: {
			type: 'object',
			additionalProperties: false,
			required: ['summary', 'manifests', 'assumptions', 'questions'],
			properties: {
				summary: {
					type: 'string',
					description: 'One or two sentences: what these objects run and how it is reached.'
				},
				manifests: {
					type: 'array',
					description:
						'Kubernetes objects as JSON (apiVersion, kind, metadata, spec/data). No YAML strings.',
					items: { type: 'object' }
				},
				assumptions: {
					type: 'array',
					items: { type: 'string' },
					description:
						'Choices you made that the request did not settle (image tags, ports, sizes).'
				},
				questions: {
					type: 'array',
					items: { type: 'string' },
					description: 'Only what you genuinely cannot decide; empty when the config is complete.'
				}
			}
		}
	}
};

export function kubernetesSystemPrompt(context: ManifestContext): string {
	const facts = {
		cluster: context.cluster,
		kubernetes: context.minor,
		defaultNamespace: context.namespace,
		ingressClass: context.ingressClass,
		claimedHosts: context.routeHosts,
		hostPattern: `<label>.${context.contentDomain}`,
		attachedSecrets: context.secrets.map((secret) => ({
			namespace: secret.namespace,
			name: secret.name,
			for: secret.kind,
			keys: secret.keys
		})),
		storageClasses: context.storageClasses,
		podMemoryAvailableMi: context.allocatableMemoryMi,
		privateRegistry: context.registryHost
	};
	return [
		'You write Kubernetes manifests for a cluster managed by Yoal, a self-hosted platform. Turn the request into a complete, working set of objects and return it with the emit_manifests tool.',
		'',
		'Cluster facts (authoritative):',
		JSON.stringify(facts, null, 2),
		'',
		'Rules:',
		'- Use current API versions (apps/v1, networking.k8s.io/v1, batch/v1, autoscaling/v2, policy/v1).',
		'- There is no cloud load balancer. Services are ClusterIP. Expose HTTP with an Ingress whose ingressClassName is the cluster ingress class and whose host is one of claimedHosts, or a new single label under hostPattern (Yoal then asks the user to claim it). Never add tls sections or cert-manager annotations: Yoal terminates HTTPS.',
		'- Databases and brokers attached in Yoal are Secrets listed in attachedSecrets. Wire them with envFrom.secretRef or env[].valueFrom.secretKeyRef using exactly those names and keys. Never invent passwords or put credentials in a Secret or ConfigMap; if the app needs a database that is not attached, say so in questions.',
		'- Set resources.requests (cpu, memory) and a memory limit on every container, sized to fit podMemoryAvailableMi across all replicas.',
		'- Pin image tags (never :latest). Prefer official images. Images in the private registry are <registry>/<org>/<name>:<tag>.',
		'- Give web workloads readiness and liveness probes. Use matching labels between selectors, pod templates and Services (app.kubernetes.io/name).',
		'- Persistent data uses a PersistentVolumeClaim on a listed storage class; volumes are ReadWriteOnce on one node. Prefer the attached Yoal database for shared state.',
		'- Do not use hostPath, hostNetwork or privileged containers unless the request explicitly needs them.',
		'- Put namespaced objects in defaultNamespace unless the request names another; include a Namespace object only when it is not default.',
		'- When asked to change existing YAML, return the whole updated set, keeping names and anything the request did not mention.',
		'- If the request is not about running something on Kubernetes, return no manifests and explain in questions.'
	].join('\n');
}

/** Progress the dashboard shows while a config is written. */
export type GenerateProgress = KubernetesGenerateProgress;

export interface PipelineResult {
	summary: string;
	manifests: Manifest[];
	findings: ManifestFinding[];
	assumptions: string[];
	questions: string[];
	ok: boolean;
	rounds: number;
}

/** Model rounds with lint feedback. Exported for tests (the provider is swappable). */
export async function runPipeline(
	config: AssistantRuntimeConfig,
	context: ManifestContext,
	prompt: string,
	current: Manifest[] | null,
	signal?: AbortSignal,
	chat: typeof streamChat = streamChat,
	onProgress?: (event: GenerateProgress) => void
): Promise<PipelineResult> {
	const messages: ProviderMessage[] = [
		{ role: 'system', content: kubernetesSystemPrompt(context) },
		{
			role: 'user',
			content: current
				? `Change this configuration:\n\n${manifestsToYaml(current)}\nRequest: ${prompt}`
				: prompt
		}
	];
	let last: PipelineResult | null = null;
	for (let round = 1; round <= MAX_ROUNDS; round++) {
		onProgress?.(
			round === 1 || !last
				? { stage: 'generating', round }
				: {
						stage: 'repairing',
						round,
						errors: last.findings.filter((finding) => finding.severity === 'error').length
					}
		);
		const reply = await chat(config, {
			messages,
			tools: [EMIT_TOOL],
			temperature: 0.1,
			maxTokens: MAX_TOKENS,
			...(signal ? { signal } : {})
		});
		const call = reply.toolCalls.find((item) => item.name === 'emit_manifests');
		const emitted = call ? parseEmit(call.arguments) : parseFallback(reply.text);
		if (!emitted) {
			if (round === MAX_ROUNDS) break;
			messages.push({ role: 'assistant', content: reply.text || null });
			messages.push({
				role: 'user',
				content: 'Call emit_manifests with the complete set of objects as JSON.'
			});
			continue;
		}
		const lint = lintManifests(emitted.manifests, context);
		last = {
			summary: emitted.summary,
			manifests: lint.manifests,
			findings: lint.findings,
			assumptions: emitted.assumptions,
			questions: emitted.questions,
			ok: lint.ok && lint.manifests.length > 0,
			rounds: round
		};
		// No manifests with questions is a complete answer: the model needs more from the user.
		if (
			lint.ok ||
			(emitted.manifests.length === 0 && emitted.questions.length > 0) ||
			round === MAX_ROUNDS
		)
			break;
		const errors = lint.findings.filter((finding) => finding.severity === 'error');
		const callId = call?.id ?? `emit_${round}`;
		messages.push({
			role: 'assistant',
			content: null,
			tool_calls: [
				{
					id: callId,
					type: 'function',
					function: { name: 'emit_manifests', arguments: call?.arguments ?? '{}' }
				}
			]
		});
		messages.push({
			role: 'tool',
			tool_call_id: callId,
			content: `These objects do not pass validation:\n${errors
				.map(
					(finding) =>
						`- ${finding.object ?? 'config'}${finding.path ? ` (${finding.path})` : ''}: ${finding.message}`
				)
				.join('\n')}\nFix them and call emit_manifests again with the complete set.`
		});
	}
	if (!last)
		throw new CoreError(
			'model_error',
			'The model did not return a configuration. Try rephrasing the request.',
			502
		);
	return last;
}

function parseEmit(
	raw: string
): { summary: string; manifests: unknown[]; assumptions: string[]; questions: string[] } | null {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!value || typeof value !== 'object') return null;
	const record = value as Record<string, unknown>;
	// Some models send each manifest as a YAML or JSON string despite the schema.
	const manifests = (Array.isArray(record.manifests) ? record.manifests : []).flatMap(
		(item): unknown[] => {
			if (typeof item !== 'string') return [item];
			try {
				return parseManifestYaml(item);
			} catch {
				return [item];
			}
		}
	);
	const strings = (value: unknown) =>
		Array.isArray(value)
			? value.filter((item): item is string => typeof item === 'string').slice(0, 20)
			: [];
	return {
		summary: typeof record.summary === 'string' ? record.summary.slice(0, 1000) : '',
		manifests,
		assumptions: strings(record.assumptions),
		questions: strings(record.questions)
	};
}

/** A model that ignored the tool and wrote YAML in a code fence. */
function parseFallback(
	text: string
): { summary: string; manifests: unknown[]; assumptions: string[]; questions: string[] } | null {
	const fences = [...text.matchAll(/```(?:ya?ml|json)?\s*\n([\s\S]*?)```/g)].map(
		(match) => match[1]!
	);
	if (fences.length === 0) return null;
	try {
		const manifests = fences.flatMap((fence) => parseManifestYaml(fence));
		const summary =
			text
				.replace(/```[\s\S]*?```/g, '')
				.trim()
				.split('\n')[0] ?? '';
		return { summary: summary.slice(0, 1000), manifests, assumptions: [], questions: [] };
	} catch {
		return null;
	}
}
