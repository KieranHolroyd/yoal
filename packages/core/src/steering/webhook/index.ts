import type { SteeringDriver } from '@yoal/contracts';
import { readFileSync } from 'node:fs';
import { WebhookDriver, webhookConfigFromEnv, type WebhookDriverOptions } from './driver.ts';
import type { SteeringDriverContext } from '../types.ts';

/**
 * The context-only `webhook` factory used by the registry: URL and allowlist from the
 * `YOAL_STEERING_WEBHOOK_*` environment. The core adapter (`core.ts`) replaces it with a
 * settings-backed sealed secret when the control plane has a database.
 */
export function createWebhookDriver(context: SteeringDriverContext, overrides: Partial<WebhookDriverOptions> = {}): SteeringDriver {
	return new WebhookDriver(context, {
		config: overrides.config ?? webhookConfigFromEnv(),
		secret: overrides.secret ?? (() => webhookSecretFromEnv()),
		fetchImpl: overrides.fetchImpl,
		timeoutMs: overrides.timeoutMs,
		retryDelaysMs: overrides.retryDelaysMs,
		version: overrides.version,
		maxResponseBytes: overrides.maxResponseBytes,
	});
}

/** The operator secret: an environment value or a `*_FILE` root-only file. */
export function webhookSecretFromEnv(env: Record<string, string | undefined> = process.env): string | null {
	const inline = env.YOAL_STEERING_WEBHOOK_SECRET?.trim();
	if (inline) return inline;
	const path = env.YOAL_STEERING_WEBHOOK_SECRET_FILE?.trim();
	if (!path) return null;
	try {
		const value = readFileSync(path, 'utf8').trim();
		return value || null;
	} catch {
		return null;
	}
}

export {
	WebhookDriver,
	webhookConfigFindings,
	webhookConfigFromEnv,
	type WebhookConfig,
	type WebhookDriverOptions,
	type WebhookPayloadNode,
	type WebhookReport,
} from './driver.ts';
