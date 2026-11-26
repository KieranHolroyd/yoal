import { createHmac, randomBytes } from 'node:crypto';

/**
 * Log redaction at ingest (docs/LOGS.md §10.4, LP10). `LogService.append*` runs every body through
 * a redactor before SQLite, drains and the indexer see it. Each match becomes `[REDACTED:<kind>]`.
 *
 * Three layers, in this order:
 *
 * 1. **Known secret values** (spike S5). The project's secret env values, matched exactly, along
 *    with their base64 (padded and unpadded) and URL-encoded forms and each line of a multi-line
 *    value (the pipeline masker's set, D152). The redactor never holds the values: it holds
 *    *fingerprints* (`createSecretFingerprints`), made when the secret is written:
 *    - a keyed 32-bit rolling hash of the first 8 characters, the prefilter, and
 *    - the length and a keyed HMAC-SHA256 of the whole value, the confirmation.
 *    A line is scanned once with a rolling hash (Rabin–Karp). Only a window whose hash is in the
 *    prefilter (a bitset, then a map) is confirmed with one HMAC per candidate length. So the hot
 *    path costs one pass over the line, whatever the number of secrets, and nothing is decrypted.
 * 2. **Built-in detectors**: private key blocks, JWTs, cloud and forge tokens (AWS, GCP, GitHub,
 *    GitLab, Slack, Stripe), Yoal's own credentials (API and CLI keys `yoal_…`, service-policy
 *    secrets `yoal_svc_…`, prober tokens `yoalp_…`, SCIM tokens `scim_…`, node tokens by context,
 *    storage access key ids `SKF…`/`SKR…`), URL userinfo passwords, `Authorization`/`Cookie`/
 *    `Set-Cookie` and Yoal token header values, `Bearer` credentials, values of credential-named
 *    keys (`password=`, `secret:`, `api_key=`, `token=`…), and long high-entropy strings in
 *    `key=` positions. Each detector has a cheap gate so a plain line skips it.
 * 3. **Org regex rules**, compiled once; length caps stand in for a regex timeout.
 *
 * Detectors are tuned against false positives: UUIDs, git SHAs, content hashes (`sha256:…`, SRI
 * `sha512-…`), request and trace ids and Yoal metric names such as `yoal_storage_used_bytes` pass
 * through. No detector is complete; this is defence in depth, never a guarantee (§15).
 *
 * The module is pure apart from hashing. Bench S5 lives in `spikes/logs-bench/`.
 */

/** Built-in detector kinds, as they appear in `[REDACTED:<kind>]`. */
export const BUILTIN_REDACTION_KINDS = [
	'known_secret',
	'private_key',
	'jwt',
	'aws_access_key',
	'aws_secret_key',
	'gcp_api_key',
	'gcp_service_account',
	'github_token',
	'gitlab_token',
	'slack_token',
	'stripe_key',
	'yoal_api_key',
	'yoal_node_token',
	'yoal_token',
	'yoal_storage_key',
	'url_password',
	'authorization',
	'cookie',
	'bearer',
	'credential',
	'high_entropy',
] as const;
export type BuiltinRedactionKind = (typeof BUILTIN_REDACTION_KINDS)[number];
/** A built-in kind, or `rule:<name>` for an org rule. */
export type RedactionKind = BuiltinRedactionKind | `rule:${string}`;

export interface RedactionRule {
	/** Lowercase name, shown as `[REDACTED:rule:<name>]`. */
	name: string;
	/** JavaScript regular expression source. */
	pattern: string;
	/** Any of `i`, `m`, `s`, `u`; `g` is always added. */
	flags?: string;
}

export interface SecretFingerprint {
	/** Keyed rolling hash of the first `SECRET_WINDOW` UTF-16 code units. */
	prefix: number;
	/** Length in UTF-16 code units. */
	length: number;
	/** Keyed HMAC-SHA256 of the whole value, hex, first 32 characters. */
	digest: string;
}

export interface SecretFingerprintSet {
	version: 1;
	entries: SecretFingerprint[];
}

export interface RedactorOptions {
	/**
	 * Plaintext secret values. They are fingerprinted at construction with a random key and not
	 * kept. Use `fingerprints` + `fingerprintKey` to avoid plaintext in the process altogether.
	 */
	secrets?: Iterable<string>;
	/** Precomputed fingerprints (`createSecretFingerprints`), with the key they were made with. */
	fingerprints?: SecretFingerprintSet;
	fingerprintKey?: string | Uint8Array;
	/** Org regex rules. Invalid rules throw `RedactionRuleError` (validate first in the UI). */
	rules?: readonly RedactionRule[];
	/** Built-in kinds to turn off (their matches are left as they are). */
	disable?: readonly BuiltinRedactionKind[];
}

export interface RedactionResult {
	text: string;
	/** Kinds that matched, each once, in first-match order. Empty when nothing was redacted. */
	hits: RedactionKind[];
}

export interface Redactor {
	redact(text: string): RedactionResult;
	/** Number of secret fingerprints loaded (values times their encodings). */
	readonly secretCount: number;
}

/** Secrets shorter than this are not matched (LOGS.md §12 S5: "every secret value ≥ 8 chars"). */
export const MIN_SECRET_LENGTH = 8;
/** Rolling-hash window: every fingerprinted value is at least this long. */
const SECRET_WINDOW = MIN_SECRET_LENGTH;
export const MAX_REDACTION_RULES = 50;
export const MAX_REDACTION_RULE_PATTERN = 512;
/** Org rules only see this much of a line (bodies are capped at 16 KB anyway). */
export const MAX_REDACTION_RULE_INPUT = 16 * 1024;

export class RedactionRuleError extends Error {
	constructor(
		readonly rule: string,
		message: string,
	) {
		super(message);
		this.name = 'RedactionRuleError';
	}
}

const marker = (kind: RedactionKind) => `[REDACTED:${kind}]`;
const ALREADY = '[REDACTED:';

// ----------------------------------------------------------------------- known secret values

interface SecretKeyMaterial {
	hmacKey: Buffer;
	/** Odd 32-bit multiplier of the rolling hash, derived from the key. */
	base: number;
	/** base^(window-1) mod 2^32. */
	topPower: number;
}

function keyMaterial(key: string | Uint8Array): SecretKeyMaterial {
	const hmacKey = Buffer.from(createHmac('sha256', typeof key === 'string' ? Buffer.from(key, 'utf8') : key).update('yoal-log-redaction-v1').digest());
	const base = (hmacKey.readUInt32LE(0) | 1) >>> 0;
	let topPower = 1;
	for (let i = 0; i < SECRET_WINDOW - 1; i++) topPower = Math.imul(topPower, base);
	return { hmacKey, base, topPower };
}

function rollingHash(text: string, start: number, base: number): number {
	let h = 0;
	for (let i = start; i < start + SECRET_WINDOW; i++) h = (Math.imul(h, base) + text.charCodeAt(i)) | 0;
	return h;
}

function digestOf(material: SecretKeyMaterial, value: string): string {
	return createHmac('sha256', material.hmacKey).update(value, 'utf8').digest('hex').slice(0, 32);
}

/** The forms of one secret that are matched: raw, each line, base64 (± padding), URL-encoded. */
export function secretVariants(value: string): string[] {
	const out = new Set<string>();
	const candidates = new Set<string>([value]);
	if (value.includes('\n')) for (const line of value.split(/\r?\n/)) candidates.add(line);
	for (const candidate of candidates) {
		// A short value's encodings can reach 8 characters; the value itself must.
		if (candidate.length < MIN_SECRET_LENGTH || !candidate.trim() || candidate.includes('\n')) continue;
		out.add(candidate);
		const base64 = Buffer.from(candidate, 'utf8').toString('base64');
		out.add(base64);
		out.add(base64.replace(/=+$/, ''));
		out.add(encodeURIComponent(candidate));
	}
	return [...out].filter((v) => v.length >= MIN_SECRET_LENGTH);
}

/**
 * Fingerprint secret values for `createRedactor({ fingerprints, fingerprintKey })`. Run this where
 * the plaintext is already in hand (when a secret is written or rotated) and store the result; the
 * ingest path then needs only the fingerprints and the key. Values shorter than 8 are skipped.
 */
export function createSecretFingerprints(values: Iterable<string>, key: string | Uint8Array): SecretFingerprintSet {
	const material = keyMaterial(key);
	const seen = new Set<string>();
	const entries: SecretFingerprint[] = [];
	for (const value of values) {
		if (typeof value !== 'string') continue;
		for (const variant of secretVariants(value)) {
			const digest = digestOf(material, variant);
			if (seen.has(digest)) continue;
			seen.add(digest);
			entries.push({ prefix: rollingHash(variant, 0, material.base), length: variant.length, digest });
		}
	}
	return { version: 1, entries };
}

const FILTER_BITS = 18;
const FILTER_SHIFT = 32 - FILTER_BITS;

class SecretMatcher {
	/** Bitset over the top 18 bits of the prefix hash: most windows stop here. */
	private readonly filter = new Uint32Array(1 << (FILTER_BITS - 5));
	/** prefix hash → candidates, longest first. */
	private readonly byPrefix = new Map<number, { length: number; digest: string }[]>();
	readonly size: number;

	constructor(
		private readonly material: SecretKeyMaterial,
		set: SecretFingerprintSet,
	) {
		let size = 0;
		for (const entry of set.entries) {
			if (!entry || !Number.isInteger(entry.length) || entry.length < SECRET_WINDOW || typeof entry.digest !== 'string') continue;
			const prefix = entry.prefix | 0;
			const bit = prefix >>> FILTER_SHIFT;
			this.filter[bit >>> 5]! |= 1 << (bit & 31);
			let list = this.byPrefix.get(prefix);
			if (!list) this.byPrefix.set(prefix, (list = []));
			if (list.some((c) => c.digest === entry.digest)) continue;
			list.push({ length: entry.length, digest: entry.digest });
			list.sort((a, b) => b.length - a.length);
			size++;
		}
		this.size = size;
	}

	/** Replace every fingerprinted value in `text`. Returns null when nothing matched. */
	redact(text: string): string | null {
		const n = text.length;
		if (this.size === 0 || n < SECRET_WINDOW) return null;
		const { base, topPower } = this.material;
		const filter = this.filter;
		let out: string | null = null;
		let last = 0;
		let h = rollingHash(text, 0, base);
		let i = 0;
		while (true) {
			const bit = h >>> FILTER_SHIFT;
			let advanced = false;
			if ((filter[bit >>> 5]! & (1 << (bit & 31))) !== 0) {
				const candidates = this.byPrefix.get(h);
				if (candidates) {
					for (const candidate of candidates) {
						if (i + candidate.length > n) continue;
						if (digestOf(this.material, text.slice(i, i + candidate.length)) !== candidate.digest) continue;
						out = (out ?? '') + text.slice(last, i) + marker('known_secret');
						i += candidate.length;
						last = i;
						advanced = true;
						break;
					}
				}
			}
			if (advanced) {
				if (i + SECRET_WINDOW > n) break;
				h = rollingHash(text, i, base);
				continue;
			}
			if (i + SECRET_WINDOW >= n) break;
			// slide: drop text[i], add text[i + window]
			h = (Math.imul(h - Math.imul(text.charCodeAt(i), topPower), base) + text.charCodeAt(i + SECRET_WINDOW)) | 0;
			i++;
		}
		return out === null ? null : out + text.slice(last);
	}
}

// -------------------------------------------------------------------------- built-in detectors

interface Detector {
	/** Every kind the detector can emit; it is skipped when all of them are disabled. */
	kinds: readonly BuiltinRedactionKind[];
	/** Cheap test; the detector only runs when it passes. */
	gate: (text: string) => boolean;
	/** `hit` records a kind and returns false when that kind is switched off (leave the match). */
	run: (text: string, hit: (kind: RedactionKind) => boolean) => string;
}

const PRIVATE_KEY = /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END \1PRIVATE KEY(?: BLOCK)?-----|$)/g;

// Prefixed tokens, one pass. Group order maps to kinds below.
const TOKEN_KINDS: BuiltinRedactionKind[] = [
	'jwt',
	'aws_access_key',
	'gcp_api_key',
	'github_token',
	'gitlab_token',
	'slack_token',
	'stripe_key',
	'yoal_api_key',
	'yoal_token',
	'yoal_storage_key',
];
const TOKEN_PATTERN = new RegExp(
	[
		// JWT: header and payload are base64url JSON objects (`eyJ`).
		String.raw`(?<![\w-])(eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*)`,
		String.raw`(?<![A-Za-z0-9])((?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ABIA|ACCA)[A-Z0-9]{16})(?![A-Za-z0-9])`,
		String.raw`(?<![\w-])(AIza[0-9A-Za-z_-]{35})(?![\w-])`,
		String.raw`(?<![\w])((?:gh[pousr]_[A-Za-z0-9]{36,255})|github_pat_[A-Za-z0-9_]{22,255})(?![\w])`,
		String.raw`(?<![\w-])(gl(?:pat|ptt|dt|rt|cbt|imt|soat|ft|oas|agent)-[A-Za-z0-9_-]{20,})(?![\w-])`,
		String.raw`(?<![\w-])(xox[abposr]-[A-Za-z0-9-]{10,}|xapp-\d-[A-Za-z0-9-]{10,})(?![\w-])`,
		String.raw`(?<![\w])((?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{24,})(?![\w])`,
		// Yoal API keys (`yoal_` + base64url, or Better Auth's 64 letters; CLI logins mint these)
		// and access-policy service secrets (`yoal_svc_…`). Mixed case is checked in code, so
		// metric and role names (`yoal_storage_used_bytes`, `yoal_studio_ro`) never match.
		String.raw`(?<![\w-])(yoal_(?:svc_)?[A-Za-z0-9_-]{32,})(?![\w-])`,
		// External prober tokens (`yoalp_…`) and SCIM tokens (`scim_…`).
		String.raw`(?<![\w-])((?:yoalp|scim)_[A-Za-z0-9_-]{32,})(?![\w-])`,
		// Object storage access key ids: `SKF`/`SKR` + 17 base32.
		String.raw`(?<![A-Za-z0-9])(SK[FR][A-Z2-7]{17})(?![A-Za-z0-9])`,
	]
		.map((s) => `(?:${s})`)
		.join('|'),
	'g',
);
const TOKEN_GATE = /eyJ|A(?:KIA|SIA|GPA|IDA|ROA|IPA|NPA|NVA|BIA|CCA)|AIza|gh[pousr]_|github_pat_|gl[a-z]{1,5}-|xox|xapp-|[sr]k_(?:live|test)_|whsec_|yoal|scim_|SK[FR]/;

/** Random base64url has both cases; names and metric ids do not. */
function looksRandom(value: string): boolean {
	return /[A-Z]/.test(value) && /[a-z]/.test(value);
}

const URL_PASSWORD = /(?<![\w+.-])([a-z][a-z0-9+.-]{1,15}:\/\/)([^\s:\/@"'<>]+):([^\s@\/"'<>]+)@/gi;

const AUTH_HEADER =
	/(?<![\w-])((?:proxy-)?authorization)(["']?\s*[:=]\s*["']?)(?:(bearer|basic|digest|token|apikey|api-key|negotiate|aws4-hmac-sha256|hmac-sha256|ntlm|dpop)(\s+)([^\s"']+(?:,\s*[\w-]+=[^\s"',]+)*)|([^\s"',;]{16,}))/gi;
const COOKIE_HEADER = /(?<![\w-])((?:set-)?cookie)(["']?\s*[:=]\s*["']?)([^\s"';=,]+=[^"'\r\n]*)/gi;
const TOKEN_HEADER = /(?<![\w-])(x-yoal-token|x-yoal-access-token|x-api-key|x-auth-token|x-access-token|api-key)(["']?\s*[:=]\s*["']?)([^\s"',;]+)/gi;
const HEADER_GATE = /authori|cookie|-token|api-key/i;

const BEARER = /(?<![\w-])(bearer)(\s+)([A-Za-z0-9._~+\/-]{16,}=*)/gi;

// Credential-named keys. The key must END with the sensitive word (`db_password`, `apiKey`,
// `AWS_SECRET_ACCESS_KEY`), so `max_tokens`, `token_count`, `secretName` and `PWD` never match.
const CREDENTIAL_KEY = String.raw`[A-Za-z0-9_.-]*?(?:password|passwd|passphrase|secret|token|api[_.-]?key|apikey|access[_.-]?key|secret[_.-]?key|private[_.-]?key|signing[_.-]?key|encryption[_.-]?key|master[_.-]?key|credentials?|auth|signature)`;
const CREDENTIAL = new RegExp(
	String.raw`(?<![A-Za-z0-9])(${CREDENTIAL_KEY})(["']?\s*[:=]\s*)(?:"((?:[^"\\\n]|\\.)*)"|'([^'\n]*)'|([^\s"',;&}\])]+))`,
	'gi',
);
const CREDENTIAL_GATE = /pass|secret|token|key|cred|auth|signature/i;
const PASSWORD_KEY = /pass(?:word|wd|phrase)$/i;
const PLACEHOLDER_VALUE = /^(?:\*+|x{3,}|null|nil|none|undefined|true|false|redacted|hidden|masked|<[^>]*>|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|%[A-Za-z_][A-Za-z0-9_]*%|\{\{[^}]*\}\})$/i;

// High-entropy values in key positions. Keys that name ids, hashes, refs and locations are exempt.
const HIGH_ENTROPY = /(?<![A-Za-z0-9_.-])([A-Za-z][A-Za-z0-9_.-]{0,63})(["']?\s*[:=]\s*["']?)([A-Za-z0-9+\/_-]{24,}={0,2})(?![A-Za-z0-9+\/=_-])/g;
const HIGH_ENTROPY_GATE = /[A-Za-z0-9+\/_-]{24,}/;
const EXEMPT_KEY =
	/(?:^|[_.-])(?:id|ids|uuid|ulid|hash|sha\d*|digest|etag|checksum|integrity|commit|rev|revision|ref|version|trace|span|parent|cursor|nonce|path|file|dir|url|uri|host|name|image|route|tag|key)$|(?:Id|ID|Ids|Hash|Sha|Digest|Ref|Version|Path|Name|Url|Uri|Key)$/;

function shannon(value: string): number {
	const counts = new Map<string, number>();
	for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
	let h = 0;
	for (const c of counts.values()) {
		const p = c / value.length;
		h -= p * Math.log2(p);
	}
	return h;
}

/** True for a random-looking secret, false for ids, hashes and words (§10.4 false positives). */
export function isHighEntropySecret(value: string): boolean {
	const v = value.replace(/=+$/, '');
	if (v.length < 24) return false;
	if (/^[0-9a-fA-F-]+$/.test(v)) return false; // hex, UUIDs, git SHAs, hex digests
	if (/^(?:sha(?:1|224|256|384|512)|md5)[-_]/i.test(v)) return false; // SRI / prefixed digests
	if (v.startsWith('/') || v.includes('//')) return false; // paths
	if (!/[A-Z]/.test(v) || !/[a-z]/.test(v) || !/\d/.test(v)) return false;
	const entropy = shannon(v);
	return entropy / Math.log2(Math.min(v.length, 64)) >= 0.85;
}

function credentialKind(key: string): BuiltinRedactionKind {
	if (/node[_.-]?token|join[_.-]?token/i.test(key)) return 'yoal_node_token';
	if (/^yoal_.*token$/i.test(key)) return 'yoal_token';
	if (/aws.*secret|secret[_.-]?access[_.-]?key/i.test(key)) return 'aws_secret_key';
	return 'credential';
}

const DETECTORS: Detector[] = [
	{
		kinds: ['private_key'],
		gate: (t) => t.includes('PRIVATE KEY'),
		run: (t, hit) => t.replace(PRIVATE_KEY, (match: string) => (hit('private_key') ? marker('private_key') : match)),
	},
	{
		kinds: ['gcp_service_account'],
		gate: (t) => t.includes('private_key_id'),
		run: (t, hit) =>
			t.replace(/("private_key_id"\s*:\s*")([0-9a-f]{40})(")/g, (match: string, a: string, _v: string, c: string) => {
				if (!hit('gcp_service_account')) return match;
				return `${a}${marker('gcp_service_account')}${c}`;
			}),
	},
	{
		kinds: TOKEN_KINDS, // every prefixed token kind, in one pass
		gate: (t) => TOKEN_GATE.test(t),
		run: (t, hit) =>
			t.replace(TOKEN_PATTERN, (match: string, ...groups: unknown[]) => {
				for (let g = 0; g < TOKEN_KINDS.length; g++) {
					if (groups[g] === undefined) continue;
					const kind = TOKEN_KINDS[g]!;
					if ((kind === 'yoal_api_key' || kind === 'yoal_token') && !looksRandom(match.replace(/^[a-z]+_(?:svc_)?/, ''))) return match;
					return hit(kind) ? marker(kind) : match;
				}
				return match;
			}),
	},
	{
		kinds: ['url_password'],
		gate: (t) => t.includes('://'),
		run: (t, hit) =>
			t.replace(URL_PASSWORD, (match: string, scheme: string, user: string, password: string) => {
				if (password.startsWith(ALREADY) || /^\*+$/.test(password)) return match;
				if (!hit('url_password')) return match;
				return `${scheme}${user}:${marker('url_password')}@`;
			}),
	},
	{
		kinds: ['authorization'],
		gate: (t) => HEADER_GATE.test(t),
		run: (t, hit) =>
			t.replace(AUTH_HEADER, (match: string, name: string, sep: string, scheme?: string, space?: string, credential?: string, bare?: string) => {
				const value = credential ?? bare ?? '';
				if (value.startsWith(ALREADY)) return match;
				if (!hit('authorization')) return match;
				return scheme ? `${name}${sep}${scheme}${space}${marker('authorization')}` : `${name}${sep}${marker('authorization')}`;
			}),
	},
	{
		kinds: ['cookie'],
		gate: (t) => HEADER_GATE.test(t),
		run: (t, hit) =>
			t.replace(COOKIE_HEADER, (match: string, name: string, sep: string, value: string) => {
				if (value.startsWith(ALREADY)) return match;
				if (!hit('cookie')) return match;
				return `${name}${sep}${marker('cookie')}`;
			}),
	},
	{
		kinds: ['yoal_token', 'credential'],
		gate: (t) => HEADER_GATE.test(t),
		run: (t, hit) =>
			t.replace(TOKEN_HEADER, (match: string, name: string, sep: string, value: string) => {
				if (value.startsWith(ALREADY) || value.length < 8) return match;
				const kind: BuiltinRedactionKind = /^x-yoal/i.test(name) ? 'yoal_token' : 'credential';
				if (!hit(kind)) return match;
				return `${name}${sep}${marker(kind)}`;
			}),
	},
	{
		kinds: ['bearer'],
		gate: (t) => /bearer/i.test(t),
		run: (t, hit) =>
			t.replace(BEARER, (match: string, word: string, space: string, value: string) => {
				if (value.startsWith(ALREADY)) return match;
				if (!hit('bearer')) return match;
				return `${word}${space}${marker('bearer')}`;
			}),
	},
	{
		kinds: ['credential', 'yoal_node_token', 'yoal_token', 'aws_secret_key'],
		gate: (t) => CREDENTIAL_GATE.test(t),
		run: (t, hit) =>
			t.replace(CREDENTIAL, (match: string, key: string, sep: string, dq?: string, sq?: string, bare?: string) => {
				const value = dq ?? sq ?? bare ?? '';
				if (!value || value.includes(ALREADY) || PLACEHOLDER_VALUE.test(value)) return match;
				// Passwords are secret at any length; other names need a token-sized value, so prose
				// such as `Unexpected token: '<'` or `auth: failed` is left alone.
				if (!PASSWORD_KEY.test(key) && value.length < 8) return match;
				const kind = credentialKind(key);
				if (!hit(kind)) return match;
				const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : '';
				return `${key}${sep}${quote}${marker(kind)}${quote}`;
			}),
	},
	{
		kinds: ['high_entropy'],
		gate: (t) => HIGH_ENTROPY_GATE.test(t),
		run: (t, hit) =>
			t.replace(HIGH_ENTROPY, (match: string, key: string, sep: string, value: string) => {
				if (EXEMPT_KEY.test(key) || !isHighEntropySecret(value)) return match;
				if (!hit('high_entropy')) return match;
				return `${key}${sep}${marker('high_entropy')}`;
			}),
	},
];

// -------------------------------------------------------------------------------- org rules

const RULE_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
/** A quantified group that is itself quantified, e.g. `(a+)+`, `(.*)*`: the classic catastrophic shape. */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/;

/** Why an org rule is unusable, or null when it is fine. Use it to validate before saving. */
export function redactionRuleError(rule: RedactionRule): string | null {
	if (!rule || typeof rule.name !== 'string' || !RULE_NAME.test(rule.name))
		return 'A rule name is 1–40 characters: lowercase letters, digits, - and _.';
	if (typeof rule.pattern !== 'string' || rule.pattern.length === 0) return 'A rule needs a pattern.';
	if (rule.pattern.length > MAX_REDACTION_RULE_PATTERN) return `A rule pattern is at most ${MAX_REDACTION_RULE_PATTERN} characters.`;
	if (rule.flags !== undefined && !/^[imsu]*$/.test(rule.flags)) return 'Rule flags may only be i, m, s and u.';
	if (NESTED_QUANTIFIER.test(rule.pattern)) return 'Nested quantifiers such as (a+)+ can hang ingest; rewrite the pattern without them.';
	let compiled: RegExp;
	try {
		compiled = new RegExp(rule.pattern, rule.flags ?? '');
	} catch (error) {
		return `Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`;
	}
	if (compiled.test('')) return 'The pattern matches an empty string, so it would redact nothing useful.';
	return null;
}

interface CompiledRule {
	kind: RedactionKind;
	pattern: RegExp;
}

function compileRule(rule: RedactionRule): CompiledRule {
	const error = redactionRuleError(rule);
	if (error) throw new RedactionRuleError(rule?.name ?? '', error);
	const flags = [...new Set(`${rule.flags ?? ''}g`)].join('');
	return { kind: `rule:${rule.name}`, pattern: new RegExp(rule.pattern, flags) };
}

// ---------------------------------------------------------------------------------- redactor

/** Build a redactor (LOGS.md §10.4). Construct once per project/org config and reuse it. */
export function createRedactor(options: RedactorOptions = {}): Redactor {
	const disabled = new Set<BuiltinRedactionKind>(options.disable ?? []);
	const detectors = DETECTORS.filter((d) => d.kinds.some((kind) => !disabled.has(kind)));
	const rules = (options.rules ?? []).slice(0, MAX_REDACTION_RULES + 1).map(compileRule);
	if (rules.length > MAX_REDACTION_RULES) throw new RedactionRuleError('', `At most ${MAX_REDACTION_RULES} redaction rules.`);

	const matchers: SecretMatcher[] = [];
	if (options.fingerprints) {
		if (!options.fingerprintKey) throw new Error('fingerprints need the fingerprintKey they were made with.');
		matchers.push(new SecretMatcher(keyMaterial(options.fingerprintKey), options.fingerprints));
	}
	if (options.secrets) {
		const key = randomBytes(32);
		matchers.push(new SecretMatcher(keyMaterial(key), createSecretFingerprints(options.secrets, key)));
	}
	const live = matchers.filter((m) => m.size > 0);
	const secretCount = live.reduce((n, m) => n + m.size, 0);

	return {
		secretCount,
		redact(input: string): RedactionResult {
			if (!input) return { text: input, hits: [] };
			let text = input;
			let hits: RedactionKind[] | null = null;
			const hit = (kind: RedactionKind): boolean => {
				if (disabled.size && disabled.has(kind as BuiltinRedactionKind)) return false;
				if (!hits) hits = [kind];
				else if (!hits.includes(kind)) hits.push(kind);
				return true;
			};
			for (const matcher of live) {
				const out = matcher.redact(text);
				if (out !== null) {
					text = out;
					hit('known_secret');
				}
			}
			for (const detector of detectors) {
				if (detector.gate(text)) text = detector.run(text, hit);
			}
			if (rules.length) {
				const head = text.length > MAX_REDACTION_RULE_INPUT ? text.slice(0, MAX_REDACTION_RULE_INPUT) : text;
				const tail = text.length > MAX_REDACTION_RULE_INPUT ? text.slice(MAX_REDACTION_RULE_INPUT) : '';
				let next = head;
				for (const rule of rules) {
					rule.pattern.lastIndex = 0;
					next = next.replace(rule.pattern, (match: string) => (match.includes(ALREADY) || !hit(rule.kind) ? match : marker(rule.kind)));
				}
				text = next + tail;
			}
			return { text, hits: hits ?? [] };
		},
	};
}
