import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ingressActivationSchema, type IngressActivation } from '@yoal/contracts';

/**
 * The Caddy listeners for a node, merging the env-configured address with the ingress payload.
 * A node with the role may have joined as a worker, bound to its overlay address: replacing that
 * with `:443` would break every other ingress proxying to its app copies, so both are kept. The
 * `:80` entry is dropped when TLS is on because site-config renders a dedicated redirect server
 * on it. With no desired listeners and TLS on this is today's `[':443']`, so flag-off behaviour
 * and every existing ingress are unchanged.
 */
export function ingressListeners(base: readonly string[], desired: readonly string[] | undefined, tls: boolean): string[] {
	if (!desired?.length) return tls ? [':443'] : [...base];
	const listeners = new Set<string>();
	if (tls) listeners.add(':443');
	for (const address of [...base, ...desired]) if (address !== ':80') listeners.add(address);
	return [...listeners];
}

/**
 * The shared secrets an ingress fetches from the node-authenticated activation endpoint (HA-PLAN
 * H20, G8). They are cached 0600 under the agent data directory so a restart keeps signing and
 * verifying cookies before the control plane answers, and so a control-plane outage does not
 * silently turn a site's access off. Never logged, never written into desired state.
 */
export class IngressSecretsStore {
	readonly path: string;

	constructor(dataDir: string) {
		this.path = join(dataDir, 'ingress-secrets.json');
	}

	load(): IngressActivation | null {
		let text: string;
		try {
			text = readFileSync(this.path, 'utf8');
		} catch {
			return null;
		}
		try {
			const parsed = ingressActivationSchema.safeParse(JSON.parse(text));
			return parsed.success ? parsed.data : null;
		} catch {
			return null;
		}
	}

	save(secrets: IngressActivation): void {
		const validated = ingressActivationSchema.parse(secrets);
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o755 });
		const tmp = `${this.path}.tmp-${process.pid}`;
		try {
			writeFileSync(tmp, `${JSON.stringify(validated)}\n`, { mode: 0o600 });
			renameSync(tmp, this.path);
			chmodSync(this.path, 0o600);
		} catch (error) {
			rmSync(tmp, { force: true });
			throw error;
		}
	}
}
