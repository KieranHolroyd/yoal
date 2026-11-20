/**
 * Host side of the lab's stdio HTTP relay (tests/lab/node/relay.ts): one `docker exec -i` into a
 * lab node, many concurrent requests over it. Used where a scenario must reach addresses only the
 * lab can route (app copies on the overlay) without publishing a port.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { containerName } from '../lab.config.ts';
import { assertLabName } from './docker.ts';

const BUN = '/opt/yoal/runtime/bin/bun';

export interface RelayResponse {
	status: number;
	headers: [string, string][];
	body: Uint8Array;
}

export class RelayError extends Error {
	constructor(
		message: string,
		readonly timeout: boolean,
	) {
		super(message);
		this.name = 'RelayError';
	}
}

export class LabRelay {
	private readonly child: ReturnType<typeof Bun.spawn>;
	private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
	private nextId = 1;
	private closed = false;

	constructor(readonly node: string) {
		// The source goes in argv, so a lab brought up from an older checkout still has it.
		const source = readFileSync(join(import.meta.dir, '..', 'node', 'relay.ts'), 'utf8');
		this.child = Bun.spawn(['docker', 'exec', '-i', assertLabName(containerName(node)), BUN, '-e', source], { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' });
		void this.read();
	}

	private async read(): Promise<void> {
		const decoder = new TextDecoder();
		let buffer = '';
		for await (const chunk of this.child.stdout as ReadableStream<Uint8Array>) {
			buffer += decoder.decode(chunk, { stream: true });
			let newline: number;
			while ((newline = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (!line.trim()) continue;
				const message = JSON.parse(line) as { id: number; error?: string; timeout?: boolean };
				const waiter = this.pending.get(message.id);
				this.pending.delete(message.id);
				if (!waiter) continue;
				if (message.error !== undefined) waiter.reject(new RelayError(message.error, Boolean(message.timeout)));
				else waiter.resolve(message);
			}
		}
		this.closed = true;
		for (const waiter of this.pending.values()) waiter.reject(new RelayError(`relay on ${this.node} exited`, false));
		this.pending.clear();
	}

	private send<T>(message: Record<string, unknown>): Promise<T> {
		if (this.closed) return Promise.reject(new RelayError(`relay on ${this.node} exited`, false));
		const id = this.nextId++;
		const promise = new Promise<T>((resolve, reject) => this.pending.set(id, { resolve, reject }));
		const stdin = this.child.stdin as import('bun').FileSink;
		stdin.write(`${JSON.stringify({ id, ...message })}\n`);
		stdin.flush();
		return promise;
	}

	async fetch(url: string, init: { method: string; headers: [string, string][]; body?: ArrayBuffer; timeoutMs: number }): Promise<RelayResponse> {
		const answer = await this.send<{ status: number; headers: [string, string][]; body: string }>({
			url,
			method: init.method,
			headers: init.headers,
			body: init.body && init.body.byteLength ? Buffer.from(init.body).toString('base64') : null,
			timeoutMs: init.timeoutMs,
		});
		return { status: answer.status, headers: answer.headers, body: Buffer.from(answer.body, 'base64') };
	}

	/** The edge's upstream dial addresses for an app host, from the node's Caddy config. */
	async dials(host: string): Promise<string[]> {
		return (await this.send<{ dials: string[] }>({ op: 'dials', host })).dials;
	}

	async close(): Promise<void> {
		if (this.closed) return;
		(this.child.stdin as import('bun').FileSink).end();
		await Promise.race([this.child.exited, Bun.sleep(5000)]);
		if (this.child.exitCode === null) this.child.kill();
	}
}
