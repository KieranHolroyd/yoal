/**
 * Fleet node updates (docs/CLUSTERING.md §3.11, D217): turn the dashboard's form fields or query
 * parameters into the body `core.nodeRollouts.plan`/`start` validate. Values are passed through as
 * typed as possible and left to the contract's schema, so its messages reach the reader unchanged.
 */
export function rolloutInput(
	get: (key: string) => string | null,
	nodeIds: string[] = []
): Record<string, unknown> {
	const input: Record<string, unknown> = {};
	const text = (key: string) => get(key)?.trim() ?? '';
	const strategy = text('strategy');
	if (strategy) input.strategy = strategy;
	for (const key of ['batchSize', 'soakSeconds', 'maxFailures'] as const) {
		const raw = text(key);
		if (!raw) continue;
		const value = Number(raw);
		input[key] = Number.isFinite(value) ? value : raw;
	}
	for (const key of ['drain', 'canary'] as const) {
		const raw = text(key);
		if (raw === 'true' || raw === 'on' || raw === '1') input[key] = true;
		else if (raw === 'false' || raw === '0') input[key] = false;
	}
	const ids = nodeIds.map((id) => id.trim()).filter(Boolean);
	if (ids.length > 0) input.nodeIds = ids;
	return input;
}
