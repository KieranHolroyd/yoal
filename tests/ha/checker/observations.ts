/**
 * The observation stream: JSON lines the lab (or a test) appends during a run, one per observation.
 * Every line has `{ t, kind, node }`; the remaining fields depend on the kind and are documented in
 * tests/ha/README.md. Unknown fields are kept; a field an invariant needs is checked where it is used.
 */
import { z } from './zod.ts';

export const OBSERVATION_KINDS = [
	'lease',
	'epoch',
	'db-role',
	'fence',
	'write-attempt',
	'singleton',
	'release-command',
	'ingress',
	'route',
	'fault',
	// Additive to the W1 contract: single-writer volume mounts, for I5.
	'mount',
] as const;
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

export const observationSchema = z
	.object({
		/** Epoch ms on the lab controller's clock (the same host as the checker, or NTP-synced to it). */
		t: z.number(),
		kind: z.enum(OBSERVATION_KINDS),
		/** The node the observation is about or from; `arbiter` for the arbiter's own record. */
		node: z.string().min(1),
	})
	.passthrough();

export type Observation = z.infer<typeof observationSchema> & Record<string, unknown>;

export interface ParsedObservations {
	observations: Observation[];
	errors: string[];
}

export function parseObservations(text: string): ParsedObservations {
	const observations: Observation[] = [];
	const errors: string[] = [];
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]?.trim();
		if (!line) continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			// A torn last line from a writer still appending is not an error.
			if (i < lines.length - 1) errors.push(`line ${i + 1}: not JSON`);
			continue;
		}
		const parsed = observationSchema.safeParse(value);
		if (parsed.success) observations.push(parsed.data as Observation);
		else errors.push(`line ${i + 1}: ${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}`);
	}
	observations.sort((a, b) => a.t - b.t);
	return { observations, errors };
}

// Typed field access: observations are loose by design.
export const str = (o: Observation, key: string): string | undefined => (typeof o[key] === 'string' ? (o[key] as string) : undefined);
export const num = (o: Observation, key: string): number | undefined =>
	typeof o[key] === 'number' && Number.isFinite(o[key]) ? (o[key] as number) : undefined;
export const bool = (o: Observation, key: string): boolean | undefined => (typeof o[key] === 'boolean' ? (o[key] as boolean) : undefined);
export const strings = (o: Observation, key: string): string[] | undefined =>
	Array.isArray(o[key]) && (o[key] as unknown[]).every((x) => typeof x === 'string') ? (o[key] as string[]) : undefined;
