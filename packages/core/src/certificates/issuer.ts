import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CertificateRelay } from '@yoal/contracts';

/**
 * The control-plane issuer (HA-PLAN H20 on the S4 outcome, O1). Caddy no longer issues for an
 * ingress in the shared-certificate mode: one issuer runs beside the control plane, under the ACME
 * lease per host, and the holder's pair is sealed and distributed (CLUSTERING §7.3).
 *
 * The issuer is an interface so the protocol implementation stays replaceable and testable. This
 * build ships the `lego` adapter (S4's measured client: one order per name set, 12–25 s against a
 * real Cloudflare zone) and no in-process ACME client.
 */
export interface IssuedCertificatePair {
	certPem: string;
	keyPem: string;
	/** Any chain the issuer returned; `certPem` is the leaf plus intermediates today. */
	chainPem?: string;
}

export interface IssueContext {
	/** The lease holder's HTTP-01 relay, when the order uses HTTP-01 rather than DNS-01. */
	relay?: CertificateRelay;
	signal?: AbortSignal;
}

export interface CertificateIssuer {
	/** Issue (or renew) one certificate for `host`. Throws on failure so the sweep retries. */
	issue(host: string, context?: IssueContext): Promise<IssuedCertificatePair>;
}

export interface LegoIssuerOptions {
	/** The `lego` binary. The release image installs it beside the control plane (S4 design B). */
	bin: string;
	email: string;
	/** ACME directory; defaults to Let's Encrypt production inside lego. */
	directory?: string;
	/** `cloudflare` today; the provider plugins H20 adds pass the same flag. */
	dnsProvider?: string;
	/** Extra `--dns.propagation-*` flags or a provider credential env, passed through unchanged. */
	env?: Record<string, string>;
	/** Injected for tests. */
	exec?: (cmd: string[], env: Record<string, string | undefined>) => Promise<{ code: number; stdout: string; stderr: string }>;
}

/** `lego run` in a throwaway directory; the pair is read, then every byte on disk is removed. */
export class LegoAcmeIssuer implements CertificateIssuer {
	private readonly run: NonNullable<LegoIssuerOptions['exec']>;

	constructor(private readonly options: LegoIssuerOptions) {
		this.run =
			options.exec ??
			(async (cmd, env) => {
				// Only what the binary needs: never inherit YOAL_MASTER_KEY or node tokens.
				const child = Bun.spawn(cmd, {
					env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', ...env },
					stdout: 'pipe',
					stderr: 'pipe',
				});
				const [stdout, stderr] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
				]);
				return { code: await child.exited, stdout, stderr };
			});
	}

	async issue(host: string): Promise<IssuedCertificatePair> {
		if (!this.options.bin.trim()) throw new Error('No lego binary is configured (YOAL_LEGO_BIN).');
		if (!this.options.email.trim()) throw new Error('ACME needs an account email (YOAL_ACME_EMAIL).');
		const dir = await mkdtemp(join(tmpdir(), 'yoal-acme-'));
		try {
			const args = [
				'--accept-tos',
				'--email',
				this.options.email,
				'--domains',
				host,
				'--path',
				dir,
			];
			if (this.options.directory) args.push('--server', this.options.directory);
			if (this.options.dnsProvider) args.push('--dns', this.options.dnsProvider);
			args.push('run');
			const result = await this.run([this.options.bin, ...args], this.options.env ?? {});
			if (result.code !== 0)
				throw new Error(`lego exited ${result.code} for ${host}: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
			const base = join(dir, 'certificates', `${host.replace(/^\*\./, '_.')}.crt`);
			const certPem = await readFile(base, 'utf8');
			const keyPem = await readFile(base.replace(/\.crt$/, '.key'), 'utf8');
			return { certPem, keyPem, chainPem: certPem };
		} finally {
			await rm(dir, { recursive: true, force: true }).catch(() => undefined);
		}
	}
}

/**
 * The issuer this control plane should use, from the environment. Null means none is configured,
 * which is the flag-off shape and also an explicit refusal rather than a silent public-CA attempt.
 */
export function acmeIssuerFromEnv(
	env: Record<string, string | undefined> = process.env,
): CertificateIssuer | null {
	const bin = env.YOAL_LEGO_BIN?.trim();
	const email = env.YOAL_ACME_EMAIL?.trim() ?? env.YOAL_ACME_ACCOUNT_EMAIL?.trim();
	if (!bin || !email) return null;
	const dnsProvider = env.YOAL_ACME_DNS_PROVIDER?.trim() || 'cloudflare';
	const credentialEnv: Record<string, string> = {};
	// lego reads provider credentials from the environment; pass only the ones it documents.
	if (dnsProvider === 'cloudflare') {
		const token = env.CF_API_TOKEN?.trim() ?? env.CLOUDFLARE_DNS_API_TOKEN?.trim();
		if (token) credentialEnv.CF_API_TOKEN = token;
	}
	return new LegoAcmeIssuer({
		bin,
		email,
		...(env.YOAL_ACME_CA?.trim() ? { directory: env.YOAL_ACME_CA.trim() } : {}),
		dnsProvider,
		env: credentialEnv,
	});
}
