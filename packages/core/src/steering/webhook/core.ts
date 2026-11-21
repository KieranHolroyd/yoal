import type { CoreContext } from '../../context.ts';
import { WebhookDriver, webhookConfigFromEnv, webhookSecretFromEnv, type WebhookConfig } from './index.ts';

/**
 * The production adapter for `webhook` (HA-PLAN H18, W8).
 *
 * The operator URL is ordinary configuration; the HMAC secret is sealed with the platform key and
 * opened per request. Nothing about the secret is stored in a view, a log line or a payload. The
 * settings document lives under `ha:steering_webhook`, so this lane needs no migration:
 *
 *   { "url": "https://ops.example.com/yoal", "allowHosts": ["ops.example.com"],
 *     "allowPrivateNetwork": false, "secretSealed": "<nonce.ciphertext>" }
 */

export const WEBHOOK_SETTINGS_KEY = 'ha:steering_webhook';
const PLATFORM_KEY_ORG = 'platform';

export interface SealedWebhookSettings {
	url: string;
	allowHosts?: string[];
	allowPrivateNetwork?: boolean;
	secretSealed: string;
}

/** Store a sealed webhook configuration. For the future Settings → High availability surface. */
export function setWebhookSettings(
	ctx: Pick<CoreContext, 'secrets' | 'sqlite' | 'now'>,
	input: { url: string; secret: string; allowHosts?: string[]; allowPrivateNetwork?: boolean },
): SealedWebhookSettings {
	const settings: SealedWebhookSettings = {
		url: input.url,
		...(input.allowHosts ? { allowHosts: input.allowHosts } : {}),
		...(input.allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
		secretSealed: ctx.secrets.seal(PLATFORM_KEY_ORG, input.secret),
	};
	ctx.sqlite.run(
		'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
		[WEBHOOK_SETTINGS_KEY, JSON.stringify(settings), ctx.now()],
	);
	return settings;
}

export function readWebhookSettings(ctx: Pick<CoreContext, 'sqlite'>): SealedWebhookSettings | null {
	const row = ctx.sqlite.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?').get(WEBHOOK_SETTINGS_KEY);
	if (!row) return null;
	try {
		const parsed = JSON.parse(row.value) as Partial<SealedWebhookSettings>;
		if (typeof parsed.url !== 'string' || typeof parsed.secretSealed !== 'string') return null;
		return {
			url: parsed.url,
			secretSealed: parsed.secretSealed,
			allowHosts: Array.isArray(parsed.allowHosts) ? parsed.allowHosts.filter((host): host is string => typeof host === 'string') : undefined,
			allowPrivateNetwork: parsed.allowPrivateNetwork === true,
		};
	} catch {
		return null;
	}
}

export function createWebhookDriverFromCore(ctx: CoreContext): WebhookDriver {
	const stored = readWebhookSettings(ctx);
	const config: WebhookConfig | null = stored
		? { url: stored.url, allowHosts: stored.allowHosts, allowPrivateNetwork: stored.allowPrivateNetwork }
		: webhookConfigFromEnv();
	return new WebhookDriver(
		ctx.steering.driverContext(),
		{
			config,
			secret: () => (stored ? ctx.secrets.open(PLATFORM_KEY_ORG, stored.secretSealed) : webhookSecretFromEnv()),
			fetchImpl: ctx.config.webhookFetch,
		},
	);
}
