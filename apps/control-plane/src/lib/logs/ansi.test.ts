import { describe, expect, test } from 'bun:test';
import { ansiStyleCss, hasAnsi, parseAnsi, stripAnsi } from './ansi';

const ESC = '\u001b';

describe('ANSI renderer', () => {
	test('plain text is one unstyled segment', () => {
		expect(parseAnsi('hello')).toEqual([{ text: 'hello', style: null }]);
		expect(parseAnsi('')).toEqual([]);
		expect(hasAnsi('hello')).toBe(false);
	});

	test('basic foreground colours and reset', () => {
		expect(parseAnsi(`${ESC}[31merror${ESC}[0m done`)).toEqual([
			{ text: 'error', style: { fg: 'red' } },
			{ text: ' done', style: null }
		]);
	});

	test('bright colours, background and attributes combine', () => {
		expect(parseAnsi(`${ESC}[1;92;44mok${ESC}[22m!`)).toEqual([
			{ text: 'ok', style: { bold: true, fg: 'bright-green', bg: 'blue' } },
			{ text: '!', style: { fg: 'bright-green', bg: 'blue' } }
		]);
	});

	test('`ESC[m` is a reset', () => {
		expect(parseAnsi(`${ESC}[33mwarn${ESC}[m plain`)).toEqual([
			{ text: 'warn', style: { fg: 'yellow' } },
			{ text: ' plain', style: null }
		]);
	});

	test('256-colour and truecolour', () => {
		const [cube, grey, truecolor, low] = [
			parseAnsi(`${ESC}[38;5;196mx`)[0]!,
			parseAnsi(`${ESC}[48;5;244mx`)[0]!,
			parseAnsi(`${ESC}[38;2;10;20;300mx`)[0]!,
			parseAnsi(`${ESC}[38;5;9mx`)[0]!
		];
		expect(cube.style).toEqual({ fg: 'rgb(255, 0, 0)' });
		expect(grey.style).toEqual({ bg: 'rgb(128, 128, 128)' });
		expect(truecolor.style).toEqual({ fg: 'rgb(10, 20, 255)' });
		expect(low.style).toEqual({ fg: 'bright-red' });
	});

	test('default foreground/background codes clear colours', () => {
		expect(parseAnsi(`${ESC}[31;42ma${ESC}[39mb${ESC}[49mc`)).toEqual([
			{ text: 'a', style: { fg: 'red', bg: 'green' } },
			{ text: 'b', style: { bg: 'green' } },
			{ text: 'c', style: null }
		]);
	});

	test('non-SGR escapes are dropped, not shown', () => {
		const text = `${ESC}[2K${ESC}[1Gprogress ${ESC}]0;title${ESC}\\done${ESC}]8;;https://x${'\u0007'}link`;
		expect(parseAnsi(text)).toEqual([{ text: 'progress donelink', style: null }]);
		expect(stripAnsi(text)).toBe('progress donelink');
	});

	test('adjacent segments with the same style merge', () => {
		expect(parseAnsi(`${ESC}[31ma${ESC}[31mb`)).toEqual([{ text: 'ab', style: { fg: 'red' } }]);
	});

	test('an unterminated sequence does not swallow text', () => {
		expect(stripAnsi(`a${ESC}[31`)).toContain('a');
	});

	test('CSS for a segment uses theme variables for palette colours', () => {
		expect(ansiStyleCss(null)).toBe('');
		expect(ansiStyleCss({ fg: 'red', bold: true })).toBe(
			'color: var(--ansi-red); font-weight: 600'
		);
		expect(ansiStyleCss({ bg: 'rgb(1, 2, 3)', underline: true, strike: true })).toBe(
			'background-color: rgb(1, 2, 3); text-decoration: underline line-through'
		);
		expect(ansiStyleCss({ fg: 'green', inverse: true })).toBe(
			'color: var(--background, #fff); background-color: var(--ansi-green)'
		);
	});
});
