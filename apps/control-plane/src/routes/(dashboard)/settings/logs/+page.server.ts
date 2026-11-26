import { error, fail } from '@sveltejs/kit';
import {
	hasPermission,
	LOG_SETTINGS_PLATFORM_ID,
	logRuleKinds,
	type LogRuleKind,
	type LogSettingKey,
	type LogSettingsLevel,
	type LogSettingsPatch,
	type LogUsageReport
} from '@yoal/contracts';
import { resolveLogSettings } from '@yoal/core';
import { core } from '#lib/server/core.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * Settings → Logs (docs/LOGS.md §10): retention, archive, ingest quotas and edge sampling for the
 * org (and per project), the platform defaults for platform admins, ingest/index/redaction rules
 * with a preview, and log volume per project. Every check lives in core (`logSettings`,
 * `logRules`, `logQuotas`).
 */
export const load: PageServerLoad = ({ locals }) => {
	const principal = locals.principal!;
	if (!hasPermission(principal, 'logs:read') && !hasPermission(principal, 'logs:configure'))
		error(403, 'You need permission to read logs to see log settings.');
	const org = core.logSettings.view(principal, { level: 'org' });
	const canPlatform = core.ctx.platformIam.canAdminister(principal);
	const projects = core.projects
		.list(principal)
		.map((project) => ({ id: project.id, slug: project.slug, name: project.name, orgId: principal.orgId }));
	const overrides = projects
		.map((project) => ({ project, view: core.logSettings.view(principal, { level: 'project', project }) }))
		.filter((entry) => entry.view.project && Object.keys(entry.view.project).length > 0)
		.map((entry) => ({
			slug: entry.project.slug,
			name: entry.project.name,
			row: entry.view.project!,
			effective: entry.view.effective
		}));
	let usage: LogUsageReport | null = null;
	try {
		usage = core.logQuotas.usage(principal, { days: 7 });
	} catch {
		usage = null;
	}
	return {
		org,
		/** What a blank org field inherits (the platform's effective values). */
		orgInherited: core.logSettings.effective(LOG_SETTINGS_PLATFORM_ID),
		platform: canPlatform ? core.logSettings.view(principal, { level: 'platform' }) : null,
		/** What a blank platform field means: the built-in defaults. */
		platformDefaults: resolveLogSettings({
			platform: {},
			org: null,
			project: null,
			searchIndex: org.searchIndex,
			hotDaysFallback: core.ctx.policies.get().logRetentionDays
		}),
		projects: projects.map(({ slug, name }) => ({ slug, name })),
		overrides,
		rules: core.logRules.list(principal),
		usage,
		canConfigure: org.canEdit
	};
};

const NUMBER_KEYS: LogSettingKey[] = [
	'hotDays',
	'searchDays',
	'archiveDays',
	'ingestLinesPerSecond',
	'ingestBurst',
	'ingestMbPerDay'
];

function string(data: FormData, name: string): string {
	return String(data.get(name) ?? '').trim();
}

/** Form → patch. Only fields the form has are sent; a blank field clears the key (inherit). */
function settingsPatch(data: FormData): LogSettingsPatch {
	const patch: Record<string, unknown> = {};
	for (const key of NUMBER_KEYS) {
		if (!data.has(key)) continue;
		const value = string(data, key);
		patch[key] = value === '' ? null : Number(value);
	}
	if (data.has('archiveEnabled')) {
		const value = string(data, 'archiveEnabled');
		patch.archiveEnabled = value === 'on' ? true : value === 'off' ? false : null;
	}
	if (data.has('edgeSamplePercent')) {
		const value = string(data, 'edgeSamplePercent');
		patch.edgeSampleRate = value === '' ? null : Number(value) / 100;
	}
	return patch as LogSettingsPatch;
}

function failure(cause: unknown) {
	const issues = (cause as { issues?: Array<{ message?: string }> }).issues;
	const detail = issues
		?.map((issue) => issue.message)
		.filter(Boolean)
		.join('; ');
	const message = (cause as Error).message;
	return fail(400, { message: detail && !message.includes(detail) ? `${message} ${detail}` : message });
}

function rate(data: FormData): number | null {
	const value = string(data, 'samplePercent');
	return value === '' ? null : Number(value) / 100;
}

export const actions: Actions = {
	saveSettings: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		try {
			const requested = string(data, 'level') as LogSettingsLevel;
			const level: LogSettingsLevel = requested === 'platform' || requested === 'project' ? requested : 'org';
			const project = level === 'project' ? core.projects.requireRow(principal, string(data, 'project')) : null;
			core.logSettings.update(
				principal,
				{ level, project: project ? { id: project.id, orgId: project.orgId } : null },
				settingsPatch(data)
			);
			return {
				success:
					level === 'platform'
						? 'Saved the platform log defaults.'
						: project
							? `Saved log settings for ${project.slug}.`
							: 'Saved the organisation’s log settings.'
			};
		} catch (cause) {
			return failure(cause);
		}
	},

	createRule: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		try {
			const kind = string(data, 'kind') as LogRuleKind;
			if (!(logRuleKinds as readonly string[]).includes(kind)) throw new Error('Pick a rule kind.');
			const rule = core.logRules.create(principal, {
				name: string(data, 'name'),
				kind,
				query: string(data, 'query'),
				pattern: string(data, 'pattern') || null,
				sampleRate: rate(data),
				project: string(data, 'project') || null
			});
			return { success: `Added the rule ${rule.name}. It applies to lines logged from now on.` };
		} catch (cause) {
			return failure(cause);
		}
	},

	previewRule: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		try {
			const preview = core.logRules.preview(principal, {
				kind: string(data, 'kind') as LogRuleKind,
				query: string(data, 'query'),
				pattern: string(data, 'pattern') || null,
				sampleRate: rate(data),
				project: string(data, 'project') || null
			});
			return { preview };
		} catch (cause) {
			return failure(cause);
		}
	},

	toggleRule: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		try {
			const rule = core.logRules.update(principal, string(data, 'id'), { enabled: string(data, 'enabled') === 'true' });
			return { success: rule.enabled ? `${rule.name} is on.` : `${rule.name} is paused.` };
		} catch (cause) {
			return failure(cause);
		}
	},

	deleteRule: async ({ request, locals }) => {
		const principal = locals.principal!;
		try {
			core.logRules.delete(principal, string(await request.formData(), 'id'));
			return { success: 'Rule deleted.' };
		} catch (cause) {
			return failure(cause);
		}
	}
};
