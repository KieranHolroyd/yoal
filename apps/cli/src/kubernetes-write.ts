/**
 * Kubernetes configs from plain language (docs/KUBERNETES.md §18): the wire types, the reader for
 * the generate endpoint's event stream, and pure formatting for `yoal k8s write` and
 * `yoal k8s apply`. Types mirror `packages/contracts/src/kubernetes.ts`; the CLI bundle stays free
 * of runtime dependencies (D40), so keep them in sync.
 */
import { CliError } from './errors.ts';
import { renderTable } from './output.ts';
import type { SseEvent } from './sse.ts';

export interface KubernetesManifestFinding {
	severity: 'error' | 'warning' | 'info';
	document: number | null;
	object: string | null;
	path: string | null;
	message: string;
	fixed: boolean;
}

export interface KubernetesObjectRef {
	kind: string;
	name: string;
	namespace: string | null;
}

export interface KubernetesApplyOutcome extends KubernetesObjectRef {
	ok: boolean;
	/** `created`, `configured`, `unchanged`, or the API server's reason on failure. */
	result: string;
	message: string | null;
}

export interface KubernetesApplyResult {
	dryRun: boolean;
	ok: boolean;
	outcomes: KubernetesApplyOutcome[];
	findings: KubernetesManifestFinding[];
}

export interface KubernetesGenerateResult {
	summary: string;
	yaml: string;
	objects: KubernetesObjectRef[];
	findings: KubernetesManifestFinding[];
	assumptions: string[];
	questions: string[];
	ok: boolean;
	rounds: number;
	model: string;
	dryRun: KubernetesApplyResult | null;
}

export interface KubernetesGenerateInput {
	prompt: string;
	namespace?: string;
	/** Existing YAML to change instead of starting over. */
	yaml?: string;
	dryRun?: boolean;
}

export interface KubernetesApplyInput {
	yaml: string;
	dryRun?: boolean;
	namespace?: string;
}

export type KubernetesGenerateProgress =
	| { stage: 'generating'; round: number }
	| { stage: 'repairing'; round: number; errors: number }
	| { stage: 'dry-run' };

/** One line for a progress event: "Writing…", "Fixing 2 problems…", "Checking with the cluster…". */
export function progressLine(progress: KubernetesGenerateProgress): string {
	if (progress.stage === 'dry-run') return 'Checking with the cluster…';
	if (progress.stage === 'repairing')
		return `Fixing ${progress.errors} ${progress.errors === 1 ? 'problem' : 'problems'}… (round ${progress.round})`;
	return progress.round > 1 ? `Writing… (round ${progress.round})` : 'Writing…';
}

function parseData(event: SseEvent): unknown {
	try {
		return JSON.parse(event.data);
	} catch {
		throw new CliError(`The platform sent an unreadable ${event.event} event.`, { code: 'protocol', details: event.data.slice(0, 500) });
	}
}

/**
 * Consume the generate endpoint's events: `progress` frames go to `onProgress`, then exactly one
 * `result` (returned) or `error` (thrown as a CliError with the server's code and status).
 */
export async function readGenerateEvents(
	events: AsyncIterable<SseEvent>,
	onProgress: (progress: KubernetesGenerateProgress) => void = () => undefined,
): Promise<KubernetesGenerateResult> {
	for await (const event of events) {
		if (event.event === 'progress') {
			const progress = parseData(event) as KubernetesGenerateProgress;
			if (progress && typeof progress === 'object' && typeof progress.stage === 'string') onProgress(progress);
			continue;
		}
		if (event.event === 'result') {
			const result = parseData(event) as KubernetesGenerateResult;
			if (!result || typeof result !== 'object' || typeof result.yaml !== 'string')
				throw new CliError('The platform returned an unexpected config result.', { code: 'protocol', details: result });
			return result;
		}
		if (event.event === 'error') {
			const body = (parseData(event) ?? {}) as { error?: unknown; message?: unknown; status?: unknown };
			const status = typeof body.status === 'number' ? body.status : undefined;
			throw new CliError(typeof body.message === 'string' && body.message ? body.message : 'Generating the config failed.', {
				code: typeof body.error === 'string' ? body.error : 'error',
				details: status === undefined ? body : { ...body, status },
			});
		}
	}
	throw new CliError('The connection closed before the config was ready. Try again.', { code: 'network' });
}

const SEVERITY_ORDER: Record<KubernetesManifestFinding['severity'], number> = { error: 0, warning: 1, info: 2 };

/** One finding as a line: `error  Deployment/web spec.replicas: … (fixed automatically)`. */
export function formatFinding(finding: KubernetesManifestFinding): string {
	const where = [finding.object, finding.path].filter(Boolean).join(' ');
	return `${finding.severity.padEnd(7)} ${where ? `${where}: ` : ''}${finding.message}${finding.fixed ? ' (fixed automatically)' : ''}`;
}

/** Errors and warnings, plus infos when `verbose`, most severe first. */
export function visibleFindings(findings: KubernetesManifestFinding[], verbose = false): KubernetesManifestFinding[] {
	return findings
		.filter((finding) => verbose || finding.severity !== 'info')
		.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

export function objectLabel(object: KubernetesObjectRef): string {
	return `${object.kind}/${object.name}${object.namespace ? ` (${object.namespace})` : ''}`;
}

/** Per-object apply or dry-run outcomes. */
export function outcomeTable(outcomes: KubernetesApplyOutcome[]): string {
	return renderTable(
		['KIND', 'NAME', 'NAMESPACE', 'RESULT', 'MESSAGE'],
		outcomes.map((outcome) => [
			outcome.kind,
			outcome.name,
			outcome.namespace ?? '-',
			outcome.ok ? outcome.result : `FAILED: ${outcome.result}`,
			outcome.message ?? '',
		]),
	);
}

/** The apply/dry-run report: lint findings that stopped it, or the outcome table and a verdict. */
export function formatApplyResult(result: KubernetesApplyResult, options: { verbose?: boolean; cluster?: string } = {}): string {
	const lines: string[] = [];
	const findings = visibleFindings(result.findings, options.verbose);
	if (result.outcomes.length === 0 && !result.ok) {
		lines.push('Nothing was sent to the cluster: the YAML has errors.');
	} else if (result.outcomes.length > 0) {
		lines.push(outcomeTable(result.outcomes));
	}
	if (findings.length > 0) lines.push('', 'Findings:', ...findings.map((finding) => `  ${formatFinding(finding)}`));
	const failed = result.outcomes.filter((outcome) => !outcome.ok).length;
	const target = options.cluster ? ` on "${options.cluster}"` : '';
	if (result.ok)
		lines.push(
			'',
			result.dryRun
				? `Dry run passed${target}: the API server accepted ${result.outcomes.length} ${result.outcomes.length === 1 ? 'object' : 'objects'}. Nothing was changed.`
				: `Applied ${result.outcomes.length} ${result.outcomes.length === 1 ? 'object' : 'objects'}${target}.`,
		);
	else if (failed > 0)
		lines.push('', `${failed} of ${result.outcomes.length} ${result.outcomes.length === 1 ? 'object' : 'objects'} failed${result.dryRun ? ' the dry run' : ''}${target}.`);
	return lines.join('\n').replace(/^\n+/, '');
}

/** The human report for a generated config (everything except the YAML itself). */
export function formatGenerateResult(result: KubernetesGenerateResult, options: { verbose?: boolean; cluster?: string } = {}): string {
	const lines: string[] = [];
	if (result.summary) lines.push(result.summary.trim());
	if (result.objects.length > 0) lines.push('', 'Objects:', ...result.objects.map((object) => `  ${objectLabel(object)}`));
	const findings = visibleFindings(result.findings, options.verbose);
	if (findings.length > 0) lines.push('', 'Findings:', ...findings.map((finding) => `  ${formatFinding(finding)}`));
	if (result.assumptions.length > 0) lines.push('', 'Assumptions:', ...result.assumptions.map((item) => `  - ${item}`));
	if (result.questions.length > 0) lines.push('', 'Questions:', ...result.questions.map((item) => `  - ${item}`));
	if (result.dryRun) lines.push('', 'Dry run on the cluster:', formatApplyResult(result.dryRun, options));
	if (!result.ok) lines.push('', 'The config still has errors; fix them or refine it with --from before applying.');
	if (options.verbose) lines.push('', `Model ${result.model}, ${result.rounds} ${result.rounds === 1 ? 'round' : 'rounds'}.`);
	return lines.join('\n').replace(/^\n+/, '');
}

/** True when the CLI should exit non-zero for this generated config. */
export function generateFailed(result: KubernetesGenerateResult): boolean {
	return !result.ok || (result.dryRun !== null && !result.dryRun.ok);
}
