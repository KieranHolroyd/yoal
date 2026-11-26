import type { LogTailEvents } from '@yoal/contracts';

/**
 * Is an `end` event a routine close to resume from silently? The server ends every live tail after
 * `LOG_TAIL_MAX_LIFETIME_MS` with code `max_lifetime`, so reconnecting re-checks access; any other
 * end (an error, a revoked scope) is shown.
 */
export function tailEndIsRoutine(data: Partial<LogTailEvents['end']> | null | undefined): boolean {
	return data?.code === 'max_lifetime';
}
