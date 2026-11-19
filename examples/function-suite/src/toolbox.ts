import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from './env.ts';

/** A named entrypoint, bound back into this Worker as `env.TOOLBOX` (same-host JS RPC). */
export class Toolbox extends WorkerEntrypoint<Env> {
	add(a: number, b: number): number {
		return a + b;
	}

	async sha256(text: string): Promise<string> {
		return sha256Hex(text);
	}

	greeting(): string {
		return this.env.SUITE_GREETING;
	}
}

export async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
