<script lang="ts">
	/**
	 * Acting on what the Explorer shows (docs/LOGS.md §9): "Create alert" opens the rule editor
	 * prefilled with the current filter, scopes and window (a `log_count` rule, §9.1); on the
	 * Analytics tab "Add to dashboard" turns the `| stats` query into a `logs` dataset panel, or
	 * adds a Logs panel with the newest matching lines (§9.2).
	 */
	import {
		logAlertQuery,
		logsBuilderFromQuery,
		panelDraftSchema,
		panelsFromDrafts,
		type DashboardSummary,
		type LogScopeRef,
		type PanelDraft
	} from '@yoal/contracts';
	import { createQuery, useQueryClient } from '@tanstack/svelte-query';
	import { browser } from '$app/env';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import BellPlusIcon from '@lucide/svelte/icons/bell-plus';
	import LayoutDashboardIcon from '@lucide/svelte/icons/layout-dashboard';
	import { toast } from 'svelte-sonner';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { errorText } from '#lib/query.js';
	import { logRuleSearch } from '../../routes/(dashboard)/alerts/_lib/rules.js';
	import {
		createDashboard,
		getDashboard,
		keys as dashboardKeys,
		listDashboards,
		updateDashboard
	} from '../../routes/(dashboard)/dashboards/_lib/api.js';

	let {
		filter,
		scopes,
		span,
		analytics = false,
		tableQuery = ''
	}: {
		/** The stream filter (no pipes), with any page preset already ANDed in. */
		filter: string;
		scopes: LogScopeRef[];
		/** The window's length, ms (the rule's window, capped at an hour). */
		span: number;
		/** The Analytics tab is showing: offer "Add to dashboard". */
		analytics?: boolean;
		/** The Analytics tab's `| stats` query. */
		tableQuery?: string;
	} = $props();

	const queryClient = useQueryClient();

	/** Alert rules page people; only org owners and admins write them (mirrors dashboard panels). */
	const canAlert = $derived(
		page.data.role === 'owner' || page.data.role === 'admin' || page.data.can?.manageNodes === true
	);
	const alertHref = $derived(
		`${resolve('/(dashboard)/alerts/rules/new')}?${logRuleSearch({
			q: filter,
			scopes,
			windowSeconds: Math.min(3_600, Math.max(60, Math.round(span / 1000)))
		})}`
	);

	// --- add to dashboard ----------------------------------------------------------------------

	let open = $state(false);
	let saving = $state(false);
	let failure = $state<string | null>(null);
	let kind = $state<'chart' | 'logs'>('chart');
	let target = $state<string>('new');
	let title = $state('');
	let dashboardTitle = $state('Logs');

	const chart = $derived(logsBuilderFromQuery(tableQuery, scopes));
	const dashboards = createQuery(() => ({
		queryKey: dashboardKeys.dashboards,
		queryFn: ({ signal }) => listDashboards(signal),
		enabled: browser && open,
		staleTime: 30_000
	}));
	const editable = $derived(
		(dashboards.data ?? []).filter((dashboard: DashboardSummary) => dashboard.canEdit)
	);

	function start() {
		failure = null;
		kind = chart.ok ? 'chart' : 'logs';
		title = filter.trim() ? filter.trim().slice(0, 80) : 'Logs';
		open = true;
	}

	function draft(): PanelDraft {
		if (kind === 'chart' && chart.ok)
			return {
				title: title.trim() || 'Log lines',
				viz: chart.viz,
				query: { mode: 'builder', builder: chart.builder }
			};
		return {
			title: title.trim() || 'Logs',
			viz: 'logs',
			size: 'full',
			query: logAlertQuery({ q: filter, scopes })
		};
	}

	async function add(event: SubmitEvent) {
		event.preventDefault();
		saving = true;
		failure = null;
		try {
			const parsed = panelDraftSchema.parse(draft());
			const newId = () => `p_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
			let id: string;
			if (target === 'new') {
				const panels = panelsFromDrafts([], [parsed], newId);
				const created = await createDashboard({
					title: dashboardTitle.trim() || 'Logs',
					spec: { panels }
				});
				id = created.id;
			} else {
				const current = await getDashboard(target);
				const panels = panelsFromDrafts(current.spec.panels, [parsed], newId);
				await updateDashboard(current.id, {
					version: current.version,
					spec: { ...current.spec, panels: [...current.spec.panels, ...panels] }
				});
				id = current.id;
			}
			void queryClient.invalidateQueries({ queryKey: dashboardKeys.dashboards });
			void queryClient.invalidateQueries({ queryKey: dashboardKeys.dashboard(id) });
			open = false;
			const href = resolve('/(dashboard)/dashboards/[id]', { id });
			toast.success('Added to the dashboard', {
				action: { label: 'Open', onClick: () => void goto(href) }
			});
		} catch (error) {
			failure = errorText(error, 'Could not add the panel.');
		} finally {
			saving = false;
		}
	}
</script>

{#if canAlert}
	<Button
		variant="outline"
		size="icon-sm"
		href={alertHref}
		aria-label="Create an alert from this query"
		title="Create alert: page when this query's line count crosses a threshold"
	>
		<BellPlusIcon />
	</Button>
{/if}
{#if analytics}
	<Button
		variant="outline"
		size="icon-sm"
		aria-label="Add to dashboard"
		title="Add this analysis (or the matching lines) to a dashboard"
		onclick={start}
	>
		<LayoutDashboardIcon />
	</Button>
	<Dialog.Root bind:open>
		<Dialog.Content class="sm:max-w-md">
			<Dialog.Header>
				<Dialog.Title>Add to dashboard</Dialog.Title>
				<Dialog.Description>
					The panel runs this query with each viewer's own log access, over the dashboard's time
					range.
				</Dialog.Description>
			</Dialog.Header>
			<form class="grid gap-4" onsubmit={add}>
				<fieldset class="grid gap-2">
					<legend class="mb-1 text-sm font-medium">Panel</legend>
					<label class="flex items-start gap-2 text-sm">
						<input
							type="radio"
							name="log-panel-kind"
							value="chart"
							bind:group={kind}
							disabled={!chart.ok}
							class="mt-1"
						/>
						<span>
							Chart of this analysis
							<span class="block text-xs text-muted-foreground"
								>{chart.ok ? tableQuery : chart.error}</span
							>
						</span>
					</label>
					<label class="flex items-start gap-2 text-sm">
						<input type="radio" name="log-panel-kind" value="logs" bind:group={kind} class="mt-1" />
						<span>
							Logs panel
							<span class="block text-xs text-muted-foreground"
								>The newest lines matching {filter.trim()
									? filter.trim()
									: 'everything in scope'}</span
							>
						</span>
					</label>
				</fieldset>
				<label class="grid gap-1 text-sm">
					<span class="font-medium">Panel title</span>
					<Input bind:value={title} maxlength={200} />
				</label>
				<label class="grid gap-1 text-sm">
					<span class="font-medium">Dashboard</span>
					<NativeSelect.Root bind:value={target} aria-label="Dashboard">
						<NativeSelect.Option value="new">New dashboard…</NativeSelect.Option>
						{#each editable as dashboard (dashboard.id)}
							<NativeSelect.Option value={dashboard.id}>{dashboard.title}</NativeSelect.Option>
						{/each}
					</NativeSelect.Root>
					{#if dashboards.isFetching}<span class="text-xs text-muted-foreground"
							>Loading dashboards…</span
						>{/if}
				</label>
				{#if target === 'new'}
					<label class="grid gap-1 text-sm">
						<span class="font-medium">New dashboard title</span>
						<Input bind:value={dashboardTitle} maxlength={120} required />
					</label>
				{/if}
				{#if failure}<p class="text-sm text-destructive" role="alert">{failure}</p>{/if}
				<Dialog.Footer>
					<Button variant="outline" type="button" onclick={() => (open = false)}>Cancel</Button>
					<Button type="submit" disabled={saving}>
						{#if saving}<Spinner />{/if}Add panel
					</Button>
				</Dialog.Footer>
			</form>
		</Dialog.Content>
	</Dialog.Root>
{/if}
