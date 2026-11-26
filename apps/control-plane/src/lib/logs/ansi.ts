/**
 * A small ANSI SGR renderer for log bodies (docs/LOGS.md §7.2: "ANSI colours rendered"). It turns
 * text with escape sequences into styled segments; the component maps a segment's style to CSS.
 * Colours from the 16-colour palette are names (themed by CSS variables, so dark mode works);
 * 256-colour and truecolour values become `rgb()` strings. Every other escape (cursor moves, OSC
 * titles and hyperlinks) is dropped. Pure and allocation-light: bodies are capped at 16 KiB.
 */

export const ANSI_COLOR_NAMES = [
	'black',
	'red',
	'green',
	'yellow',
	'blue',
	'magenta',
	'cyan',
	'white',
	'bright-black',
	'bright-red',
	'bright-green',
	'bright-yellow',
	'bright-blue',
	'bright-magenta',
	'bright-cyan',
	'bright-white'
] as const;
export type AnsiColorName = (typeof ANSI_COLOR_NAMES)[number];

/** A palette name or a CSS `rgb(…)` string. */
export type AnsiColor = AnsiColorName | `rgb(${number}, ${number}, ${number})`;

export interface AnsiStyle {
	fg?: AnsiColor;
	bg?: AnsiColor;
	bold?: boolean;
	dim?: boolean;
	italic?: boolean;
	underline?: boolean;
	inverse?: boolean;
	strike?: boolean;
}

export interface AnsiSegment {
	text: string;
	/** Null for plain text. */
	style: AnsiStyle | null;
}

// CSI (ESC [ … final byte), OSC (ESC ] … BEL or ESC \), and lone two-byte escapes.
/* eslint-disable no-control-regex -- matching terminal escapes is the point */
const ESCAPE =
	/\u001b\[([0-9;:?]*)([ -/]*)([@-~])|\u001b\][\s\S]*?(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
/* eslint-enable no-control-regex */

export function hasAnsi(text: string): boolean {
	return text.includes('\u001b');
}

export function stripAnsi(text: string): string {
	return hasAnsi(text) ? text.replace(ESCAPE, '') : text;
}

/** xterm's 256-colour cube and grey ramp. */
function color256(n: number): AnsiColor | undefined {
	if (!Number.isInteger(n) || n < 0 || n > 255) return undefined;
	if (n < 16) return ANSI_COLOR_NAMES[n];
	if (n >= 232) {
		const v = 8 + (n - 232) * 10;
		return `rgb(${v}, ${v}, ${v})`;
	}
	const index = n - 16;
	const level = (value: number) => (value === 0 ? 0 : 55 + value * 40);
	return `rgb(${level(Math.floor(index / 36))}, ${level(Math.floor(index / 6) % 6)}, ${level(index % 6)})`;
}

function clamp(n: number | undefined): number {
	return Math.max(0, Math.min(255, Number.isFinite(n) ? Math.trunc(n!) : 0));
}

/** Apply one SGR parameter list to `style` (mutates a copy the caller owns). */
function applySgr(style: AnsiStyle, codes: number[]): AnsiStyle {
	let next = { ...style };
	if (codes.length === 0) return {};
	for (let i = 0; i < codes.length; i++) {
		const code = codes[i]!;
		if (code === 0) next = {};
		else if (code === 1) next.bold = true;
		else if (code === 2) next.dim = true;
		else if (code === 3) next.italic = true;
		else if (code === 4) next.underline = true;
		else if (code === 7) next.inverse = true;
		else if (code === 9) next.strike = true;
		else if (code === 21 || code === 22) {
			delete next.bold;
			delete next.dim;
		} else if (code === 23) delete next.italic;
		else if (code === 24) delete next.underline;
		else if (code === 27) delete next.inverse;
		else if (code === 29) delete next.strike;
		else if (code >= 30 && code <= 37) next.fg = ANSI_COLOR_NAMES[code - 30];
		else if (code === 39) delete next.fg;
		else if (code >= 40 && code <= 47) next.bg = ANSI_COLOR_NAMES[code - 40];
		else if (code === 49) delete next.bg;
		else if (code >= 90 && code <= 97) next.fg = ANSI_COLOR_NAMES[code - 90 + 8];
		else if (code >= 100 && code <= 107) next.bg = ANSI_COLOR_NAMES[code - 100 + 8];
		else if (code === 38 || code === 48) {
			const mode = codes[i + 1];
			let value: AnsiColor | undefined;
			if (mode === 5) {
				value = color256(codes[i + 2] ?? -1);
				i += 2;
			} else if (mode === 2) {
				value = `rgb(${clamp(codes[i + 2])}, ${clamp(codes[i + 3])}, ${clamp(codes[i + 4])})`;
				i += 4;
			} else {
				// Malformed extended colour: skip the rest of this sequence.
				break;
			}
			if (value) {
				if (code === 38) next.fg = value;
				else next.bg = value;
			}
		}
		// Anything else (blink, fonts, overline…) is ignored on purpose.
	}
	return next;
}

function isPlain(style: AnsiStyle): boolean {
	return Object.keys(style).length === 0;
}

/** Split text into styled segments. Adjacent segments with the same style are merged. */
export function parseAnsi(text: string): AnsiSegment[] {
	if (!hasAnsi(text)) return text ? [{ text, style: null }] : [];
	const segments: AnsiSegment[] = [];
	let style: AnsiStyle = {};
	let last = 0;
	const push = (chunk: string) => {
		if (!chunk) return;
		const current = isPlain(style) ? null : style;
		const previous = segments.at(-1);
		if (previous && JSON.stringify(previous.style) === JSON.stringify(current))
			previous.text += chunk;
		else segments.push({ text: chunk, style: current });
	};
	ESCAPE.lastIndex = 0;
	for (let match = ESCAPE.exec(text); match; match = ESCAPE.exec(text)) {
		push(text.slice(last, match.index));
		last = match.index + match[0].length;
		// Only SGR (`ESC [ … m`) changes style.
		if (match[3] === 'm' && match[2] === '' && !match[1]?.startsWith('?')) {
			const params = match[1] ?? '';
			const codes =
				params === '' ? [] : params.split(/[;:]/).map((part) => (part === '' ? 0 : Number(part)));
			style = applySgr(
				style,
				codes.filter((code) => Number.isFinite(code))
			);
		}
	}
	push(text.slice(last));
	return segments;
}

/** Inline CSS for a segment. Palette names resolve through `--ansi-<name>` variables. */
export function ansiStyleCss(style: AnsiStyle | null): string {
	if (!style) return '';
	const resolve = (color: AnsiColor) => (color.startsWith('rgb(') ? color : `var(--ansi-${color})`);
	let fg = style.fg ? resolve(style.fg) : null;
	let bg = style.bg ? resolve(style.bg) : null;
	if (style.inverse) {
		const swap = fg;
		fg = bg ?? 'var(--background, #fff)';
		bg = swap ?? 'currentColor';
	}
	const parts: string[] = [];
	if (fg) parts.push(`color: ${fg}`);
	if (bg) parts.push(`background-color: ${bg}`);
	if (style.bold) parts.push('font-weight: 600');
	if (style.dim) parts.push('opacity: 0.7');
	if (style.italic) parts.push('font-style: italic');
	const lines = [style.underline ? 'underline' : '', style.strike ? 'line-through' : ''].filter(
		Boolean
	);
	if (lines.length > 0) parts.push(`text-decoration: ${lines.join(' ')}`);
	return parts.join('; ');
}
