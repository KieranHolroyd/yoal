import { isIP } from 'node:net';
import type { SteeringCapabilities, SteeringDriver } from '@yoal/contracts';
import { ingressNodes, isDraining, isHealthy } from '../snapshot.ts';
import type { SteeringDriverContext, SteeringFinding, SteeringNode } from '../types.ts';
import { signWebhookBody, SIGNATURE_HEADER } from '../../webhook-signature.ts';
import { INGRESS_HEALTH_PATH } from '../external-lb/index.ts';

/**
 * `webhook` (HA-PLAN H18, W8): the escape hatch for anything Yoal does not speak natively.
 *
 * Yoal POSTs the signed desired ingress set to one operator URL and reads an acknowledgement back.
 * The operator's system owns the actual steering; Yoal owns the decision (which ingress nodes are
 * healthy and should serve), the signature and the last-healthy refusal.
 *
 * - **Signature.** Stripe's scheme (`x-yoal-signature: t=…,v1=…`), HMAC-SHA256 over `<t>.<body>`.
 *   The secret is resolved per request from a sealed value and is never in the body, a log line or
 *   an `observe()` view.
 * - **Allowlist.** The URL is explicit operator configuration. It must be https, must not carry
 *   credentials, and must match the configured host allowlist. A private/loopback target is
 *   refused unless the operator explicitly allows it (a LAN collector).
 * - **Acknowledgement.** `2xx` plus JSON `{ "accepted": true }`. An answer that is not an
 *   acknowledgement is a failure; the previous intended set stays in place.
 * - **Bounds.** One request per changed set; a 5 s timeout; retries at 5 s, 15 s, 45 s, then every
 *   60 s, and no retry at all for a 4xx that the same body cannot fix.
 * - **Last healthy.** Neither a failed request nor an acknowledgement may withdraw the last healthy
 *   ingress. A bad `serving` list is refused, not adopted.
 */

export interface WebhookConfig {
	url: string;
	/** Hosts the operator has allowlisted. Empty means the URL's own host is the list. */
	allowHosts?: string[];
	/** Allow a private/loopback collector (a LAN integration). Off by default. */
	allowPrivateNetwork?: boolean;
}

export interface WebhookDriverOptions {
	config: WebhookConfig | null;
	/** Open the sealed HMAC secret at request time. Returning null refuses the write. */
	secret: () => string | null;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	retryDelaysMs?: number[];
	version?: string;
	maxResponseBytes?: number;
}

export interface WebhookPayloadNode {
	id: string;
	name: string;
	zone: string;
	address: string | null;
}

export interface WebhookReport {
	/** Nodes the acknowledgement removed, or that the driver refused to remove. */
	withdrawn: string[];
	added: string[];
	records: string[];
	written: number;
	error: string | null;
	nextAttemptAt: number | null;
}

interface DeliverySuccess {
	ok: true;
	serving: string[] | null;
}
interface DeliveryFailure {
	ok: false;
	retryable: boolean;
	error: string;
}

const RETRY_DEFAULTS = [5_000, 15_000, 45_000, 60_000];
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_URL_LENGTH = 2_048;
const ACK_KEYS = new Set(['accepted', 'serving', 'reason']);

export class WebhookDriver implements SteeringDriver {
	readonly kind = 'webhook' as const;
	readonly capabilities: SteeringCapabilities = { probes: 'external', writes: true, preservesClientIp: 'native' };

	readonly #options: WebhookDriverOptions;
	private readonly context: SteeringDriverContext;
	#serving: string[] | null = null;
	#lastDelivered: string | null = null;
	#lastDeliveredAt: number | null = null;
	#lastError: string | null = null;
	#lastErrorAt: number | null = null;
	#blockedFingerprint: string | null = null;
	#nextAttemptAt = 0;
	#retryIndex = 0;
	#attempts = 0;
	#report: WebhookReport = { withdrawn: [], added: [], records: [], written: 0, error: null, nextAttemptAt: null };

	constructor(context: SteeringDriverContext, options: WebhookDriverOptions) {
		this.context = context;
		this.#options = options;
	}

	preflight(): SteeringFinding[] {
		const findings: SteeringFinding[] = [];
		const config = this.#options.config;
		for (const reason of webhookConfigFindings(config)) findings.push({ nodeId: null, reason });
		const nodes = ingressNodes(this.context);
		if (nodes.length === 0) {
			findings.push({
				nodeId: null,
				reason: 'webhook needs at least one ingress node: give a node the ingress role and an agent with the ingress-set capability first.',
			});
			return findings;
		}
		for (const node of nodes) {
			if (!node.capable)
				findings.push({
					nodeId: node.id,
					reason: `${node.name} cannot serve the ingress health endpoint: its agent does not advertise ingress-set, so the webhook would describe traffic it cannot take.`,
				});
		}
		if (!this.#secretAvailable())
			findings.push({ nodeId: null, reason: 'The webhook HMAC secret is missing or cannot be opened; every request is signed, so nothing is sent without it.' });
		return findings;
	}

	async desired(): Promise<void> {
		const now = this.context.now();
		const config = this.#options.config;
		const findings = webhookConfigFindings(config);
		if (findings.length > 0) {
			this.#report = { withdrawn: [], added: [], records: [...(this.#serving ?? [])], written: 0, error: findings[0]!, nextAttemptAt: null };
			return;
		}
		const nodes = ingressNodes(this.context);
		const healthy = nodes
			.filter((node) => isHealthy(node, now) && !isDraining(node))
			.map((node) => node.id)
			.sort();
		const previous = this.#serving;
		const next = healthy.length > 0 ? healthy : previous && previous.length > 0 ? previous : nodes.map((node) => node.id);
		this.#serving = next;

		const payload = this.#payload(now, nodes, healthy, next);
		const fingerprint = fingerprintOf(payload.canonical);
		if (fingerprint === this.#lastDelivered && this.#lastError === null) {
			this.#report = { withdrawn: [], added: [], records: [...next], written: 0, error: null, nextAttemptAt: null };
			return;
		}
		if (fingerprint === this.#blockedFingerprint && this.#lastError !== null) {
			this.#report = { withdrawn: [], added: [], records: [...next], written: 0, error: this.#lastError, nextAttemptAt: null };
			return;
		}
		if (now < this.#nextAttemptAt) {
			this.#report = { withdrawn: [], added: [], records: [...next], written: 0, error: this.#lastError, nextAttemptAt: this.#nextAttemptAt };
			return;
		}
		if (!this.#secretAvailable()) {
			this.#fail(fingerprint, now, 'The webhook HMAC secret is missing or cannot be opened; nothing was sent.', false);
			this.#report = { withdrawn: [], added: [], records: [...next], written: 0, error: this.#lastError, nextAttemptAt: this.#nextAttemptAt };
			return;
		}

		this.#attempts += 1;
		const result = await this.#deliver(config!, payload.body, fingerprint, now);
		if (!result.ok) {
			this.#fail(fingerprint, now, result.error, result.retryable);
			this.#report = { withdrawn: [], added: [], records: [...next], written: 1, error: this.#lastError, nextAttemptAt: result.retryable ? this.#nextAttemptAt : null };
			return;
		}

		const adopted = result.serving ?? next;
		const refused = this.#lastHealthyRefusal(nodes, adopted) ?? (adopted.length === 0 && (previous?.length ?? 0) > 0 ? 'The webhook acknowledgement would withdraw the last healthy ingress; the previous set stays in place.' : null);
		if (refused) {
			this.#fail(fingerprint, now, refused, false);
			this.#report = { withdrawn: [], added: [], records: [...next], written: 1, error: refused, nextAttemptAt: null };
			return;
		}
		const before = previous ?? next;
		this.#serving = adopted;
		this.#lastDelivered = fingerprint;
		this.#lastDeliveredAt = now;
		this.#lastError = null;
		this.#lastErrorAt = null;
		this.#blockedFingerprint = null;
		this.#nextAttemptAt = 0;
		this.#retryIndex = 0;
		this.#report = {
			withdrawn: before.filter((id) => !adopted.includes(id)),
			added: adopted.filter((id) => !before.includes(id)),
			records: [...adopted],
			written: 1,
			error: null,
			nextAttemptAt: null,
		};
	}

	async observe(): Promise<Record<string, unknown>> {
		const now = this.context.now();
		const nodes = ingressNodes(this.context);
		const healthy = nodes.filter((node) => isHealthy(node, now)).map((node) => node.id);
		return {
			kind: this.kind,
			observedAt: now,
			provider: 'webhook',
			probes: 'external',
			writes: true,
			clientIp: 'native',
			// Origin and path only: a query string can carry a token the operator pasted.
			url: this.#options.config ? safeUrlForView(this.#options.config.url) : null,
			healthy,
			serving: this.#serving ?? healthy,
			last: {
				deliveredAt: this.#lastDeliveredAt,
				error: this.#lastError,
				errorAt: this.#lastErrorAt,
				attempts: this.#attempts,
				nextAttemptAt: this.#nextAttemptAt > 0 ? this.#nextAttemptAt : null,
			},
			nodes: nodes.map((node) => ({
				id: node.id,
				name: node.name,
				zone: node.zone,
				status: node.status,
				address: node.address ?? null,
				healthy: isHealthy(node, now),
				draining: isDraining(node),
				capable: node.capable,
			})),
			total: nodes.length,
		};
	}

	report(): WebhookReport {
		return { ...this.#report, withdrawn: [...this.#report.withdrawn], added: [...this.#report.added], records: [...this.#report.records] };
	}

	#payload(now: number, nodes: SteeringNode[], healthy: string[], serving: string[]): { body: string; canonical: string } {
		const settings = this.context.settings();
		const canonical = {
			version: 1,
			kind: 'webhook',
			ingress: {
				healthy: [...healthy],
				serving: [...serving],
				healthPath: INGRESS_HEALTH_PATH,
				drainSeconds: settings.drainSeconds,
				nodes: nodes
					.map((node) => ({ id: node.id, name: node.name, zone: node.zone, address: node.address ?? null }))
					.sort((left, right) => left.id.localeCompare(right.id)),
			},
		};
		return { canonical: JSON.stringify(canonical), body: JSON.stringify({ ...canonical, sentAt: now }) };
	}

	async #deliver(config: WebhookConfig, payload: string, fingerprint: string, now: number): Promise<DeliverySuccess | DeliveryFailure> {
		let secret: string;
		try {
			const opened = this.#options.secret();
			if (!opened) return { ok: false, retryable: false, error: 'The webhook HMAC secret is missing or cannot be opened; nothing was sent.' };
			secret = opened;
		} catch {
			return { ok: false, retryable: false, error: 'The webhook HMAC secret could not be opened; nothing was sent.' };
		}
		const timestamp = Math.floor(now / 1000);
		const signature = signWebhookBody(secret, payload, timestamp);
		const timeout = Math.min(MAX_TIMEOUT_MS, Math.max(500, this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
		let response: Response;
		try {
			response = await (this.#options.fetchImpl ?? fetch)(config.url, {
				method: 'POST',
				redirect: 'manual',
				signal: AbortSignal.timeout(timeout),
				headers: {
					'content-type': 'application/json',
					'user-agent': `Yoal-Steering-Webhook/${this.#options.version ?? '0.1.0'}`,
					'x-yoal-steering': 'webhook',
					'x-yoal-delivery': fingerprint.slice(0, 32),
					[SIGNATURE_HEADER]: signature,
				},
				body: payload,
			});
		} catch (error) {
			const name = error instanceof Error ? error.name : '';
			const reason = name === 'TimeoutError' || name === 'AbortError' ? `no answer within ${timeout / 1000}s` : genericMessage(error);
			return { ok: false, retryable: true, error: `The webhook at ${hostOf(config.url)} could not be reached: ${reason}.` };
		}
		if (response.status >= 300 && response.status < 400)
			return { ok: false, retryable: false, error: `The webhook redirected (HTTP ${response.status}); webhooks do not follow redirects. Use the final URL.` };
		if (response.status === 408 || response.status === 429 || response.status >= 500)
			return { ok: false, retryable: true, error: `The webhook at ${hostOf(config.url)} answered HTTP ${response.status}.` };
		if (!response.ok) return { ok: false, retryable: false, error: `The webhook at ${hostOf(config.url)} answered HTTP ${response.status}.` };

		const text = await readBounded(response, this.#options.maxResponseBytes ?? MAX_RESPONSE_BYTES);
		if (text === null) return { ok: false, retryable: false, error: 'The webhook acknowledgement was larger than the accepted limit.' };
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			return { ok: false, retryable: false, error: 'The webhook acknowledgement was not JSON.' };
		}
		if (typeof body !== 'object' || body === null || Array.isArray(body))
			return { ok: false, retryable: false, error: 'The webhook acknowledgement was not a JSON object.' };
		const ack = body as Record<string, unknown>;
		if (ack.accepted !== true) return { ok: false, retryable: false, error: 'The webhook did not acknowledge the desired set (expected {"accepted": true}).' };
		for (const key of Object.keys(ack)) if (!ACK_KEYS.has(key)) return { ok: false, retryable: false, error: `The webhook acknowledgement has an unknown field "${key}".` };
		if (ack.serving === undefined) return { ok: true, serving: null };
		if (!Array.isArray(ack.serving)) return { ok: false, retryable: false, error: 'The webhook acknowledgement has a non-array "serving".' };
		const known = new Set(ingressNodes(this.context).map((node) => node.id));
		const serving = ack.serving.filter((id): id is string => typeof id === 'string');
		if (serving.length !== ack.serving.length) return { ok: false, retryable: false, error: 'The webhook acknowledgement has a non-string node id in "serving".' };
		const unknown = serving.find((id) => !known.has(id));
		if (unknown) return { ok: false, retryable: false, error: `The webhook acknowledgement names ${unknown}, which is not an ingress node.` };
		return { ok: true, serving };
	}

	#lastHealthyRefusal(nodes: SteeringNode[], adopted: string[]): string | null {
		const healthy = nodes.filter((node) => isHealthy(node, this.context.now()) && !isDraining(node)).map((node) => node.id);
		const kept = adopted.filter((id) => healthy.includes(id));
		if (healthy.length > 0 && kept.length === 0)
			return 'The webhook acknowledgement would withdraw every healthy ingress; the last healthy ingress is never removed. The previous set stays in place.';
		return null;
	}

	#fail(fingerprint: string, now: number, error: string, retryable: boolean): void {
		this.#lastError = error;
		this.#lastErrorAt = now;
		if (!retryable) {
			// The same body cannot succeed. Stop retrying until the desired set changes, so a 400
			// does not become a request every five seconds forever.
			this.#blockedFingerprint = fingerprint;
			this.#nextAttemptAt = 0;
			this.#retryIndex = 0;
			return;
		}
		const delays = this.#options.retryDelaysMs ?? RETRY_DEFAULTS;
		const delay = delays[Math.min(this.#retryIndex, delays.length - 1)] ?? 60_000;
		this.#retryIndex += 1;
		this.#nextAttemptAt = now + delay;
	}

	#secretAvailable(): boolean {
		try {
			const secret = this.#options.secret();
			return typeof secret === 'string' && secret.length > 0;
		} catch {
			return false;
		}
	}
}

/** Validation shared by preflight and the write path. */
export function webhookConfigFindings(config: WebhookConfig | null): string[] {
	if (!config) return ['The webhook driver has no operator URL. Set YOAL_STEERING_WEBHOOK_URL before enabling it.'];
	const findings: string[] = [];
	if (config.url.length > MAX_URL_LENGTH) findings.push('The webhook URL is longer than 2048 characters.');
	let url: URL | null = null;
	try {
		url = new URL(config.url);
	} catch {
		findings.push('The webhook URL is not a valid URL.');
	}
	if (url) {
		if (url.protocol !== 'https:') findings.push('The webhook URL must use https.');
		if (url.username || url.password) findings.push('The webhook URL must not carry credentials; the signature is the authentication.');
		if (url.hash) findings.push('The webhook URL must not have a fragment.');
		if (url.hostname.length === 0) findings.push('The webhook URL has no host.');
		const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
		if (!config.allowPrivateNetwork && isPrivateTarget(host))
			findings.push(`The webhook host ${host} is loopback or private; set YOAL_STEERING_WEBHOOK_ALLOW_PRIVATE=1 only for a collector you trust on the LAN.`);
		const allowed = (config.allowHosts ?? []).map((entry) => entry.trim().toLowerCase()).filter(Boolean);
		if (allowed.length > 0 && !allowed.includes(host))
			findings.push(`The webhook host ${host} is not in the allowlist (${allowed.join(', ')}).`);
	}
	for (const host of config.allowHosts ?? [])
		if (host.trim() && !/^[a-z0-9.*-]+$/i.test(host.trim())) findings.push(`The webhook allowlist entry "${host}" is not a hostname.`);
	return findings;
}

/** Parse the operator configuration from the environment. */
export function webhookConfigFromEnv(env: Record<string, string | undefined> = process.env): WebhookConfig | null {
	const url = env.YOAL_STEERING_WEBHOOK_URL?.trim();
	if (!url) return null;
	const allowHosts = (env.YOAL_STEERING_WEBHOOK_ALLOW ?? '')
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean);
	return {
		url,
		allowHosts,
		allowPrivateNetwork: ['1', 'true', 'yes', 'on'].includes((env.YOAL_STEERING_WEBHOOK_ALLOW_PRIVATE ?? '').toLowerCase()),
	};
}

function fingerprintOf(payload: string): string {
	let hash = 2_166_136_261;
	for (let index = 0; index < payload.length; index += 1) {
		hash ^= payload.charCodeAt(index);
		hash = Math.imul(hash, 16_777_619);
	}
	return `${payload.length.toString(16)}-${(hash >>> 0).toString(16)}`;
}

async function readBounded(response: Response, limit: number): Promise<string | null> {
	const reader = response.body?.getReader();
	if (!reader) return '';
	let size = 0;
	const chunks: Uint8Array[] = [];
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > limit) {
			await reader.cancel().catch(() => undefined);
			return null;
		}
		chunks.push(value);
	}
	const merged = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(merged);
}

function isPrivateTarget(host: string): boolean {
	if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
	const version = isIP(host);
	if (version === 4) {
		const [a = 0, b = 0] = host.split('.').map(Number);
		return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 0;
	}
	if (version === 6) return host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80');
	return false;
}

function safeUrlForView(value: string): string {
	try {
		const url = new URL(value);
		return `${url.origin}${url.pathname}`;
	} catch {
		return '(invalid url)';
	}
}

function hostOf(value: string): string {
	try {
		return new URL(value).host;
	} catch {
		return 'the operator URL';
	}
}

function genericMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
