import { browser, dev } from '$app/env';
import type {
	HaDrillRunRequest,
	HaDrillRunView,
	HaInitAnswers,
	HaInitApplyView,
	HaInitPlanView,
	HaProfile,
	RegionsView
} from '@yoal/contracts';
import { HttpError, fetchJson } from '#lib/query.js';
import type { AttachmentMigrationResponse, CaStatusResponse } from './ha-types.js';

/**
 * Every request Settings → High availability makes for the guided setup, the drills and the admin
 * actions. Nothing else on the page calls these routes, so wiring a route that moves (or arrives)
 * is a change to this file only. Calls use the dashboard session cookie; a platform admin's session
 * passes the admin checks that refuse API keys.
 *
 * Routes and their owners:
 * - `POST /api/v1/ha/init`: the plan (`apply: false`) and apply. `HaInitPlanView`, `HaInitApplyView`.
 * - `POST /api/v1/ha/drills/run`: run one catalogue scenario. `HaDrillRunView`.
 * - `GET /api/v1/ha/drills/runs`: recent catalogue runs, `{ runs: HaDrillRunView[] }`. The path is
 *   this page's assumption; the contract names no list route.
 * - `GET /api/v1/ha/regions`: `RegionsView`.
 * - `GET /api/v1/ha/ca`, `POST /api/v1/ha/ca/rotate`: the install CA.
 * - `GET`/`POST /api/v1/ha/attachments/migrate`: the attachment move, dry run and apply.
 *
 * A 404 or 501 from a route becomes `NotAvailableError`, which the page shows as "not available on
 * this control plane yet" rather than as a failure.
 *
 * **Development preview.** In `vite dev`, adding `?ha-fixtures` (or `?ha-fixtures=ready`,
 * `=flags`) to the page URL answers every call here from `ha-fixtures.ts`, so each step can be seen
 * without a fleet. A production build never takes that branch and never loads the fixtures.
 */

export const haKeys = {
	plan: (profile: HaProfile, answers: HaInitAnswers) =>
		['ha-setup', 'plan', profile, answers] as const,
	drillRuns: ['ha-setup', 'drill-runs'] as const,
	regions: ['ha-setup', 'regions'] as const,
	ca: ['ha-setup', 'ca'] as const,
	migration: ['ha-setup', 'migration'] as const
};

/** The route is not on this control plane (yet), or the service behind it is not built. */
export class NotAvailableError extends HttpError {
	constructor(status: number, message: string) {
		super(status, message);
		this.name = 'NotAvailableError';
	}
}

async function call<T>(
	url: string,
	init: RequestInit & { fallback: string; body?: string } = { fallback: 'The request failed' }
): Promise<T> {
	try {
		return await fetchJson<T>(url, {
			cache: 'no-store',
			...init,
			headers: init.body ? { 'content-type': 'application/json' } : undefined
		});
	} catch (error) {
		if (error instanceof HttpError && (error.status === 404 || error.status === 501))
			throw new NotAvailableError(
				error.status,
				`Not available on this control plane yet (${error.status}).`
			);
		throw error;
	}
}

const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) });

function fixtureMode(): string | null {
	if (!dev || !browser) return null;
	const value = new URLSearchParams(window.location.search).get('ha-fixtures');
	return value === null ? null : value || 'failing';
}

async function fixtures() {
	return import('./ha-fixtures.js');
}

// ------------------------------------------------------------------ ha init

export async function planInit(
	profile: HaProfile,
	answers: HaInitAnswers,
	signal?: AbortSignal
): Promise<HaInitPlanView> {
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
	return call<HaInitPlanView>('/api/v1/ha/init', {
		...post({ profile, answers, apply: false }),
		signal,
		fallback: 'Could not plan the profile'
	});
}

export async function applyInit(
	profile: HaProfile,
	answers: HaInitAnswers
): Promise<HaInitApplyView> {
	const mode = fixtureMode();
	if (mode) {
		const f = await fixtures();
		const view = f.planView(profile, { answers });
		return { profile, applied: view.settingsToChange, auditId: 'aud_fixture' };
	}
	return call<HaInitApplyView>('/api/v1/ha/init', {
		...post({ profile, answers, apply: true }),
		fallback: 'Could not apply the profile'
	});
}

// ------------------------------------------------------------------ drills

export async function listDrillRuns(signal?: AbortSignal): Promise<HaDrillRunView[]> {
	if (fixtureMode()) return (await fixtures()).drillRuns;
	return call<{ runs: HaDrillRunView[] }>('/api/v1/ha/drills/runs?limit=20', {
		signal,
		fallback: 'Could not load drill results'
	}).then((data) => data.runs);
}

export async function runDrill(request: HaDrillRunRequest): Promise<HaDrillRunView> {
	if (fixtureMode()) {
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
	if (fixtureMode()) return (await fixtures()).regions;
	return call<RegionsView>('/api/v1/ha/regions', { signal, fallback: 'Could not load regions' });
}

// ------------------------------------------------------------------ admin actions

export async function loadCa(signal?: AbortSignal): Promise<CaStatusResponse> {
	if (fixtureMode()) return (await fixtures()).caStatus;
	return call<CaStatusResponse>('/api/v1/ha/ca', { signal, fallback: 'Could not load the CA' });
}

export async function rotateCa(): Promise<CaStatusResponse> {
	if (fixtureMode()) throw new HttpError(409, 'Preview only: nothing was rotated.');
	return call<CaStatusResponse>('/api/v1/ha/ca/rotate', {
		method: 'POST',
		fallback: 'Could not rotate the CA'
	});
}

export async function loadMigrationPlan(
	signal?: AbortSignal
): Promise<AttachmentMigrationResponse> {
	if (fixtureMode()) return (await fixtures()).migrationPlan;
	return call<AttachmentMigrationResponse>('/api/v1/ha/attachments/migrate', {
		signal,
		fallback: 'Could not load the dry run'
	});
}

export async function applyMigration(): Promise<AttachmentMigrationResponse> {
	if (fixtureMode()) {
		const plan = (await fixtures()).migrationPlan;
		return {
			...plan,
			apply: true,
			projects: plan.projects.map((item) =>
				item.status === 'will-move'
					? { ...item, status: 'moved' as const, reason: 'Moved (preview only).' }
					: item
			)
		};
	}
	return call<AttachmentMigrationResponse>('/api/v1/ha/attachments/migrate', {
		...post({ apply: true }),
		fallback: 'Could not move the apps'
	});
}
