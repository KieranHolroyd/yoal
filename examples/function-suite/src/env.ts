import type { ChatRoom, Counter } from './objects.ts';
import type { Toolbox } from './toolbox.ts';

/** Messages on suite-jobs. `kind` decides what the consumer does with it. */
export interface JobMessage {
	id: string;
	/** echo: ack · retry-once: retry on the first attempt · fail: always retry (→ DLQ) · delay · external */
	kind: 'echo' | 'retry-once' | 'fail' | 'delay' | 'external';
	sentAt: number;
}

/** `env.AUTH` exists only when exactly one user pool is attached to the project (IAM.md I28). */
export interface AuthBinding {
	verify(request: Request | string): Promise<Record<string, unknown> | null>;
}

export interface Env {
	// vars
	SUITE_GREETING: string;
	SUITE_CONFIG: { version: number; suite: string };
	/** `wrangler dev --var SUITE_LOCAL:1`: skip checks that need the platform. */
	SUITE_LOCAL?: string;
	// secrets
	SUITE_SECRET?: string;
	// bindings
	ASSETS: Fetcher;
	KV: KVNamespace;
	DB: D1Database;
	BUCKET: R2Bucket;
	COUNTER: DurableObjectNamespace<Counter>;
	ROOM: DurableObjectNamespace<ChatRoom>;
	HYPERDRIVE?: Hyperdrive;
	ANALYTICS: AnalyticsEngineDataset;
	JOBS: Queue<JobMessage>;
	TOOLBOX: Service<Toolbox>;
	COMPANION?: Fetcher;
	// added by Yoal without a manifest entry
	AUTH?: AuthBinding;
	SENTRY_DSN?: string;
}

export const QUEUES = {
	jobs: 'suite-jobs',
	dlq: 'suite-jobs-dlq',
	events: 'suite-events',
} as const;

/** R2 keys under this prefix are watched by the provisioned event rule. */
export const EVENT_PREFIX = 'events/';

export function isLocal(env: Env): boolean {
	return env.SUITE_LOCAL === '1' || env.SUITE_LOCAL === 'true';
}
