export type RequiredIfMatch =
	| { ok: true; generation: number }
	| { ok: false; status: 400 | 428; error: string };

/**
 * A write that can move a database between primaries must carry the generation the caller saw.
 * The switchover route requires it (the CLI always sends it); a missing header is 428, not a
 * silently optimistic switch (W10 review minor).
 */
export function requireIfMatch(raw: string | null): RequiredIfMatch {
	if (raw === null || raw.trim() === '')
		return { ok: false, status: 428, error: 'If-Match is required: send the primary generation you read.' };
	const value = Number(raw.replace(/^W\//, '').replace(/"/g, '').trim());
	if (!Number.isInteger(value) || value < 0)
		return { ok: false, status: 400, error: 'If-Match must be the primary generation (a non-negative integer).' };
	return { ok: true, generation: value };
}
