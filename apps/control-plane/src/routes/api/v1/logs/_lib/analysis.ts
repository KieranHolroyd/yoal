import { parseLogCompareBaseline } from '@yoal/contracts';
import { ValidationError } from '@yoal/core';
import { logInput, logInputFromQuery } from './request';

/**
 * Request decoding for `/api/v1/logs/compare` and `/why` (docs/LOGS.md §8.2–§8.3). POST takes the
 * contract body (`logCompareInputSchema`, `logWhyInputSchema`) plus `range`; GET takes the read
 * query string plus the URL forms the Explorer links with: `baseline=previous|offset:<ms>|
 * deploy:<id>|range:<from>-<to>`, `selection=<from>-<to>`, `field` (repeated) and `limit`.
 */

export type LogAnalysisKind = 'compare' | 'why';

const BASELINE_HELP =
	'Invalid baseline; use previous, offset:<ms>, deploy:<id> or range:<from>-<to>.';

function baselineFrom(raw: string): unknown {
	const baseline = parseLogCompareBaseline(raw);
	if (!baseline)
		throw new ValidationError(BASELINE_HELP, [
			{ path: ['baseline'], message: `"${raw}" is not a baseline` }
		]);
	return baseline;
}

/** Query string → compare or why input. A malformed baseline or selection is a 422. */
export function analysisInputFromQuery(
	params: URLSearchParams,
	kind: LogAnalysisKind,
	now: number
): Record<string, unknown> {
	const input = logInputFromQuery(params, 'read', now);
	const limit = params.get('limit');
	if (limit !== null && limit.trim() !== '') {
		const number = Number(limit);
		input.limit = Number.isFinite(number) ? number : limit;
	}
	if (kind === 'compare') {
		input.baseline = baselineFrom(params.get('baseline') ?? 'previous');
		return input;
	}
	const raw = params.get('selection') ?? '';
	const match = /^(\d{1,15})-(\d{1,15})$/.exec(raw.trim());
	if (!match)
		throw new ValidationError('Invalid selection; use <from>-<to> in epoch milliseconds.', [
			{ path: ['selection'], message: `"${raw}" is not from-to` }
		]);
	input.selection = { from: Number(match[1]), to: Number(match[2]) };
	const fields = params.getAll('field').filter((value) => value.trim() !== '');
	if (fields.length > 0) input.fields = fields;
	return input;
}

/** GET → query string; POST → JSON body (the baseline may also be its URL string form). */
export async function analysisInput(
	request: Request,
	url: URL,
	kind: LogAnalysisKind,
	now = Date.now()
): Promise<Record<string, unknown>> {
	if (request.method === 'GET' || request.method === 'HEAD')
		return analysisInputFromQuery(url.searchParams, kind, now);
	const input = await logInput(request, url, 'read', now);
	if (kind === 'compare' && typeof input.baseline === 'string')
		input.baseline = baselineFrom(input.baseline);
	return input;
}
