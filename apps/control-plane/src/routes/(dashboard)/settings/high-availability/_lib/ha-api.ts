import { browser } from '$app/env';
import type {
	HaDrillCatalogueView,
	HaDrillRunRequest,
	HaDrillRunView,
	HaInitAnswers,
	HaInitApplyView,
	HaInitPlanView,
	HaInitRequest,
	HaPreflightReport,
	HaProfile,
	RegionsView
} from '@yoal/contracts';
import { HttpError, fetchJson } from '#lib/query.js';
import type { AttachmentMigrationResponse, CaStatusResponse } from './ha-types.js';

/**
 * Every request Settings → High availability makes for the guided setup, the drills and the admin
 * actions. Nothing else on the page calls these routes. Calls use the dashboard session cookie; a
 * platform admin's session passes the admin checks that refuse API keys.
 *
 * Routes (`apps/control-plane/src/routes/api/v1/ha/…`) and what each returns:
 * - `GET /preflight?profile=&steering=&certificates=`: `HaPreflightReport` (no `profile`: the
 *   install's own).
 * - `POST /init` `{ profile, answers, apply: false }`: `HaInitPlanView`; with `apply: true`,
 *   `HaInitApplyView`, or 409 with every blocker (platform admin only).
 * - `GET /drills/catalogue`: `HaDrillCatalogueView`.
 * - `POST /drills/run` `HaDrillRunRequest`: 201 `HaDrillRunView`; 409 for a lab-only scenario, a
 *   missing flag, the control-plane node without `includeControlNode` or a resource below its HA
 *   level; 422 without the typed confirmation; 403 for a destructive scenario without a platform
 *   admin; 404 for an unknown resource.
 * - `GET /drills/runs?limit=`: `{ runs: HaDrillRunView[] }`, newest first.
 * - `GET /ca`, `POST /ca/rotate` (platform admin; 409 while a node is on the previous CA).
 * - `GET /attachments/migrate` (dry run), `POST /attachments/migrate` `{ apply: true, projects }`
 *   (platform admin). The server reads an absent or empty `projects` as every app, so apply always
 *   sends the slugs of the dry run the admin confirmed, and never an empty list.
 * - `GET /regions`: `RegionsView`. Wave 5 lane A owns it; until that route exists it answers 404,
 *   which reads as "not available yet". Every other route here is on main, so a 404 from it is a
 *   real "not found" (an unknown node, say) and shows the server's message.
 *
 * **Development preview.** In `vite dev`, adding `?ha-fixtures` (or `?ha-fixtures=ready`, `=flags`)
 * to the page URL answers every call from `ha-fixtures.ts`, so each step can be seen without a
 * fleet. Every fixture path sits behind `import.meta.env.DEV`, which a production build replaces
 * with `false`: the branch and the dynamic import are dropped, so the fixtures are not in the
 * bundle and can never render.
 */

export const haKeys = {
	preflight: ['ha-setup', 'preflight'] as const,
	plan: (profile: HaProfile, answers: HaInitAnswers) =>
		['ha-setup', 'plan', profile, answers] as const,
	catalogue: ['ha-setup', 'drill-catalogue'] as const,
	drillRuns: ['ha-setup', 'drill-runs'] as const,
	regions: ['ha-setup', 'regions'] as const,
	ca: ['ha-setup', 'ca'] as const,
	migration: ['ha-setup', 'migration'] as const
};

/** The route is not on this control plane yet (lane A's regions), or the service behind it is not built (501). */
export class NotAvailableError extends HttpError {
	constructor(status: number, message: string) {
		super(status, message);
		this.name = 'NotAvailableError';
	}
}

interface CallInit extends RequestInit {
	fallback: string;
	/** A 404 means the route itself is missing (not built yet), not a missing resource. */
	routeMayBeMissing?: boolean;
}

async function call<T>(url: string, init: CallInit): Promise<T> {
	const { routeMayBeMissing = false, ...rest } = init;
	try {
		return await fetchJson<T>(url, {
			cache: 'no-store',
			...rest,
			headers: rest.body ? { 'content-type': 'application/json' } : undefined
		});
	} catch (error) {
		if (
			error instanceof HttpError &&
			(error.status === 501 || (routeMayBeMissing && error.status === 404))
		)
			throw new NotAvailableError(
				error.status,
				`Not available on this control plane yet (${error.status}).`
			);
		throw error;
	}
}

const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) });

/** The `?ha-fixtures` preview mode, in development only; always null in a production build. */
function fixtureMode(): string | null {
	if (!import.meta.env.DEV || !browser) return null;
	const value = new URLSearchParams(window.location.search).get('ha-fixtures');
	return value === null ? null : value || 'failing';
}

async function fixtures() {
	if (!import.meta.env.DEV) throw new Error('Fixtures exist only in development.');
	return import('./ha-fixtures.js');
}

// ------------------------------------------------------------------ preflight and ha init

/** `GET /api/v1/ha/preflight`: every check, against `profile` or the install's own profile. */
export async function loadPreflight(
	profile?: HaProfile,
	signal?: AbortSignal
): Promise<HaPreflightReport> {
	if (import.meta.env.DEV && fixtureMode()) {
		const f = await fixtures();
		return f.planView(profile ?? 'ha', { checks: f.failingChecks(profile ?? 'ha') }).preflight;
	}
	const query = profile ? `?profile=${encodeURIComponent(profile)}` : '';
	return call<HaPreflightReport>(`/api/v1/ha/preflight${query}`, {
		signal,
		fallback: 'Could not run the preflight'
	});
}

/** The `POST /api/v1/ha/init` body: the request schema's shape, `answers` only as changed. */
export function initRequest(
	profile: HaProfile,
	answers: HaInitAnswers,
	apply: boolean
): Required<HaInitRequest> {
	return { profile, answers, apply };
}

export async function planInit(
	profile: HaProfile,
	answers: HaInitAnswers,
	signal?: AbortSignal
): Promise<HaInitPlanView> {
	if (import.meta.env.DEV) {
		const mode = fixtureMode();
		if (mode) {
			const f = await fixtures();
			return f.planView(profile, {
				answers,
				checks:
					profile === 'single' || mode === 'ready' || mode === 'flags'
						? undefined
						: f.failingChecks(profile),
				flagsSet: mode !== 'flags'
			});
		}
	}
	return call<HaInitPlanView>('/api/v1/ha/init', {
		...post(initRequest(profile, answers, false)),
		signal,
		fallback: 'Could not plan the profile'
	});
}

export async function applyInit(
	profile: HaProfile,
	answers: HaInitAnswers
): Promise<HaInitApplyView> {
	if (import.meta.env.DEV && fixtureMode()) {
		const view = (await fixtures()).planView(profile, { answers });
		return { profile, applied: view.settingsToChange, auditId: 'aud_fixture' };
	}
	return call<HaInitApplyView>('/api/v1/ha/init', {
		...post(initRequest(profile, answers, true)),
		fallback: 'Could not apply the profile'
	});
}

// ------------------------------------------------------------------ drills

export async function loadDrillCatalogue(signal?: AbortSignal): Promise<HaDrillCatalogueView> {
	return call<HaDrillCatalogueView>('/api/v1/ha/drills/catalogue', {
		signal,
		fallback: 'Could not load the drill catalogue'
	});
}

export async function listDrillRuns(signal?: AbortSignal): Promise<HaDrillRunView[]> {
	if (import.meta.env.DEV && fixtureMode()) return (await fixtures()).drillRuns;
	return call<{ runs: HaDrillRunView[] }>('/api/v1/ha/drills/runs?limit=20', {
		signal,
		fallback: 'Could not load drill results'
	}).then((data) => data.runs);
}

export async function runDrill(request: HaDrillRunRequest): Promise<HaDrillRunView> {
	if (import.meta.env.DEV && fixtureMode()) {
		const run = (await fixtures()).drillRuns[0]!;
		return {
			...run,
			id: `hdr_${Date.now()}`,
			scenario: request.scenario,
			resource: { ...run.resource, name: request.resource },
			status: 'running',
			finishedAt: null
		};
	}
	return call<HaDrillRunView>('/api/v1/ha/drills/run', {
		...post(request),
		fallback: 'Could not start the drill'
	});
}

// ------------------------------------------------------------------ regions

export async function loadRegions(signal?: AbortSignal): Promise<RegionsView> {
	if (import.meta.env.DEV && fixtureMode()) return (await fixtures()).regions;
	return call<RegionsView>('/api/v1/ha/regions', {
		signal,
		fallback: 'Could not load regions',
		routeMayBeMissing: true
	});
}

// ------------------------------------------------------------------ admin actions

export async function loadCa(signal?: AbortSignal): Promise<CaStatusResponse> {
	if (import.meta.env.DEV && fixtureMode()) return (await fixtures()).caStatus;
	return call<CaStatusResponse>('/api/v1/ha/ca', { signal, fallback: 'Could not load the CA' });
}

export async function rotateCa(): Promise<CaStatusResponse> {
	if (import.meta.env.DEV && fixtureMode())
		throw new HttpError(409, 'Preview only: nothing was rotated.');
	return call<CaStatusResponse>('/api/v1/ha/ca/rotate', {
		method: 'POST',
		fallback: 'Could not rotate the CA'
	});
}

export async function loadMigrationPlan(
	signal?: AbortSignal
): Promise<AttachmentMigrationResponse> {
	if (import.meta.env.DEV && fixtureMode()) return (await fixtures()).migrationPlan;
	return call<AttachmentMigrationResponse>('/api/v1/ha/attachments/migrate', {
		signal,
		fallback: 'Could not load the dry run'
	});
}

/**
 * Move the apps the confirmed dry run listed as `will-move`, and only those: `projects` is the
 * slugs from that plan. Refuses an empty list, which the server would read as every app.
 */
export async function applyMigration(projects: readonly string[]): Promise<AttachmentMigrationResponse> {
	if (projects.length === 0) throw new Error('No app to move: run the dry run again.');
	if (import.meta.env.DEV && fixtureMode()) {
		const plan = (await fixtures()).migrationPlan;
		return {
			...plan,
			apply: true,
			projects: plan.projects.map((item) =>
				projects.includes(item.slug) && item.status === 'will-move'
					? { ...item, status: 'moved' as const, reason: 'Moved (preview only).' }
					: item
			)
		};
	}
	return call<AttachmentMigrationResponse>('/api/v1/ha/attachments/migrate', {
		...post({ apply: true, projects: [...projects] }),
		fallback: 'Could not move the apps'
	});
}
