import type { KubernetesGenerateResult, Principal } from '@yoal/contracts';
import { CoreError, manifestsToYaml, parseManifestYaml, type Manifest } from '@yoal/core';
import { assistantConfig } from './assistant/config';
import { streamChat } from './assistant/provider';
import { runPipeline, type GenerateProgress } from './kubernetes-ai-pipeline';
import { allowAssistantTurn } from './assistant/rate-limit';
import { core } from './core';

/**
 * Kubernetes configs from natural language (docs/KUBERNETES.md §18).
 *
 * The model only proposes objects; everything around it is deterministic:
 *
 * 1. Context: the cluster's real facts (version, ingress class, claimed hosts, attachment Secrets
 *    and their keys, storage classes, how much memory pods can have).
 * 2. Generate: one tool call, `emit_manifests`, returns objects as JSON, never YAML text, so there
 *    is nothing ambiguous to parse.
 * 3. Lint and fix: `lintManifests` repairs what Yoal owns (API versions, ingress class, TLS,
 *    LoadBalancer, default resources) and reports what it cannot.
 * 4. Repair: errors go back to the model, at most twice.
 * 5. Emit: YAML from Yoal's own emitter, then an optional server-side dry run as the caller.
 *
 * It uses the dashboard assistant's model provider (Settings → Assistant) and its turn limit.
 */

export interface GenerateOptions {
	prompt: string;
	namespace: string;
	yaml?: string;
	dryRun: boolean;
	signal?: AbortSignal;
}

/** Run the pipeline for one request. Throws a CoreError the API layer turns into a response. */
export async function generateKubernetesConfig(
	principal: Principal,
	clusterName: string,
	options: GenerateOptions
): Promise<KubernetesGenerateResult> {
	return (await prepareKubernetesGeneration(principal, clusterName, options))();
}

/**
 * Everything that can fail fast (provider, turn limit, cluster, permission, the YAML to change),
 * then a runner for the slow part. The route checks first so failures keep their status codes,
 * and streams only once the model is running.
 */
export async function prepareKubernetesGeneration(
	principal: Principal,
	clusterName: string,
	options: GenerateOptions
): Promise<(onProgress?: (event: GenerateProgress) => void) => Promise<KubernetesGenerateResult>> {
	const config = assistantConfig();
	if (!config)
		throw new CoreError(
			'unavailable',
			'Writing configs from text needs a model provider. An owner can set one in Settings → Assistant.',
			503
		);
	const limit = allowAssistantTurn(
		`k8s-generate:${principal.userId}`,
		core.policies.get().assistantTurnsPerMinute
	);
	if (!limit.ok)
		throw new CoreError(
			'rate_limited',
			`Too many requests; try again in ${limit.retryAfter}s.`,
			429
		);
	const context = core.kubernetes.manifestContext(principal, clusterName, options.namespace);
	let current: Manifest[] | null = null;
	if (options.yaml?.trim()) {
		try {
			current = parseManifestYaml(options.yaml);
		} catch (error) {
			throw new CoreError(
				'validation',
				`The YAML to change does not parse: ${error instanceof Error ? error.message : String(error)}`,
				400
			);
		}
	}
	return async (onProgress) => {
		const result = await runPipeline(
			config,
			context,
			options.prompt,
			current,
			options.signal,
			streamChat,
			onProgress
		);
		if (options.dryRun && result.ok && result.manifests.length > 0)
			onProgress?.({ stage: 'dry-run' });
		const dryRun =
			options.dryRun && result.ok && result.manifests.length > 0
				? await core.kubernetes
						.applyManifests(principal, clusterName, {
							manifests: result.manifests,
							dryRun: true,
							namespace: options.namespace
						})
						.catch((error: unknown) => ({
							dryRun: true,
							ok: false,
							outcomes: [],
							findings: [
								{
									severity: 'error' as const,
									document: null,
									object: null,
									path: null,
									message: `Dry run unavailable: ${error instanceof Error ? error.message : String(error)}`,
									fixed: false
								}
							]
						}))
				: options.dryRun
					? {
							// Say why the requested dry run did not happen instead of returning null.
							dryRun: true,
							ok: false,
							outcomes: [],
							findings: [
								{
									severity: 'warning' as const,
									document: null,
									object: null,
									path: null,
									message:
										result.manifests.length === 0
											? 'Dry run skipped: there are no objects to check.'
											: 'Dry run skipped: fix the errors above first.',
									fixed: false
								}
							]
						}
					: null;
		core.audit.record({
			principal,
			action: 'kubernetes.generate',
			resource: 'kubernetes',
			resourceId: clusterName,
			args: {
				cluster: clusterName,
				promptChars: options.prompt.length,
				edit: current !== null,
				model: config.model,
				objects: result.manifests.length,
				rounds: result.rounds,
				ok: result.ok
			},
			result: 'ok'
		});
		return {
			summary: result.summary,
			yaml: result.manifests.length > 0 ? manifestsToYaml(result.manifests) : '',
			objects: result.manifests.map((manifest) => {
				const metadata = (manifest.metadata ?? {}) as Record<string, unknown>;
				return {
					kind: String(manifest.kind ?? ''),
					name: String(metadata.name ?? ''),
					namespace: typeof metadata.namespace === 'string' ? metadata.namespace : null
				};
			}),
			findings: result.findings,
			assumptions: result.assumptions,
			questions: result.questions,
			ok: result.ok,
			rounds: result.rounds,
			model: config.model,
			dryRun
		};
	};
}

export type { GenerateProgress };
