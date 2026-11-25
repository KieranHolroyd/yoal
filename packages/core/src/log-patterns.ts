/**
 * Log pattern mining (docs/LOGS.md §8.1, LP8): an online Drain miner (He et al., ICWS 2017).
 *
 * The indexer calls `patternFor(scopeKey, body)` once per line and stores the returned `id` as
 * `pattern_id`, so the Patterns tab, Compare and `log_pattern_new` alerts are plain GROUP BYs.
 *
 * How a line becomes a template:
 *
 * 1. **First line only.** Multiline records (a joined stack trace, §4.3.1) are mined on their
 *    first line, capped at `maxLineChars`. Two traces with the same message are one pattern.
 * 2. **Masking.** Variable parts become placeholders in one regex pass: quoted strings `<STR>`,
 *    ISO timestamps `<TS>`, URLs and paths with at least two segments `<PATH>`, emails `<EMAIL>`,
 *    UUIDs `<UUID>`, IPv4/IPv6 (with port) `<IP>`, durations such as `120ms` or `1.2s` `<DUR>`,
 *    hex runs of 8 or more with a digit and a letter (or `0x…`) `<HEX>`, and numbers `<NUM>`.
 * 3. **Fixed-depth tree.** Tokens (split on whitespace) are routed by token count, then by the
 *    first `depth - 2` tokens. A token with a digit, or one that arrives when a node already has
 *    `maxChildren` children, takes the `<*>` branch.
 * 4. **Similarity.** In the leaf, the template with the most equal tokens at equal positions
 *    wins if `equal / length >= similarity`; positions that differ become `<*>`. Otherwise the
 *    line starts a new template.
 *
 * **Ids.** A pattern id is the 64-bit FNV-1a hash of the template text (UTF-8), as 16 hex
 * characters. The same template has the same id on every node and after every restart, with no
 * coordination. When a template generalises (a token becomes `<*>`) its id changes: earlier rows
 * keep the old id, and `isNew` is true on the line that caused it so the caller can upsert the new
 * template row (`yoal.log_patterns`).
 *
 * **Bounds.** Each scope keeps at most `maxTemplatesPerScope` templates (least recently used is
 * evicted), and the miner keeps at most `maxScopes` scopes (least recently used scope dropped).
 * `snapshot()` / `restore()` carry the templates across restarts; without a snapshot the indexer
 * rebuilds from the last hour (§8.1).
 *
 * The module is pure: no I/O, no clock, no dependencies. Bench S3 lives in `spikes/logs-bench/`.
 */

/** The placeholder tokens a template may contain (§8.1). */
export const LOG_PATTERN_PLACEHOLDERS = [
	'<NUM>',
	'<HEX>',
	'<UUID>',
	'<IP>',
	'<DUR>',
	'<TS>',
	'<STR>',
	'<PATH>',
	'<EMAIL>',
	'<*>',
] as const;
export type LogPatternPlaceholder = (typeof LOG_PATTERN_PLACEHOLDERS)[number];

/** The wildcard Drain writes where templates differ. */
export const LOG_PATTERN_WILDCARD = '<*>';

export interface DrainMinerOptions {
	/** Tree depth including the root and the length layer (Drain's `depth`). Default 4. */
	depth?: number;
	/** Minimum share of equal tokens for a line to join a template. Default 0.4. */
	similarity?: number;
	/** Children per tree node before new tokens fall into `<*>`. Default 100. */
	maxChildren?: number;
	/** Templates kept per scope (LRU). Default 5,000. */
	maxTemplatesPerScope?: number;
	/** Scopes kept (LRU). Default 2,000. */
	maxScopes?: number;
	/** Characters of the first line that are mined. Default 2,048. */
	maxLineChars?: number;
	/** Tokens per line; the rest collapse into one trailing `<*>`. Default 80. */
	maxTokens?: number;
}

/** What the indexer stores for one line. Satisfies Lane I's `PatternMiner` contract. */
export interface LogPatternMatch {
	/** Stable 16-hex-character hash of `template`. */
	id: string;
	/** Space-joined tokens with placeholders. */
	template: string;
	/** True when this line created the template or changed it (so the id is new to this scope). */
	isNew: boolean;
}

/** One template as listed by `templates()` and carried in snapshots. */
export interface LogPatternTemplate {
	id: string;
	template: string;
	/** Lines matched since the template was created (or restored). */
	count: number;
}

export interface DrainMinerSnapshot {
	version: 1;
	/** Scopes oldest-used first; templates in each scope oldest-used first. */
	scopes: { key: string; templates: { template: string; count: number }[] }[];
}

/** The interface the log indexer injects (Lane I). */
export interface LogPatternMiner {
	patternFor(scopeKey: string, body: string): { id: string; template: string };
}

// ------------------------------------------------------------------------------------ masking

// Order matters: the first alternative that matches at a position wins, so the specific shapes
// (quoted strings, timestamps, URLs, UUIDs, IPs) come before the general ones (hex, numbers).
const MASK_SOURCES: [placeholder: string, source: string][] = [
	// Double-quoted string, but not a JSON key (`"level":`), so JSON lines keep their shape. A quote
	// right after a word character closes a string; it never opens one.
	['<STR>', String.raw`(?<![\w"\\])"(?:[^"\\\n]|\\.){0,512}"(?!\s*:)`],
	// Single-quoted string; an apostrophe inside a word (`can't`) never opens one.
	['<STR>', String.raw`(?<![\w'])'[^'\n]{0,512}'(?!\w)`],
	// ISO 8601 date with optional time and zone, a bare clock time, or a Common Log Format stamp
	// (`25/Nov/2026:14:02:11 +0000`).
	[
		'<TS>',
		String.raw`(?<![\w.:-])\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?(?![\w:]|\.\d)|(?<![\w.:])\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?(?![\w:]|\.\d)|(?<![\w\/])\d{2}\/[A-Z][a-z]{2}\/\d{4}:\d{2}:\d{2}:\d{2}(?: [+-]\d{4})?(?!\w)`,
	],
	// URL (any scheme).
	['<PATH>', String.raw`(?<![\w.+-])[A-Za-z][A-Za-z0-9+.-]{1,15}:\/\/[^\s"'<>\])]+`],
	// Email address.
	['<EMAIL>', String.raw`(?<![\w.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-])`],
	// UUID.
	['<UUID>', String.raw`(?<![\w-])[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![\w-])`],
	// IPv4 with optional port.
	['<IP>', String.raw`(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?!\w|\.\d)`],
	// IPv6: needs `::` or all eight groups, so `10:00` and `std::vector` stay as they are.
	[
		'<IP>',
		String.raw`(?<![\w:.])(?=[0-9a-fA-F:]*::|(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F])[0-9a-fA-F]{0,4}(?::[0-9a-fA-F]{0,4}){2,7}(?![\w:])`,
	],
	// Path with at least two segments (`/api/users`, `./src/app.ts`, `~/x/y`); `/health` stays.
	['<PATH>', String.raw`(?<![\w.~\/-])(?:~|\.{1,2})?(?:\/[\w.@%+~-]+){2,}\/?`],
	// Duration: `120ms`, `1.2s`, `1h30m`, `250µs`.
	['<DUR>', String.raw`(?<![\w.])\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h|d)(?:\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h))*(?!\w)`],
	// Hex: `0x…`, or 8+ hex characters with at least one digit and one letter (all digits is a
	// number; all letters is a word such as `deadbeef` or `effaced`).
	[
		'<HEX>',
		String.raw`(?<!\w)(?:0[xX][0-9a-fA-F]+|(?=[0-9a-fA-F]{8,}(?!\w))(?=[a-fA-F]*\d)(?=\d*[a-fA-F])[0-9a-fA-F]+)(?!\w)`,
	],
	// Number (signed, decimal, exponent, optional size unit or %). `v1.2.3` and `user42` stay;
	// `id=42`, `node-3`, `512MB` and `40%` mask.
	['<NUM>', String.raw`(?<![\w.])[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?(?:[KMGTP]i?B|B|%)?(?!\w|\.\d)`],
];

const MASK_PATTERN = new RegExp(MASK_SOURCES.map(([, source]) => `(${source})`).join('|'), 'g');
const MASK_PLACEHOLDERS = MASK_SOURCES.map(([placeholder]) => placeholder);
/** Cheap pre-check: a line with no digit, quote, slash or `@` has nothing to mask. */
const MAY_NEED_MASK = /[\d"'\/@]/;

function maskReplacer(...args: unknown[]): string {
	// args: match, g1…gN, offset, input. The first defined group is the alternative that matched.
	for (let i = 1; i <= MASK_PLACEHOLDERS.length; i++) {
		if (args[i] !== undefined) return MASK_PLACEHOLDERS[i - 1]!;
	}
	return args[0] as string;
}

/** Replace the variable parts of one line with placeholders (§8.1). Exported for tests and tools. */
export function maskLogLine(line: string): string {
	if (!MAY_NEED_MASK.test(line)) return line;
	return line.replace(MASK_PATTERN, maskReplacer);
}

// ---------------------------------------------------------------------------------------- ids

/**
 * FNV-1a 64 over the UTF-8 bytes of `template`, as 16 lowercase hex characters. Computed with
 * 16-bit limbs so it is exact in JavaScript without BigInt, and identical on every runtime.
 */
export function logPatternId(template: string): string {
	// offset basis 0xcbf29ce484222325, as four 16-bit limbs (least significant first)
	let h0 = 0x2325;
	let h1 = 0x8422;
	let h2 = 0x9ce4;
	let h3 = 0xcbf2;
	const step = (byte: number) => {
		const a0 = h0 ^ byte;
		const a1 = h1;
		// Multiply by the FNV prime 2^40 + 0x1b3: the limb products, plus the 40-bit shift that
		// moves limb 0 into limbs 2–3 and limb 1 into limb 3 (higher bits fall off the end).
		let t = a0 * 0x1b3;
		h0 = t & 0xffff;
		t = a1 * 0x1b3 + (t >>> 16);
		h1 = t & 0xffff;
		t = h2 * 0x1b3 + (a0 << 8) + (t >>> 16);
		h2 = t & 0xffff;
		t = h3 * 0x1b3 + (a1 << 8) + (t >>> 16);
		h3 = t & 0xffff;
	};
	for (let i = 0; i < template.length; i++) {
		let code = template.charCodeAt(i);
		if (code < 0x80) {
			step(code);
			continue;
		}
		if (code >= 0xd800 && code <= 0xdbff && i + 1 < template.length) {
			const low = template.charCodeAt(i + 1);
			if (low >= 0xdc00 && low <= 0xdfff) {
				code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
				i++;
			}
		}
		if (code < 0x800) {
			step(0xc0 | (code >> 6));
			step(0x80 | (code & 0x3f));
		} else if (code < 0x10000) {
			step(0xe0 | (code >> 12));
			step(0x80 | ((code >> 6) & 0x3f));
			step(0x80 | (code & 0x3f));
		} else {
			step(0xf0 | (code >> 18));
			step(0x80 | ((code >> 12) & 0x3f));
			step(0x80 | ((code >> 6) & 0x3f));
			step(0x80 | (code & 0x3f));
		}
	}
	return hex4(h3) + hex4(h2) + hex4(h1) + hex4(h0);
}

function hex4(limb: number): string {
	return (limb & 0xffff).toString(16).padStart(4, '0');
}

// --------------------------------------------------------------------------------------- tree

interface TreeNode {
	children: Map<string, TreeNode>;
	/** Set only on leaves. */
	clusters: Cluster[] | null;
}

interface Cluster {
	tokens: string[];
	template: string;
	id: string;
	count: number;
	/** The leaf list holding this cluster, for O(leaf) eviction. */
	leaf: Cluster[];
}

interface ScopeState {
	/** Length layer: token count → first-token node. */
	byLength: Map<number, TreeNode>;
	/** All clusters in recency order (oldest first). */
	lru: Set<Cluster>;
}

const HAS_DIGIT = /\d/;
const WHITESPACE = /\s+/;

/** Online Drain miner, one tree per scope (docs/LOGS.md §8.1). */
export class DrainMiner implements LogPatternMiner {
	private readonly prefixDepth: number;
	private readonly similarity: number;
	private readonly maxChildren: number;
	private readonly maxTemplates: number;
	private readonly maxScopes: number;
	private readonly maxLineChars: number;
	private readonly maxTokens: number;
	private readonly scopes = new Map<string, ScopeState>();

	constructor(options: DrainMinerOptions = {}) {
		const depth = options.depth ?? 4;
		if (!Number.isInteger(depth) || depth < 3) throw new RangeError('DrainMiner depth must be an integer of at least 3.');
		this.prefixDepth = depth - 2;
		this.similarity = options.similarity ?? 0.4;
		this.maxChildren = Math.max(2, options.maxChildren ?? 100);
		this.maxTemplates = Math.max(1, options.maxTemplatesPerScope ?? 5_000);
		this.maxScopes = Math.max(1, options.maxScopes ?? 2_000);
		this.maxLineChars = Math.max(16, options.maxLineChars ?? 2_048);
		this.maxTokens = Math.max(2, options.maxTokens ?? 80);
	}

	/** Mine one line for a scope (e.g. `org:project:prj_…`) and return its template. */
	patternFor(scopeKey: string, body: string): LogPatternMatch {
		const tokens = this.tokenize(body);
		const scope = this.scope(scopeKey);
		const leaf = this.leafFor(scope, tokens);
		const match = this.bestMatch(leaf, tokens);
		if (match) {
			match.count++;
			scope.lru.delete(match);
			scope.lru.add(match);
			if (this.generalise(match, tokens)) return { id: match.id, template: match.template, isNew: true };
			return { id: match.id, template: match.template, isNew: false };
		}
		const cluster = this.addCluster(scope, leaf, tokens, 1);
		return { id: cluster.id, template: cluster.template, isNew: true };
	}

	/** Templates of one scope, most recently used first. */
	templates(scopeKey: string): LogPatternTemplate[] {
		const scope = this.scopes.get(scopeKey);
		if (!scope) return [];
		return [...scope.lru].reverse().map((c) => ({ id: c.id, template: c.template, count: c.count }));
	}

	/** Drop one scope's templates (e.g. when a project is deleted). */
	forget(scopeKey: string): void {
		this.scopes.delete(scopeKey);
	}

	stats(): { scopes: number; templates: number } {
		let templates = 0;
		for (const scope of this.scopes.values()) templates += scope.lru.size;
		return { scopes: this.scopes.size, templates };
	}

	/** A JSON-serialisable copy of every template, for a warm restart. */
	snapshot(): DrainMinerSnapshot {
		const scopes: DrainMinerSnapshot['scopes'] = [];
		for (const [key, scope] of this.scopes) {
			const templates: { template: string; count: number }[] = [];
			for (const cluster of scope.lru) templates.push({ template: cluster.template, count: cluster.count });
			scopes.push({ key, templates });
		}
		return { version: 1, scopes };
	}

	/**
	 * Load a snapshot, replacing every scope it names. Templates are re-inserted as they are (no
	 * re-mining), so their ids are unchanged. Unknown versions and malformed entries are ignored.
	 */
	restore(snapshot: DrainMinerSnapshot): void {
		if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.scopes)) return;
		for (const entry of snapshot.scopes) {
			if (!entry || typeof entry.key !== 'string' || !Array.isArray(entry.templates)) continue;
			this.scopes.delete(entry.key);
			const scope = this.scope(entry.key);
			for (const item of entry.templates) {
				if (!item || typeof item.template !== 'string') continue;
				const tokens = item.template === '' ? [] : item.template.split(' ');
				const leaf = this.leafFor(scope, tokens);
				const count = Number.isFinite(item.count) && item.count > 0 ? Math.floor(item.count) : 1;
				const existing = leaf.find((c) => c.template === item.template);
				if (existing) {
					existing.count += count;
					continue;
				}
				this.addCluster(scope, leaf, tokens, count);
			}
		}
	}

	// ------------------------------------------------------------------------------- internals

	private tokenize(body: string): string[] {
		let line = minedLine(body);
		if (line.length > this.maxLineChars) line = line.slice(0, this.maxLineChars);
		line = maskLogLine(line).trim();
		if (line === '') return [];
		const tokens = line.split(WHITESPACE);
		if (tokens.length > this.maxTokens) {
			tokens.length = this.maxTokens - 1;
			tokens.push(LOG_PATTERN_WILDCARD);
		}
		return tokens;
	}

	private scope(key: string): ScopeState {
		let scope = this.scopes.get(key);
		if (scope) {
			// Keep scope recency cheap: only re-order when it is not already the newest.
			if (this.scopes.size > 1) {
				this.scopes.delete(key);
				this.scopes.set(key, scope);
			}
			return scope;
		}
		scope = { byLength: new Map(), lru: new Set() };
		this.scopes.set(key, scope);
		if (this.scopes.size > this.maxScopes) {
			const oldest = this.scopes.keys().next().value;
			if (oldest !== undefined) this.scopes.delete(oldest);
		}
		return scope;
	}

	/** Walk (and grow) the tree to the leaf for `tokens` (Drain's add-to-prefix-tree rules). */
	private leafFor(scope: ScopeState, tokens: string[]): Cluster[] {
		let node: TreeNode | undefined = scope.byLength.get(tokens.length);
		if (!node) {
			node = { children: new Map(), clusters: null };
			scope.byLength.set(tokens.length, node);
		}
		const levels = Math.min(this.prefixDepth, tokens.length);
		for (let i = 0; i < levels; i++) {
			const token = tokens[i]!;
			let next: TreeNode | undefined = node.children.get(token);
			if (!next) {
				const key = this.childKey(node, token);
				next = node.children.get(key);
				if (!next) {
					next = { children: new Map(), clusters: null };
					node.children.set(key, next);
				}
			}
			node = next;
		}
		if (!node.clusters) node.clusters = [];
		return node.clusters;
	}

	/** Which child a token that has no exact child of its own goes to. */
	private childKey(node: TreeNode, token: string): string {
		if (token === LOG_PATTERN_WILDCARD || HAS_DIGIT.test(token)) return LOG_PATTERN_WILDCARD;
		const size = node.children.size;
		if (node.children.has(LOG_PATTERN_WILDCARD)) return size < this.maxChildren ? token : LOG_PATTERN_WILDCARD;
		// Keep the last slot for the wildcard child.
		return size + 1 < this.maxChildren ? token : LOG_PATTERN_WILDCARD;
	}

	private bestMatch(leaf: Cluster[], tokens: string[]): Cluster | null {
		let best: Cluster | null = null;
		let bestSim = -1;
		let bestParams = -1;
		const length = tokens.length;
		for (let c = 0; c < leaf.length; c++) {
			const cluster = leaf[c]!;
			const template = cluster.tokens;
			if (template.length !== length) continue;
			let equal = 0;
			let params = 0;
			for (let i = 0; i < length; i++) {
				const t = template[i]!;
				if (t === LOG_PATTERN_WILDCARD) params++;
				else if (t === tokens[i]) equal++;
			}
			const sim = length === 0 ? 1 : equal / length;
			if (sim > bestSim || (sim === bestSim && params > bestParams)) {
				best = cluster;
				bestSim = sim;
				bestParams = params;
			}
		}
		return best && bestSim >= this.similarity ? best : null;
	}

	/** Turn differing positions into `<*>`. Returns true when the template changed. */
	private generalise(cluster: Cluster, tokens: string[]): boolean {
		const template = cluster.tokens;
		let changed = false;
		for (let i = 0; i < template.length; i++) {
			if (template[i] !== LOG_PATTERN_WILDCARD && template[i] !== tokens[i]) {
				template[i] = LOG_PATTERN_WILDCARD;
				changed = true;
			}
		}
		if (changed) {
			cluster.template = template.join(' ');
			cluster.id = logPatternId(cluster.template);
		}
		return changed;
	}

	private addCluster(scope: ScopeState, leaf: Cluster[], tokens: string[], count: number): Cluster {
		// Copy tokens into fresh strings so a template never pins the (up to 16 KB) source line.
		const own = tokens.map(ownString);
		const template = own.join(' ');
		const cluster: Cluster = { tokens: own, template, id: logPatternId(template), count, leaf };
		leaf.push(cluster);
		scope.lru.add(cluster);
		if (scope.lru.size > this.maxTemplates) {
			const oldest = scope.lru.values().next().value;
			if (oldest) this.evict(scope, oldest);
		}
		return cluster;
	}

	private evict(scope: ScopeState, cluster: Cluster): void {
		scope.lru.delete(cluster);
		const index = cluster.leaf.indexOf(cluster);
		if (index >= 0) cluster.leaf.splice(index, 1);
	}
}

const PYTHON_TRACEBACK = 'Traceback (most recent call last):';

/**
 * The line of a (possibly multiline) record that names it: the first line, except for a Python
 * traceback, whose exception (`KeyError: 'id'`) is the last non-blank line.
 */
function minedLine(body: string): string {
	const newline = body.indexOf('\n');
	if (newline < 0) return body;
	const first = body.slice(0, newline);
	if (first.trimEnd() !== PYTHON_TRACEBACK) return first;
	const last = body.trimEnd();
	const start = last.lastIndexOf('\n');
	const tail = last.slice(start + 1).trim();
	return tail && !tail.startsWith('File "') ? tail : first;
}

/** Detach a substring from its parent so the parent line can be collected. */
function ownString(value: string): string {
	return value.length > 64 ? (' ' + value).slice(1) : value;
}
