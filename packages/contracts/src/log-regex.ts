/**
 * The safe regex subset for every user regex that runs in JavaScript (docs/LOGS.md §6.1, §10.4).
 *
 * ClickHouse runs query regexes with RE2, which is linear. The same regexes also run in JS, which
 * backtracks: the live-tail predicate inside `LogTailBus.publish` (on the ingest path), log rule
 * previews and ingest rules, and org redact rules. One slow pattern there stalls ingest for every
 * tenant, so the parser (`checkLogRegex`) and the redact-rule validator (`redactionRuleError`) both
 * accept only patterns that pass `checkRegexSafety`:
 *
 * - no lookaround and no backreferences (RE2 has neither);
 * - a group with a variable repeat (`*`, `+`, `?`, `{n,}`, `{n,m}`) may not contain `|` or any
 *   quantifier, so `(a+)+`, `(a|a)*` and `(a|aa)*c` are refused;
 * - at most LOG_REGEX_MAX_UNBOUNDED unbounded repeats (`*`, `+`, `{n,}`) in a pattern;
 * - a static worst-case cost (start positions × the product of each repeat's choices) within
 *   LOG_REGEX_COST_BUDGET, which refuses overlapping neighbours such as `.*x.*y`, `a*a*c` and
 *   `\w+\w+c` (cubic in the line length). A repeat followed by a required character it cannot match
 *   (`\d+ms`, `\w+=`, `[^"]*"`) has one way to end, so it costs nothing extra.
 *
 * JS evaluation also only ever tests the first LOG_REGEX_JS_SUBJECT_MAX characters of a value, so
 * the budget is computed for that length.
 */

/** JS regex evaluation (live tail, rules, redact rules) only sees this many characters of a value. */
export const LOG_REGEX_JS_SUBJECT_MAX = 2048;

/** Most unbounded repeats (`*`, `+`, `{n,}`) a JS-evaluated regex may have. */
export const LOG_REGEX_MAX_UNBOUNDED = 2;

/** Static worst-case step estimate a regex may reach over a LOG_REGEX_JS_SUBJECT_MAX value. */
export const LOG_REGEX_COST_BUDGET = 8 * LOG_REGEX_JS_SUBJECT_MAX * LOG_REGEX_JS_SUBJECT_MAX;

/** The prefix of a value a JS regex is tested against. */
export function logRegexSubject(value: string): string {
	return value.length > LOG_REGEX_JS_SUBJECT_MAX ? value.slice(0, LOG_REGEX_JS_SUBJECT_MAX) : value;
}

type Atom = { kind: 'char'; src: string } | { kind: 'zero'; src: string } | { kind: 'group'; alts: Term[][] };

interface Term {
	atom: Atom;
	min: number;
	max: number;
}

class Unsafe extends Error {}

const N = LOG_REGEX_JS_SUBJECT_MAX;

/**
 * Why `source` (JS syntax, already known to compile with `flags`) is outside the safe subset, or
 * null. Callers check the length cap and syntax themselves.
 */
export function checkRegexSafety(source: string, flags = ''): string | null {
	let alts: Term[][];
	try {
		alts = new RegexWalker(source).parse();
	} catch (error) {
		if (error instanceof Unsafe) return error.message;
		// Fail closed: syntax the walker cannot follow is not known to be safe.
		return 'This regex uses syntax the safety check cannot follow; simplify it';
	}
	let unbounded = 0;
	const visit = (terms: Term[]): void => {
		for (const term of terms) {
			if (term.max === Infinity) unbounded += 1;
			if (term.atom.kind === 'group') for (const alt of term.atom.alts) visit(alt);
		}
	};
	for (const alt of alts) visit(alt);
	if (unbounded > LOG_REGEX_MAX_UNBOUNDED) {
		return `At most ${LOG_REGEX_MAX_UNBOUNDED} unbounded repeats (*, +, {n,}) are allowed in a regex`;
	}
	const anchored = !flags.includes('m') && alts.every((alt) => alt[0]?.atom.kind === 'zero' && alt[0].atom.src === '^');
	const cost = (anchored ? 1 : N) * altsCost(alts, flags);
	if (cost > LOG_REGEX_COST_BUDGET) {
		return 'This regex could backtrack for a long time (like `.*x.*y` or `\\w+\\w+`); anchor it, make neighbouring repeats unable to overlap, or split it into separate terms';
	}
	return null;
}

function altsCost(alts: Term[][], flags: string): number {
	const costs = alts.map((alt) => seqCost(alt, flags));
	if (costs.length === 1) return costs[0]!;
	// Branches that differ in a required character at the same offset never both match at one position.
	const exclusive = alts.every((alt, i) => alts.every((other, j) => j <= i || branchesExclusive(alt, other, flags)));
	return exclusive ? Math.max(...costs) : costs.reduce((sum, c) => sum + c, 0);
}

function branchesExclusive(a: Term[], b: Term[], flags: string): boolean {
	for (let k = 0; k < a.length && k < b.length; k++) {
		const x = a[k]!;
		const y = b[k]!;
		if (x.atom.kind !== 'char' || y.atom.kind !== 'char' || x.min !== 1 || x.max !== 1 || y.min !== 1 || y.max !== 1) return false;
		if (x.atom.src !== y.atom.src) return disjoint(x.atom.src, y.atom.src, flags);
	}
	return false;
}

/**
 * Worst-case steps to try `terms` from one start position, built right to left: a repeat with c
 * ways to end scans up to c characters and, unless a required neighbour it cannot match decides
 * where it ends, retries the rest of the pattern c times.
 */
function seqCost(terms: Term[], flags: string): number {
	let rest = 1;
	for (let i = terms.length - 1; i >= 0; i--) {
		const term = terms[i]!;
		const choices = term.max === Infinity ? N : Math.min(N, term.max - term.min + 1);
		if (term.atom.kind === 'group') {
			// A variably repeated group has a plain body (checked while walking); an exact `{n}` repeats it n times.
			const inner = altsCost(term.atom.alts, flags);
			rest = term.min === term.max ? inner ** term.min * rest : choices * rest + choices;
		} else if (term.atom.kind === 'char' && choices > 1) {
			const next = terms[i + 1];
			const decided = next && next.atom.kind === 'char' && next.min >= 1 && disjoint(term.atom.src, next.atom.src, flags);
			rest = decided ? rest + choices : choices * rest + choices;
		}
		if (rest > Number.MAX_SAFE_INTEGER) return Infinity;
	}
	return rest;
}

// Code points that decide whether two single-character matchers (literals, `.`, `\d\w\s` and their
// negations, ASCII classes) overlap: ASCII and Latin, plus the Unicode spaces `\s` matches and a few
// characters case folding or `.` treat specially.
const SAMPLES: string[] = (() => {
	const points: number[] = [];
	for (let c = 0; c < 0x300; c++) points.push(c);
	points.push(0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff, 0x212a, 0x2126, 0x4e2d, 0x1f600);
	for (let c = 0x2000; c <= 0x200a; c++) points.push(c);
	return points.map((c) => String.fromCodePoint(c));
})();

const disjointCache = new Map<string, boolean>();

/** Can no single character match both `a` and `b`? Unknown (escapes for code points, Unicode properties) → false. */
function disjoint(a: string, b: string, flags: string): boolean {
	const key = `${flags}\u0000${a}\u0000${b}`;
	const cached = disjointCache.get(key);
	if (cached !== undefined) return cached;
	let result = false;
	const opaque = (src: string) => /\\[uxpPc]/.test(src) || /[^\x00-\x7f]/.test(src);
	if (!opaque(a) && !opaque(b)) {
		try {
			const f = flags.replace(/[gym]/g, '');
			const ra = new RegExp(`^(?:${a})$`, f);
			const rb = new RegExp(`^(?:${b})$`, f);
			result = !SAMPLES.some((ch) => ra.test(ch) && rb.test(ch));
		} catch {
			result = false;
		}
	}
	if (disjointCache.size > 1000) disjointCache.clear();
	disjointCache.set(key, result);
	return result;
}

/** A small recursive walker over JS regex syntax, enough to see atoms, groups and repeats. */
class RegexWalker {
	private i = 0;
	constructor(private readonly src: string) {}

	parse(): Term[][] {
		const alts = this.alternation();
		if (this.i < this.src.length) throw new Error(`unexpected ${this.src[this.i]} at ${this.i}`);
		return alts;
	}

	private alternation(): Term[][] {
		const alts: Term[][] = [this.sequence()];
		while (this.src[this.i] === '|') {
			this.i++;
			alts.push(this.sequence());
		}
		return alts;
	}

	private sequence(): Term[] {
		const terms: Term[] = [];
		while (this.i < this.src.length && this.src[this.i] !== '|' && this.src[this.i] !== ')') {
			const atom = this.atom();
			const { min, max } = this.quantifier();
			if (atom.kind === 'group' && min !== max) {
				const plain = atom.alts.length === 1 && atom.alts[0]!.every((term) => term.min === 1 && term.max === 1 && term.atom.kind !== 'group');
				if (atom.alts.length > 1) throw new Unsafe('A repeated group may not contain `|`, like (a|b)*; repeat a character class instead, like [ab]*');
				if (!plain) throw new Unsafe('Nested repetition like (a+)+ is not allowed: a repeated or optional group may not hold a quantifier');
			}
			if (atom.kind === 'group' && min === 1 && max === 1 && atom.alts.length === 1) terms.push(...atom.alts[0]!);
			else terms.push({ atom, min, max });
		}
		return terms;
	}

	private atom(): Atom {
		const src = this.src;
		const start = this.i;
		const ch = src[this.i]!;
		if (ch === '(') {
			if (src.startsWith('(?=', this.i) || src.startsWith('(?!', this.i) || src.startsWith('(?<=', this.i) || src.startsWith('(?<!', this.i)) {
				throw new Unsafe('Lookaround is not supported (RE2)');
			}
			this.i++;
			if (src[this.i] === '?') {
				// (?:…), (?<name>…), (?ims-ims:…): skip to the body.
				const close = src[this.i + 1] === '<' ? src.indexOf('>', this.i) : src.indexOf(':', this.i);
				this.i = close === -1 ? src.length : close + 1;
			}
			const alts = this.alternation();
			if (src[this.i] === ')') this.i++;
			return { kind: 'group', alts };
		}
		if (ch === '[') {
			this.i++;
			if (src[this.i] === '^') this.i++;
			while (this.i < src.length && src[this.i] !== ']') {
				if (src[this.i] === '\\') this.i++;
				this.i++;
			}
			this.i++;
			return { kind: 'char', src: src.slice(start, this.i) };
		}
		if (ch === '\\') {
			const next = src[this.i + 1] ?? '';
			if (/[1-9]/.test(next) || (next === 'k' && src[this.i + 2] === '<')) throw new Unsafe('Backreferences are not supported (RE2)');
			this.i += 2;
			if (next === 'b' || next === 'B') return { kind: 'zero', src: src.slice(start, this.i) };
			if (next === 'x') this.i += 2;
			else if (next === 'u') this.i = src[this.i] === '{' ? src.indexOf('}', this.i) + 1 || src.length : this.i + 4;
			else if ((next === 'p' || next === 'P') && src[this.i] === '{') this.i = src.indexOf('}', this.i) + 1 || src.length;
			else if (next === 'c') this.i += 1;
			return { kind: 'char', src: src.slice(start, this.i) };
		}
		this.i++;
		if (ch === '^' || ch === '$') return { kind: 'zero', src: ch };
		const code = ch.charCodeAt(0);
		if (code >= 0xd800 && code <= 0xdbff && this.i < src.length) this.i++;
		return { kind: 'char', src: src.slice(start, this.i) };
	}

	private quantifier(): { min: number; max: number } {
		const src = this.src;
		let min = 1;
		let max = 1;
		const ch = src[this.i];
		if (ch === '*' || ch === '+' || ch === '?') {
			this.i++;
			min = ch === '+' ? 1 : 0;
			max = ch === '?' ? 1 : Infinity;
		} else if (ch === '{') {
			const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(this.i));
			if (!m) return { min, max };
			this.i += m[0].length;
			min = Number(m[1]);
			max = m[2] === undefined ? min : m[3] ? Number(m[3]) : Infinity;
		} else {
			return { min, max };
		}
		if (src[this.i] === '?') this.i++; // lazy
		return { min, max };
	}
}
