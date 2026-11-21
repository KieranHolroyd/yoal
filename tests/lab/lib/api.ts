/**
 * The lab's view of its own fleet: the platform API through lab-a's published port (with the
 * platform's Host header, because the host cannot route to container addresses on every Docker),
 * the helper's fault verbs through `docker exec`, and the observation log the checker reads.
 */
import { appendFileSync } from 'node:fs';
import { CONTROL, LAB, containerName, labNode } from '../lab.config.ts';
import { exec } from './docker.ts';

export const PLATFORM_HOST = CONTROL.ip;
export const PUBLIC_BASE = `http://127.0.0.1:${CONTROL.hostHttpPort}`;

let cachedToken: string | null = null;

/** The lab API key minted by `lab up` (kept on lab-a in /etc/yoal-lab/token, 0600). */
export function labToken(): string {
	if (cachedToken) return cachedToken;
	cachedToken = exec(containerName(CONTROL.name), ['cat', '/etc/yoal-lab/token']).stdout.trim();
	if (!cachedToken.startsWith('yoal_')) throw new Error('no lab API key on lab-a: run `lab up` first');
	return cachedToken;
}

export async function api<T = any>(method: string, path: string, body?: unknown, options: { allowStatus?: number[] } = {}): Promise<{ status: number; body: T }> {
	const response = await fetch(`${PUBLIC_BASE}${path}`, {
		method,
		headers: {
			host: PLATFORM_HOST,
			// The platform refuses a state-changing request without a same-origin Origin (CSRF guard).
			origin: `http://${PLATFORM_HOST}`,
			authorization: `Bearer ${labToken()}`,
			...(body === undefined ? {} : { 'content-type': 'application/json' }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(20_000),
	});
	const text = await response.text();
	let parsed: unknown = text;
	try {
		parsed = JSON.parse(text);
	} catch {
		// keep text
	}
	if (!response.ok && !(options.allowStatus ?? []).includes(response.status))
		throw new Error(`${method} ${path} → ${response.status}: ${text.slice(0, 400)}`);
	return { status: response.status, body: parsed as T };
}

/**
 * The platform's resolved feature flags (`GET /api/setup/status` → `features`: booleans only, no
 * auth). What the running control plane actually uses, not what a file says. Null when it does not
 * answer.
 */
export async function platformFeatures(): Promise<Record<string, boolean> | null> {
	try {
		const response = await fetch(`${PUBLIC_BASE}/api/setup/status`, { headers: { host: PLATFORM_HOST }, signal: AbortSignal.timeout(10_000) });
		if (!response.ok) return null;
		const body = (await response.json()) as { features?: Record<string, boolean> };
		return body.features && typeof body.features === 'object' ? body.features : null;
	} catch {
		return null;
	}
}

export interface FleetNode {
	id: string;
	name: string;
	status: string;
	zone?: string;
	mode?: string;
	privateAddress?: string | null;
	lastHeartbeatAt?: string | null;
	draining?: boolean;
}

/**
 * The node list. `GET /api/v1/nodes` is a platform-admin route that refuses API keys, so this asks
 * lab-a's bootstrap (which signs the lab owner in) for it.
 */
export function fleetNodes(): FleetNode[] {
	const out = exec(containerName(CONTROL.name), ['/opt/yoal/runtime/bin/bun', `${LAB.sourceDir}/tests/lab/node/bootstrap.ts`, '--nodes-only']).stdout;
	return (JSON.parse(out) as { nodes: FleetNode[] }).nodes;
}

/** Owner-session actions (drain/resume, cluster config) also go through the bootstrap on lab-a. */
export function ownerAction(args: string[]): string {
	return exec(containerName(CONTROL.name), ['/opt/yoal/runtime/bin/bun', `${LAB.sourceDir}/tests/lab/node/bootstrap.ts`, '--nodes-only', ...args]).stdout;
}

// --- fault verbs through the node's helper -----------------------------------------------------

export function helperCall(node: string, method: 'GET' | 'POST', path: string, body?: unknown): { status: number; body: any } {
	const argv = ['curl', '-sS', '-w', '\n%{http_code}', '--unix-socket', LAB.helperSocket, '-X', method];
	if (body !== undefined) argv.push('-H', 'content-type: application/json', '--data-binary', '@-');
	argv.push(`http://helper${path}`);
	const result = exec(containerName(labNode(node).name), argv, body === undefined ? {} : { stdin: JSON.stringify(body) });
	const lines = result.stdout.trimEnd().split('\n');
	const status = Number(lines.pop());
	const text = lines.join('\n');
	try {
		return { status, body: JSON.parse(text) };
	} catch {
		return { status, body: text };
	}
}

// --- observations (the lab ↔ checker contract) ---------------------------------------------------

export type ObservationKind = 'lease' | 'epoch' | 'db-role' | 'fence' | 'write-attempt' | 'singleton' | 'release-command' | 'ingress' | 'route' | 'fault';

export class Observer {
	constructor(private readonly path: string | null) {}

	note(kind: ObservationKind, node: string, fields: Record<string, unknown> = {}): void {
		if (!this.path) return;
		appendFileSync(this.path, `${JSON.stringify({ t: Date.now(), kind, node, ...fields })}\n`);
	}
}
