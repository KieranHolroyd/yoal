import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env.ts';

/**
 * A SQLite-backed Durable Object: a counter (SQL), a KV-API round trip and alarms.
 * Every method is called over JS RPC from the Worker (`stub.increment()`).
 */
export class Counter extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			ctx.storage.sql.exec(
				'CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL)',
			);
			ctx.storage.sql.exec(
				'CREATE TABLE IF NOT EXISTS alarms (token TEXT PRIMARY KEY, scheduled_at INTEGER NOT NULL, fired_at INTEGER)',
			);
		});
	}

	async increment(by = 1): Promise<number> {
		const row = this.ctx.storage.sql
			.exec<{ value: number }>(
				'INSERT INTO counter (id, value) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value = value + excluded.value RETURNING value',
				by,
			)
			.one();
		return row.value;
	}

	async value(): Promise<number> {
		const rows = this.ctx.storage.sql.exec<{ value: number }>('SELECT value FROM counter WHERE id = 1').toArray();
		return rows[0]?.value ?? 0;
	}

	/** The KV-style storage API, which on a SQLite-backed object lives in the same database. */
	async kvRoundTrip(token: string): Promise<{ got: { token: string; at: number } | null; listed: number; afterDelete: boolean }> {
		await this.ctx.storage.put(`kv:${token}`, { token, at: Date.now() });
		const got = (await this.ctx.storage.get<{ token: string; at: number }>(`kv:${token}`)) ?? null;
		const listed = (await this.ctx.storage.list({ prefix: `kv:${token}` })).size;
		await this.ctx.storage.delete(`kv:${token}`);
		const afterDelete = (await this.ctx.storage.get(`kv:${token}`)) !== undefined;
		return { got, listed, afterDelete };
	}

	async scheduleAlarm(token: string, delayMs: number): Promise<void> {
		const at = Date.now() + delayMs;
		this.ctx.storage.sql.exec('INSERT OR REPLACE INTO alarms (token, scheduled_at) VALUES (?, ?)', token, at);
		const current = await this.ctx.storage.getAlarm();
		if (current === null || current > at) await this.ctx.storage.setAlarm(at);
	}

	async alarmFiredAt(token: string): Promise<number | null> {
		const rows = this.ctx.storage.sql
			.exec<{ fired_at: number | null }>('SELECT fired_at FROM alarms WHERE token = ?', token)
			.toArray();
		return rows[0]?.fired_at ?? null;
	}

	override async alarm(): Promise<void> {
		const now = Date.now();
		this.ctx.storage.sql.exec('UPDATE alarms SET fired_at = ? WHERE fired_at IS NULL AND scheduled_at <= ?', now, now + 50);
		const next = this.ctx.storage.sql
			.exec<{ at: number | null }>('SELECT MIN(scheduled_at) AS at FROM alarms WHERE fired_at IS NULL')
			.one().at;
		if (next !== null) await this.ctx.storage.setAlarm(Math.max(next, now + 10));
		console.log(JSON.stringify({ evt: 'alarm', object: this.ctx.id.toString(), at: now }));
	}
}

interface Attachment {
	name: string;
	joinedAt: number;
}

/**
 * A chat room on the WebSocket Hibernation API: the object can be evicted between messages while
 * its sockets stay open, and the attachment survives that.
 */
export class ChatRoom extends DurableObject<Env> {
	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
			return Response.json({
				connections: this.ctx.getWebSockets().length,
				names: this.ctx.getWebSockets().map((ws) => (ws.deserializeAttachment() as Attachment | null)?.name ?? null),
			});
		}
		const name = new URL(request.url).searchParams.get('name')?.slice(0, 40) || 'anon';
		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment({ name, joinedAt: Date.now() } satisfies Attachment);
		server.send(JSON.stringify({ type: 'welcome', name, peers: this.ctx.getWebSockets().length }));
		return new Response(null, { status: 101, webSocket: client });
	}

	override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
		if (text === 'ping') {
			ws.send(JSON.stringify({ type: 'pong', at: Date.now() }));
			return;
		}
		const from = (ws.deserializeAttachment() as Attachment | null)?.name ?? 'anon';
		const payload = JSON.stringify({ type: 'message', from, text: text.slice(0, 2000), at: Date.now() });
		for (const peer of this.ctx.getWebSockets()) {
			try {
				peer.send(payload);
			} catch {
				// A peer that closed mid-broadcast is not this sender's problem.
			}
		}
	}

	override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
		try {
			ws.close(code, reason);
		} catch {
			// Newer compatibility dates reply to the close frame automatically.
		}
	}
}
