import type { Env } from './env.ts';

/** D1 tables the suite writes: test rows, and what the queue/cron/event handlers saw. */
const SCHEMA = [
	'CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, name TEXT NOT NULL, n INTEGER NOT NULL)',
	`CREATE TABLE IF NOT EXISTS queue_log (
		id TEXT NOT NULL, queue TEXT NOT NULL, kind TEXT NOT NULL, attempts INTEGER NOT NULL,
		sent_at INTEGER, received_at INTEGER NOT NULL, PRIMARY KEY (id, queue, attempts))`,
	`CREATE TABLE IF NOT EXISTS event_log (
		key TEXT NOT NULL, action TEXT NOT NULL, received_at INTEGER NOT NULL, body TEXT NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS cron_log (
		cron TEXT NOT NULL, scheduled_time INTEGER NOT NULL, ran_at INTEGER NOT NULL)`,
];

let ready: Promise<void> | null = null;

/** Create the tables once per isolate. A failure is retried by the next caller. */
export function ensureSchema(env: Env): Promise<void> {
	ready ??= env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql)))
		.then(() => undefined)
		.catch((error: unknown) => {
			ready = null;
			throw error;
		});
	return ready;
}

export interface QueueLogRow {
	id: string;
	queue: string;
	kind: string;
	attempts: number;
	sent_at: number | null;
	received_at: number;
}

export async function queueSeen(env: Env, id: string): Promise<QueueLogRow[]> {
	await ensureSchema(env);
	const { results } = await env.DB.prepare('SELECT * FROM queue_log WHERE id = ? ORDER BY received_at')
		.bind(id)
		.all<QueueLogRow>();
	return results;
}

export async function eventSeen(env: Env, key: string): Promise<Array<{ key: string; action: string; received_at: number }>> {
	await ensureSchema(env);
	const { results } = await env.DB.prepare('SELECT key, action, received_at FROM event_log WHERE key = ?')
		.bind(key)
		.all<{ key: string; action: string; received_at: number }>();
	return results;
}
