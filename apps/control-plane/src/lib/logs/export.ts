import type { LogRecord, LogSearchResult } from '@yoal/contracts';
import { formatLogScope } from '@yoal/contracts';
import { stripAnsi } from './ansi.js';

/**
 * Download the current query as NDJSON or CSV (docs/LOGS.md §7.2). Built in the browser from
 * search pages, capped at 100,000 rows; anything bigger is what drains are for.
 */

export const EXPORT_CAP = 100_000;
export const EXPORT_PAGE = 1_000;

export type ExportFormat = 'ndjson' | 'csv';

/** One JSON object per line, the record exactly as the API returned it. */
export function toNdjson(records: readonly LogRecord[]): string {
	if (records.length === 0) return '';
	return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

export const CSV_COLUMNS = [
	'ts',
	'severity',
	'scope',
	'service',
	'stream',
	'source',
	'channel',
	'body',
	'request_id',
	'trace_id',
	'attributes'
] as const;

/**
 * RFC 4180 quoting, plus a guard against spreadsheet formula injection: a cell that starts with
 * `=`, `+`, `-`, `@`, tab or CR is prefixed with `'` so Excel and Sheets show it as text.
 */
export function csvCell(value: string | number | null | undefined): string {
	if (value === null || value === undefined) return '';
	let text = String(value);
	if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
	if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
	return text;
}

function csvRow(record: LogRecord): string {
	const attributes =
		Object.keys(record.attributes).length > 0 ? JSON.stringify(record.attributes) : '';
	const cells: Array<string | number | null> = [
		new Date(record.ts).toISOString(),
		record.severity,
		formatLogScope(record.scope),
		record.scopeName,
		record.stream,
		record.source,
		record.channel,
		stripAnsi(record.body),
		record.requestId,
		record.traceId,
		attributes
	];
	return cells.map(csvCell).join(',');
}

/** A header row and one row per record, CRLF line endings (what spreadsheets expect). */
export function toCsv(records: readonly LogRecord[]): string {
	const lines = [CSV_COLUMNS.join(','), ...records.map(csvRow)];
	return `${lines.join('\r\n')}\r\n`;
}

export function exportBody(records: readonly LogRecord[], format: ExportFormat): string {
	return format === 'csv' ? toCsv(records) : toNdjson(records);
}

export function exportMime(format: ExportFormat): string {
	return format === 'csv' ? 'text/csv;charset=utf-8' : 'application/x-ndjson;charset=utf-8';
}

/** `api-logs-2026-11-25T1402Z.ndjson` */
export function exportFilename(base: string, format: ExportFormat, now = Date.now()): string {
	const stamp = new Date(now).toISOString().slice(0, 16).replace(/[-:]/g, '');
	const safe = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'logs';
	return `${safe}-${stamp}Z.${format}`;
}

/**
 * Page through a query, newest first, until the cursor runs out or `cap` rows are collected.
 * `fetchPage` is the API call; `onProgress` lets the UI show a count; `signal` cancels.
 */
export async function collectForExport(
	fetchPage: (
		cursor: string | undefined,
		limit: number
	) => Promise<Pick<LogSearchResult, 'records' | 'cursor'>>,
	options: {
		cap?: number;
		pageSize?: number;
		signal?: AbortSignal;
		onProgress?: (count: number) => void;
	} = {}
): Promise<{ records: LogRecord[]; capped: boolean }> {
	const cap = Math.max(1, Math.min(options.cap ?? EXPORT_CAP, EXPORT_CAP));
	const pageSize = options.pageSize ?? EXPORT_PAGE;
	const records: LogRecord[] = [];
	const seen = new Set<string>();
	let cursor: string | undefined;
	for (;;) {
		if (options.signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
		const page = await fetchPage(cursor, Math.min(pageSize, cap - records.length));
		for (const record of page.records) {
			if (seen.has(record.id)) continue;
			seen.add(record.id);
			records.push(record);
			if (records.length >= cap) break;
		}
		options.onProgress?.(records.length);
		if (records.length >= cap) return { records, capped: page.cursor.older !== null };
		const next = page.cursor.older;
		if (!next || page.records.length === 0 || next === cursor) return { records, capped: false };
		cursor = next;
	}
}

/** Save a string as a file (browser only). */
export function downloadText(body: string, filename: string, mime: string): void {
	const blob = new Blob([body], { type: mime });
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = filename;
	anchor.click();
	setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
