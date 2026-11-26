<script lang="ts">
	/**
	 * The Logs Explorer (docs/LOGS.md §7, LP11): one component for every log on the platform. At
	 * `/logs` the scope is open; on a resource page it is locked to that resource, with a preset
	 * filter ANDed in (`baseQuery`) so the page keeps showing what it always showed.
	 *
	 * Data: the stream is a buffer this component owns (pages by cursor in both directions, plus
	 * the live tail over SSE); the histogram, facets, capabilities, context and tables are
	 * TanStack queries. All state that makes an investigation shareable lives in the URL
	 * (`url-state.ts`). Every API path is in `api.ts`.
	 */
	import { tick, untrack, type Snippet } from 'svelte';
	import { browser } from '$app/env';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { createQuery, keepPreviousData } from '@tanstack/svelte-query';
	import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import Columns3Icon from '@lucide/svelte/icons/columns-3';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import KeyboardIcon from '@lucide/svelte/icons/keyboard';
	import PanelLeftIcon from '@lucide/svelte/icons/panel-left';
	import PlayIcon from '@lucide/svelte/icons/play';
	import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
	import SearchIcon from '@lucide/svelte/icons/search';
	import Share2Icon from '@lucide/svelte/icons/share-2';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import WrapTextIcon from '@lucide/svelte/icons/wrap-text';
	import { toast } from 'svelte-sonner';
	import {
		parseLogQuery,
		type LogEngine,
		type LogRecord,
		type LogSavedQuery,
		type LogScopeRef,
		type LogWarning
	} from '@yoal/contracts';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { Toggle } from '#lib/components/ui/toggle/index.js';
	import * as ToggleGroup from '#lib/components/ui/toggle-group/index.js';
	import { errorText } from '#lib/query.js';
	import {
		contextLogs,
		fieldsLogs,
		getCapabilities,
		histogramLogs,
		logKeys,
		searchLogs,
		tableLogs
	} from './api.js';
	import {
		collectForExport,
		downloadText,
		exportBody,
		exportFilename,
		exportMime,
		type ExportFormat
	} from './export.js';
	import FacetSidebar from './FacetSidebar.svelte';
	import Histogram from './Histogram.svelte';
	import { SEVERITY_SERIES, histogramBuckets } from './histogram.js';
	import { isTypingTarget, logShortcutFor } from './keyboard.js';
	import LiteBanner from './LiteBanner.svelte';
	import LogActions from './LogActions.svelte';
	import LogStream, {
		STREAM_COLUMNS,
		type StreamColumn,
		type StreamOrder
	} from './LogStream.svelte';
	import QueryEditor from './QueryEditor.svelte';
	import {
		combineQuery,
		hasPipes,
		searchTerms,
		splitPipes,
		toggleFilterClause,
		withPipes
	} from './query-text.js';
	import { primaryField } from './record.js';
	import RecordFlyout, { type FlyoutTab } from './RecordFlyout.svelte';
	import SavedQueries from './SavedQueries.svelte';
	import ScopeBar from './ScopeBar.svelte';
	import ShortcutsHelp from './ShortcutsHelp.svelte';
	import TableView from './TableView.svelte';
	import { LogTail } from './tail.svelte.js';
	import TimePicker from './TimePicker.svelte';
	import {
		DEFAULT_LOG_TIME,
		aroundLogTime,
		binFor,
		reachesNow,
		resolveLogTime,
		shiftLogTime,
		zoomLogTime,
		type LogTime,
		type LogTimeZone
	} from './time.js';
	import {
		decodeExplorerState,
		encodeExplorerState,
		type ExplorerMode,
		type ExplorerUrlState
	} from './url-state.js';

	let {
		scopes = [],
		locked = false,
		lockedLabel,
		baseQuery = '',
		baseLabel,
		initialQuery = '',
		defaultTime = DEFAULT_LOG_TIME,
		defaultLive = false,
		urlPrefix = null,
		order = 'newest-first',
		loadAll = false,
		settled = null,
		facets = true,
		histogram = true,
		modes = true,
		keyboard = 'focus',
		heightClass,
		defaultColumns = ['time', 'level', 'service', 'replica'],
		filename = 'logs',
		emptyHint = 'Nothing was logged in this window. Widen the time range or loosen the query.',
		canRead = true,
		toolbar,
		streamView,
		streamViewLabel = 'Grouped'
	}: {
		/** The initial scopes on `/logs`; the fixed scopes when `locked`. */
		scopes?: LogScopeRef[];
		locked?: boolean;
		lockedLabel?: string;
		/** A preset filter always ANDed in (shown as a chip, not editable). */
		baseQuery?: string;
		/** Human words for `baseQuery` ("Runtime and system lines"). */
		baseLabel?: string;
		initialQuery?: string;
		defaultTime?: LogTime;
		/** Start with the live tail on. */
		defaultLive?: boolean;
		/** Sync state into the URL with this key prefix (`''` on `/logs`); null = no URL state. */
		urlPrefix?: string | null;
		/** Where the newest line sits: the top (Explorer) or the bottom (a terminal-style tail). */
		order?: StreamOrder;
		/** Read the whole window from its start (a build, a pipeline job) instead of the newest page. */
		loadAll?: boolean;
		/** The thing being logged has finished (a build, a job): stop tailing after a last read. */
		settled?: { done: boolean; label?: string } | null;
		/** Show the facet sidebar to start with. */
		facets?: boolean;
		histogram?: boolean;
		/** Show the Stream / Patterns / Analytics / Compare tabs. */
		modes?: boolean;
		/** `global`: shortcuts work anywhere on the page (`/logs`); `focus`: only inside the explorer. */
		keyboard?: 'global' | 'focus';
		heightClass?: string;
		defaultColumns?: StreamColumn[];
		/** Download file name stem. */
		filename?: string;
		emptyHint?: string;
		canRead?: boolean;
		/** Extra controls at the start of the header (a page's own source switch). */
		toolbar?: Snippet;
		/** A replacement renderer for the stream (pipeline step groups), toggled with "Lines". */
		streamView?: Snippet<[{ records: LogRecord[]; live: boolean; done: boolean }]>;
		streamViewLabel?: string;
	} = $props();

	const PAGE = 200;
	const LOAD_ALL_PAGE = 1_000;
	const MAX_BUFFER = 20_000;
	const MAX_PENDING = 5_000;

	// --- state, seeded from the URL ------------------------------------------------------------

	const urlDefaults = untrack((): Partial<ExplorerUrlState> => ({
		q: initialQuery,
		time: defaultTime,
		live: defaultLive,
		scopes: locked ? [] : scopes
	}));
	const seeded = untrack(() => {
		const url = page.shallow?.url ?? page.url;
		return decodeExplorerState(urlPrefix === null ? new URLSearchParams() : url.searchParams, {
			prefix: urlPrefix ?? '',
			defaults: urlDefaults
		});
	});

	let qText = $state(seeded.q);
	let q = $state(seeded.q);
	let scopeSel = $state<LogScopeRef[]>(seeded.scopes);
	let time = $state<LogTime>(seeded.time);
	let mode = $state<ExplorerMode>(seeded.mode);
	let rowId = $state<string | null>(seeded.row);
	let tz = $state<LogTimeZone>(seeded.tz);
	let live = $state(seeded.live);
	let runAt = $state(Date.now());
	let tickAt = $state(Date.now());
	let facetsOpen = $state(untrack(() => facets));
	let wrap = $state(true);
	let columns = $state<StreamColumn[]>(untrack(() => [...defaultColumns]));
	let customView = $state(true);
	let flyoutTab = $state<FlyoutTab>('fields');
	let timeOpen = $state(false);
	let savedOpen = $state(false);
	let helpOpen = $state(false);
	let focusedIndex = $state(-1);
	let hoverValue = $state<{ field: string; value: string } | null>(null);
	let userPaused = $state(false);
	let atEdge = $state(true);
	let exporting = $state(false);

	let root = $state<HTMLDivElement | null>(null);
	let editor = $state<QueryEditor | null>(null);
	let stream = $state<LogStream | null>(null);
	let saved = $state<SavedQueries | null>(null);

	const effectiveScopes = $derived<LogScopeRef[]>(locked ? scopes : scopeSel);
	const parsed = $derived(parseLogQuery(qText));
	const userFilter = $derived(splitPipes(q).filter);
	const streamQuery = $derived(combineQuery(baseQuery, userFilter));
	const bounds = $derived(resolveLogTime(time, runAt));
	const liveBounds = $derived(resolveLogTime(time, Math.max(runAt, tickAt)));
	const span = $derived(bounds.to - bounds.from);
	const terms = $derived(searchTerms(q));
	const canLive = $derived(reachesNow(time));

	// --- capabilities -------------------------------------------------------------------------

	const capabilities = createQuery(() => ({
		queryKey: logKeys.capabilities,
		queryFn: ({ signal }) => getCapabilities(signal),
		enabled: browser && canRead,
		staleTime: 60_000,
		retry: false
	}));
	const caps = $derived(capabilities.data);
	const lite = $derived(caps?.engine === 'sqlite');
	const features = $derived(caps?.features);
	const LITE_REASON =
		'This needs the telemetry store (ClickHouse). Lite mode searches the SQLite hot tail only.';

	// --- histogram and facets -----------------------------------------------------------------

	const histogramInput = $derived({
		q: streamQuery,
		scopes: effectiveScopes,
		from: liveBounds.from,
		to: liveBounds.to,
		buckets: 60
	});
	const histogramQuery = createQuery(() => ({
		queryKey: logKeys.histogram(histogramInput),
		queryFn: ({ signal }) => histogramLogs(histogramInput, signal),
		enabled: browser && canRead && histogram && mode === 'stream',
		placeholderData: keepPreviousData,
		staleTime: 15_000,
		retry: false
	}));

	const fieldsInput = $derived({
		q: streamQuery,
		scopes: effectiveScopes,
		from: bounds.from,
		to: bounds.to,
		topValues: 8
	});
	const fieldsQuery = createQuery(() => ({
		queryKey: logKeys.fields(fieldsInput),
		queryFn: ({ signal }) => fieldsLogs(fieldsInput, signal),
		enabled: browser && canRead && facetsOpen,
		placeholderData: keepPreviousData,
		staleTime: 30_000,
		retry: false
	}));
	const catalog = $derived(
		Object.fromEntries(
			(fieldsQuery.data?.fields ?? []).map((field) => [
				field.name,
				field.topValues.map((item) => item.value)
			])
		)
	);
	const attributeColumns = $derived(
		(fieldsQuery.data?.fields ?? [])
			.filter((field) => field.kind === 'attribute')
			.slice(0, 12)
			.map((field) => field.name as StreamColumn)
	);

	// While tailing a relative window, slide the histogram forward.
	$effect(() => {
		if (!browser || !live || !canLive) return;
		const timer = setInterval(() => (tickAt = Date.now()), 15_000);
		return () => clearInterval(timer);
	});

	// --- tables (Patterns / Analytics / Compare) ---------------------------------------------

	const userPipesAreStats = $derived(hasPipes(q) && !/\|\s*patterns\b/i.test(q));
	const tableQueryText = $derived.by(() => {
		if (mode === 'patterns' || mode === 'compare') return withPipes(streamQuery, '| patterns');
		if (mode === 'analytics')
			return userPipesAreStats
				? combineQuery(baseQuery, q)
				: withPipes(streamQuery, `| stats count() by bin(${binFor(span)}), level`);
		return '';
	});
	const modeUnavailable = $derived.by(() => {
		if (!caps) return null;
		if (mode === 'patterns' && !features?.patterns) return LITE_REASON;
		if (mode === 'compare' && !features?.compare) return LITE_REASON;
		return null;
	});
	const tableInput = $derived({
		q: tableQueryText,
		scopes: effectiveScopes,
		from: bounds.from,
		to: bounds.to
	});
	const tableQuery = createQuery(() => ({
		queryKey: logKeys.table(tableInput),
		queryFn: ({ signal }) => tableLogs(tableInput, signal),
		enabled: browser && canRead && mode !== 'stream' && !modeUnavailable && tableQueryText !== '',
		placeholderData: keepPreviousData,
		retry: false
	}));
	const previousInput = $derived({
		q: tableQueryText,
		scopes: effectiveScopes,
		from: bounds.from - span,
		to: bounds.from
	});
	const previousQuery = createQuery(() => ({
		queryKey: logKeys.table(previousInput),
		queryFn: ({ signal }) => tableLogs(previousInput, signal),
		enabled: browser && canRead && mode === 'compare' && !modeUnavailable,
		retry: false
	}));

	// --- the stream buffer --------------------------------------------------------------------

	let records = $state.raw<LogRecord[]>([]);
	let pending = $state.raw<LogRecord[]>([]);
	let olderCursor = $state<string | null>(null);
	let newerCursor = $state<string | null>(null);
	let trimmed = $state(false);
	let loading = $state(false);
	let loadingOlder = $state(false);
	let loadingNewer = $state(false);
	let streamError = $state<string | null>(null);
	let warnings = $state<LogWarning[]>([]);
	let engine = $state<LogEngine | null>(null);
	let elapsedMs = $state<number | null>(null);
	let loadedGeneration = $state(0);
	let finished = $state(untrack(() => settled?.done ?? false));
	let scrollToId: string | null = null;
	let ids = new Set<string>();
	let generation = 0;
	let controller: AbortController | null = null;

	function setRecords(next: LogRecord[]) {
		records = next;
		ids = new Set(next.map((record) => record.id));
	}

	const readBase = $derived({
		q: streamQuery,
		scopes: effectiveScopes,
		from: bounds.from,
		to: bounds.to
	});

	async function load() {
		const gen = ++generation;
		controller?.abort();
		controller = new AbortController();
		const signal = controller.signal;
		const input = readBase;
		tail.stop();
		setRecords([]);
		pending = [];
		olderCursor = null;
		newerCursor = null;
		trimmed = false;
		streamError = null;
		warnings = [];
		loading = true;
		focusedIndex = -1;
		try {
			if (loadAll) {
				let cursor: string | undefined;
				let all: LogRecord[] = [];
				for (;;) {
					const page = await searchLogs(
						{ ...input, order: 'asc', limit: LOAD_ALL_PAGE, cursor },
						signal
					);
					if (gen !== generation) return;
					all = all.concat(page.records.filter((record) => !ids.has(record.id)));
					setRecords(all);
					engine = page.engine;
					warnings = page.warnings;
					elapsedMs = page.elapsedMs;
					newerCursor = page.cursor.newer;
					if (!page.cursor.newer || page.records.length < LOAD_ALL_PAGE || all.length >= MAX_BUFFER)
						break;
					cursor = page.cursor.newer;
				}
			} else {
				const page = await searchLogs({ ...input, order: 'desc', limit: PAGE }, signal);
				if (gen !== generation) return;
				setRecords([...page.records].reverse());
				olderCursor = page.cursor.older;
				newerCursor = page.cursor.newer;
				engine = page.engine;
				warnings = page.warnings;
				elapsedMs = page.elapsedMs;
			}
		} catch (error) {
			if (signal.aborted || gen !== generation) return;
			streamError = errorText(error, 'The log search failed.');
		} finally {
			if (gen === generation) {
				loading = false;
				loadedGeneration = gen;
			}
		}
		await tick();
		if (gen !== generation) return;
		if (scrollToId) {
			const index = displayIndexOf(scrollToId);
			scrollToId = null;
			if (index >= 0) {
				focusedIndex = index;
				stream?.scrollToIndex(index);
				return;
			}
		}
		stream?.scrollToEdge();
	}

	function displayIndexOf(id: string): number {
		const index = records.findIndex((record) => record.id === id);
		if (index < 0) return -1;
		return order === 'newest-first' ? records.length - 1 - index : index;
	}
	function recordAt(displayIndex: number): LogRecord | undefined {
		return order === 'newest-first'
			? records[records.length - 1 - displayIndex]
			: records[displayIndex];
	}

	async function loadOlder() {
		if (loadingOlder || (!olderCursor && !trimmed) || records.length === 0) return;
		const gen = generation;
		loadingOlder = true;
		try {
			const oldest = records[0]!;
			const page = await searchLogs(
				trimmed
					? { ...readBase, to: oldest.ts + 1, order: 'desc', limit: PAGE }
					: { ...readBase, order: 'desc', limit: PAGE, cursor: olderCursor ?? undefined }
			);
			if (gen !== generation) return;
			const older = [...page.records].reverse().filter((record) => !ids.has(record.id));
			setRecords([...older, ...records]);
			olderCursor = page.cursor.older;
			trimmed = false;
		} catch (error) {
			toast.error(errorText(error, 'Could not load older lines.'));
		} finally {
			loadingOlder = false;
		}
	}

	async function loadNewer() {
		if (loadingNewer || !newerCursor) return;
		const gen = generation;
		loadingNewer = true;
		try {
			const page = await searchLogs({
				...readBase,
				order: 'asc',
				limit: PAGE,
				cursor: newerCursor
			});
			if (gen !== generation) return;
			append(page.records);
			newerCursor = page.records.length < PAGE ? null : page.cursor.newer;
		} catch (error) {
			toast.error(errorText(error, 'Could not load newer lines.'));
		} finally {
			loadingNewer = false;
		}
	}

	function append(incoming: LogRecord[]) {
		const fresh = incoming.filter((record) => !ids.has(record.id));
		if (fresh.length === 0) return;
		let next = records.concat(fresh);
		if (next.length > MAX_BUFFER) {
			next = next.slice(next.length - MAX_BUFFER);
			trimmed = true;
		}
		setRecords(next);
		if (atEdge && !userPaused) void tick().then(() => stream?.scrollToEdge());
	}

	// Reload whenever what is being read changes (not when live is toggled). Keyed by value, not
	// identity: a parent re-rendering `scopes={[…]}` with the same scope must not reload.
	const readKey = $derived(JSON.stringify(readBase));
	$effect(() => {
		void readKey;
		void loadAll;
		if (!browser || !canRead) return;
		untrack(() => void load());
		return () => controller?.abort();
	});

	// --- live tail ----------------------------------------------------------------------------

	const tail = new LogTail({
		onRecords: (incoming) => {
			if (paused) {
				const fresh = incoming.filter((record) => !ids.has(record.id));
				pending = pending.concat(fresh).slice(-MAX_PENDING);
			} else append(incoming);
		},
		onEnd: () => (finished = true)
	});

	const tailing = $derived(live && canLive && !finished && canRead);
	const paused = $derived(userPaused || !atEdge || rowId !== null);

	// (Re)start after every load, so the tail resumes right after the page that was read. A change
	// of scope or query always reloads first, so they are read untracked here.
	$effect(() => {
		const gen = loadedGeneration;
		const on = tailing;
		if (!browser || gen === 0 || !on) {
			untrack(() => tail.stop());
			return;
		}
		untrack(() => tail.start({ scopes: effectiveScopes, q: streamQuery, cursor: newerCursor }));
		return () => tail.stop();
	});

	// Flush lines that arrived while paused.
	$effect(() => {
		if (paused || pending.length === 0) return;
		untrack(() => {
			const lines = pending;
			pending = [];
			append(lines);
		});
	});

	// A build or job that finished: one last catch-up read, then stop tailing.
	$effect(() => {
		const done = settled?.done ?? false;
		if (!done) {
			untrack(() => (finished = false));
			return;
		}
		if (untrack(() => finished)) return;
		const timer = setTimeout(async () => {
			const cursor = tail.cursor ?? newerCursor;
			if (cursor) {
				try {
					const page = await searchLogs({
						...readBase,
						to: undefined,
						order: 'asc',
						limit: LOAD_ALL_PAGE,
						cursor
					});
					append(page.records);
				} catch {
					// The lines are still readable by reloading; finishing matters more.
				}
			}
			finished = true;
		}, 1_500);
		return () => clearTimeout(timer);
	});

	function toggleLive() {
		if (!live) {
			if (!canLive) time = { kind: 'relative', value: '15m' };
			live = true;
			userPaused = false;
			finished = settled?.done ?? false;
			return;
		}
		live = false;
	}

	function resume() {
		userPaused = false;
		rowId = null;
		atEdge = true;
		void tick().then(() => stream?.scrollToEdge());
	}

	// --- selection ----------------------------------------------------------------------------

	const selected = $derived(rowId ? (records.find((record) => record.id === rowId) ?? null) : null);
	const rowFetch = createQuery(() => ({
		queryKey: logKeys.context(rowId ?? '', 0, 0),
		queryFn: ({ signal }) => contextLogs({ id: rowId!, before: 0, after: 0 }, signal),
		enabled: browser && canRead && rowId !== null && selected === null,
		staleTime: 60_000,
		retry: false
	}));
	const flyoutRecord = $derived(selected ?? rowFetch.data?.anchor ?? null);
	/** Open while a row is selected; closing the sheet clears the selection (`onopenchange`). */
	let flyoutOpen = $derived(rowId !== null);

	function select(record: LogRecord, tab: FlyoutTab = 'fields') {
		flyoutTab = tab;
		rowId = record.id;
	}

	// --- actions ------------------------------------------------------------------------------

	function run() {
		if (!parsed.ok) return;
		q = qText;
		runAt = Date.now();
		tickAt = runAt;
		if (hasPipes(qText) && mode === 'stream')
			mode =
				/\|\s*patterns\b/i.test(qText) && features?.patterns !== false ? 'patterns' : 'analytics';
	}

	function setTime(next: LogTime) {
		time = next;
		runAt = Date.now();
		tickAt = runAt;
		if (!reachesNow(next)) live = false;
	}

	function filterTo(field: string, value: string, exclude: boolean) {
		qText = toggleFilterClause(qText, field, value, exclude);
		run();
	}

	function pivot(clause: string) {
		const { pipes } = splitPipes(qText);
		qText = [clause, pipes].filter(Boolean).join(' ');
		rowId = null;
		run();
	}

	function around(record: LogRecord) {
		scrollToId = record.id;
		rowId = null;
		live = false;
		setTime(aroundLogTime(record.ts));
	}

	function applySaved(item: LogSavedQuery) {
		qText = item.q;
		if (!locked) scopeSel = item.scopes;
		time =
			'relative' in item.range
				? { kind: 'relative', value: item.range.relative }
				: { kind: 'absolute', from: item.range.from, to: item.range.to };
		if (item.columns.length > 0) columns = item.columns as StreamColumn[];
		run();
	}

	function currentSaved() {
		return {
			q,
			scopes: locked ? [] : scopeSel,
			range:
				time.kind === 'relative'
					? { relative: time.value }
					: { from: time.from, to: time.to ?? Date.now() },
			columns: [...columns]
		};
	}

	async function share() {
		try {
			await navigator.clipboard.writeText(window.location.href);
			toast.success('Link copied: it opens this query, scope and time window.');
		} catch {
			toast.error('Could not copy the link.');
		}
	}

	async function download(format: ExportFormat) {
		if (exporting) return;
		exporting = true;
		const id = toast.loading('Preparing the download…');
		try {
			const input = readBase;
			const { records: rows, capped } = await collectForExport(
				(cursor, limit) => searchLogs({ ...input, order: 'desc', limit, cursor }),
				{
					onProgress: (count) =>
						toast.loading(`Collected ${count.toLocaleString('en-GB')} lines…`, { id })
				}
			);
			downloadText(exportBody(rows, format), exportFilename(filename, format), exportMime(format));
			toast.success(
				capped
					? `Downloaded the newest ${rows.length.toLocaleString('en-GB')} lines (the cap). Use a drain for more.`
					: `Downloaded ${rows.length.toLocaleString('en-GB')} lines.`,
				{ id }
			);
		} catch (error) {
			toast.error(errorText(error, 'The download failed.'), { id });
		} finally {
			exporting = false;
		}
	}

	function toggleColumn(column: StreamColumn, on: boolean) {
		columns = on
			? [...columns.filter((item) => item !== column), column]
			: columns.filter((item) => item !== column);
		// Keep the built-ins in their natural order, attributes after.
		const rank = (item: StreamColumn) => {
			const index = (STREAM_COLUMNS as readonly string[]).indexOf(item);
			return index < 0 ? 100 : index;
		};
		columns = [...columns].sort((a, b) => rank(a) - rank(b));
	}

	// --- keyboard -----------------------------------------------------------------------------

	function explorerActive(): boolean {
		if (keyboard === 'global') return true;
		if (!root) return false;
		return root.contains(document.activeElement) || root.matches(':hover');
	}

	function onkey(event: KeyboardEvent) {
		// The query editor already handled its own Enter / ⌘↵.
		if (event.defaultPrevented || !canRead || !explorerActive()) return;
		const typing = isTypingTarget(event.target);
		const action = logShortcutFor(event, typing);
		if (!action) return;
		// Dialogs own their keys (Escape closes them; ⌘K etc. would open things behind them).
		const dialogOpen =
			savedOpen ||
			helpOpen ||
			timeOpen ||
			document.querySelector('[role="dialog"][data-state="open"]');
		if (dialogOpen && action !== 'next' && action !== 'previous') return;
		const focused = focusedIndex >= 0 ? recordAt(focusedIndex) : undefined;
		switch (action) {
			case 'focusQuery':
				event.preventDefault();
				editor?.focus();
				return;
			case 'run':
				event.preventDefault();
				run();
				return;
			case 'next':
			case 'previous': {
				if (records.length === 0) return;
				event.preventDefault();
				const step = action === 'next' ? 1 : -1;
				focusedIndex = Math.max(0, Math.min(records.length - 1, focusedIndex + step));
				stream?.scrollToIndex(focusedIndex);
				if (rowId) {
					const record = recordAt(focusedIndex);
					if (record) rowId = record.id;
				}
				return;
			}
			case 'expand':
				if (focused) {
					event.preventDefault();
					select(focused);
				}
				return;
			case 'context':
				if (focused ?? selected) {
					event.preventDefault();
					select((focused ?? selected)!, 'context');
				}
				return;
			case 'filter':
			case 'exclude': {
				const target = hoverValue ?? (focused ? primaryField(focused) : null);
				if (!target) return;
				event.preventDefault();
				filterTo(target.field, target.value, action === 'exclude');
				return;
			}
			case 'toggleLive':
				event.preventDefault();
				if (!live) toggleLive();
				else if (paused) resume();
				else userPaused = true;
				return;
			case 'time':
				event.preventDefault();
				timeOpen = true;
				return;
			case 'shiftBack':
			case 'shiftForward':
				event.preventDefault();
				setTime(shiftLogTime(time, action === 'shiftBack' ? -1 : 1, Date.now()));
				return;
			case 'palette':
				event.preventDefault();
				savedOpen = true;
				return;
			case 'help':
				event.preventDefault();
				helpOpen = true;
				return;
			case 'close':
				if (rowId) rowId = null;
				return;
		}
	}

	// --- URL state ----------------------------------------------------------------------------

	$effect(() => {
		if (!browser || urlPrefix === null) return;
		const state: ExplorerUrlState = {
			q,
			scopes: locked ? [] : scopeSel,
			time,
			mode,
			row: rowId,
			tz,
			live
		};
		untrack(() => {
			const current = page.shallow?.url ?? page.url;
			// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a throwaway copy to edit, not state
			const url = new URL(current.href);
			const next = encodeExplorerState(state, {
				prefix: urlPrefix ?? '',
				defaults: urlDefaults,
				base: url.searchParams
			});
			if (next.toString() === url.searchParams.toString()) return;
			url.search = next.toString();
			// eslint-disable-next-line svelte/no-navigation-without-resolve -- same route, only the query string changes
			void goto(url, { shallow: true, replace: true });
		});
	});

	// --- presentation -------------------------------------------------------------------------

	const histogramData = $derived(histogramQuery.data);
	const showDate = $derived(span > 86_400_000);
	const modeOptions = $derived([
		{ value: 'stream', label: 'Stream', disabled: false, title: undefined },
		{
			value: 'patterns',
			label: 'Patterns',
			disabled: caps ? !features?.patterns : false,
			title: caps && !features?.patterns ? LITE_REASON : 'Lines grouped by template'
		},
		{
			value: 'analytics',
			label: 'Analytics',
			disabled: false,
			title: '| stats as a chart and table'
		},
		{
			value: 'compare',
			label: 'Compare',
			disabled: caps ? !features?.compare : false,
			title: caps && !features?.compare ? LITE_REASON : 'Patterns now vs the previous window'
		}
	]);
	const phase = $derived.by(() => {
		if (finished && settled?.done)
			return { tone: 'bg-muted-foreground', text: settled.label ?? 'Finished' };
		if (finished)
			return {
				tone: 'bg-muted-foreground',
				text: tail.endReason ? `Ended: ${tail.endReason}` : 'Finished'
			};
		if (!tailing) return null;
		if (tail.status === 'connecting' || tail.status === 'idle')
			return { tone: 'bg-info animate-pulse', text: 'Connecting' };
		if (tail.status === 'error') return { tone: 'bg-destructive', text: 'Reconnecting' };
		if (paused) return { tone: 'bg-warning', text: 'Paused' };
		return { tone: 'bg-success', text: 'Live' };
	});
</script>

<svelte:window onkeydown={onkey} />

{#if !canRead}
	<div
		class="flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-16 text-center"
	>
		<ShieldAlertIcon class="size-6 text-muted-foreground" />
		<p class="text-sm font-medium">Logs need the logs:read permission</p>
		<p class="max-w-md text-sm text-muted-foreground">
			Ask an owner or admin for a role that includes log visibility.
		</p>
	</div>
{:else}
	<div
		bind:this={root}
		class="flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card shadow-xs"
	>
		<!-- Header: source switch, scope, time, live --------------------------------------------- -->
		<div class="flex flex-wrap items-center gap-2 border-b px-3 py-2">
			{@render toolbar?.()}
			<ScopeBar
				scopes={effectiveScopes}
				available={caps?.scopes ?? []}
				{locked}
				{lockedLabel}
				onchange={(next) => {
					scopeSel = next;
					runAt = Date.now();
				}}
			/>
			{#if baseQuery}
				<span
					class="inline-flex h-7 max-w-72 items-center gap-1.5 truncate rounded-md border border-dashed px-2 text-xs text-muted-foreground"
					title="Always applied here: {baseQuery}"
				>
					{baseLabel ?? baseQuery}
				</span>
			{/if}
			<div class="ml-auto flex flex-wrap items-center gap-2">
				<TimePicker
					value={time}
					{tz}
					bind:open={timeOpen}
					compact={locked}
					onchange={setTime}
					ontzchange={(next) => (tz = next)}
				/>
				<Button
					variant={tailing ? 'secondary' : 'outline'}
					size="sm"
					onclick={toggleLive}
					aria-pressed={live}
					title={live ? 'Stop the live tail' : 'Follow new lines as they arrive (space)'}
				>
					{#if tailing}
						<span class="relative flex size-2" aria-hidden="true">
							{#if !paused}<span
									class="absolute size-full animate-ping rounded-full bg-success opacity-60"
								></span>{/if}
							<span class="relative size-2 rounded-full {paused ? 'bg-warning' : 'bg-success'}"
							></span>
						</span>
						Live
					{:else}
						<PlayIcon />Live
					{/if}
				</Button>
			</div>
		</div>

		<!-- Query row ---------------------------------------------------------------------------- -->
		<div class="flex flex-wrap items-start gap-2 border-b px-3 py-2">
			<QueryEditor
				bind:this={editor}
				bind:value={qText}
				error={parsed.ok ? null : parsed.error}
				{catalog}
				id={urlPrefix ? `${urlPrefix}query` : 'log-query'}
				onrun={run}
			/>
			<div class="flex flex-wrap items-center gap-1.5">
				<Button size="sm" onclick={run} disabled={!parsed.ok} title="Run (⌘↵)"
					><SearchIcon />Run</Button
				>
				<SavedQueries
					bind:this={saved}
					bind:open={savedOpen}
					scopeOptions={caps?.scopes ?? []}
					allowScopes={!locked}
					current={currentSaved}
					onapply={applySaved}
					onscope={(scope) => {
						scopeSel = [scope];
						runAt = Date.now();
					}}
				/>
				<LogActions
					filter={streamQuery}
					scopes={effectiveScopes}
					{span}
					analytics={mode === 'analytics'}
					tableQuery={mode === 'analytics' ? tableQueryText : ''}
				/>
				<DropdownMenu.Root>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}
							<Button
								{...props}
								variant="outline"
								size="icon-sm"
								aria-label="Download"
								title="Download NDJSON or CSV"
								disabled={exporting}
							>
								{#if exporting}<Spinner />{:else}<DownloadIcon />{/if}
							</Button>
						{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content align="end" class="w-60">
						<DropdownMenu.Label class="text-xs font-normal text-muted-foreground">
							This query, newest first, up to 100,000 lines
						</DropdownMenu.Label>
						<DropdownMenu.Item onclick={() => download('ndjson')}
							>NDJSON (one record per line)</DropdownMenu.Item
						>
						<DropdownMenu.Item onclick={() => download('csv')}>CSV</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu.Root>
				{#if urlPrefix !== null}
					<Button
						variant="outline"
						size="icon-sm"
						aria-label="Copy a link to this view"
						title="Share: copy a link"
						onclick={share}
					>
						<Share2Icon />
					</Button>
				{/if}
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Keyboard shortcuts"
					title="Shortcuts (?)"
					onclick={() => (helpOpen = true)}
				>
					<KeyboardIcon />
				</Button>
			</div>
		</div>

		<!-- Notices ------------------------------------------------------------------------------ -->
		{#if lite}
			<LiteBanner dismissible={locked} installed={caps?.clickhouse.installed ?? false} />
		{/if}
		{#each warnings as warning (warning.code + warning.message)}
			<div
				class="flex items-center gap-2 border-b bg-warning/5 px-3 py-1.5 text-xs text-warning"
				role="status"
			>
				<TriangleAlertIcon class="size-3.5 shrink-0" />{warning.message}
			</div>
		{/each}
		{#if tail.sampled > 0}
			<div
				class="flex items-center gap-2 border-b bg-warning/5 px-3 py-1.5 text-xs text-warning"
				role="status"
			>
				<TriangleAlertIcon class="size-3.5 shrink-0" />
				Live tail is sampled: {tail.sampled.toLocaleString('en-GB')} lines were skipped to keep up. Pause
				and search the window for every line.
			</div>
		{/if}

		<!-- Body --------------------------------------------------------------------------------- -->
		<div class="flex min-h-0 min-w-0">
			{#if facetsOpen}
				<div class="hidden w-56 shrink-0 border-r md:flex md:flex-col">
					<FacetSidebar
						fields={fieldsQuery.data?.fields}
						loading={fieldsQuery.isFetching}
						error={fieldsQuery.isError
							? errorText(fieldsQuery.error, 'Could not read fields.')
							: null}
						query={q}
						attributesAvailable={!lite}
						onfilter={filterTo}
					/>
				</div>
			{/if}
			<div class="flex min-w-0 flex-1 flex-col">
				{#if histogram && mode === 'stream'}
					<div class="border-b px-3 pt-2 pb-1">
						{#if histogramQuery.isError}
							<p class="py-6 text-center text-xs text-muted-foreground">
								{errorText(histogramQuery.error, 'Could not draw the histogram.')}
							</p>
						{:else}
							<Histogram
								buckets={histogramData ? histogramBuckets(histogramData) : []}
								series={SEVERITY_SERIES}
								from={histogramData?.from ?? liveBounds.from}
								to={histogramData?.to ?? liveBounds.to}
								intervalMs={histogramData?.intervalMs ?? Math.max(1_000, span / 60)}
								markers={histogramData?.markers ?? []}
								{tz}
								loading={histogramQuery.isFetching}
								onzoom={(from, to) => {
									live = false;
									setTime(zoomLogTime(from, to));
								}}
							/>
						{/if}
					</div>
				{/if}

				<div class="flex flex-wrap items-center gap-2 border-b px-3 py-1.5">
					<Button
						variant="ghost"
						size="icon-sm"
						class="hidden md:inline-flex"
						aria-label={facetsOpen ? 'Hide fields' : 'Show fields'}
						aria-pressed={facetsOpen}
						title={facetsOpen ? 'Hide fields' : 'Show fields'}
						onclick={() => (facetsOpen = !facetsOpen)}
					>
						<PanelLeftIcon />
					</Button>
					{#if modes}
						<ToggleGroup.Root
							type="single"
							size="sm"
							value={mode}
							onValueChange={(value) => value && (mode = value as ExplorerMode)}
							aria-label="View"
						>
							{#each modeOptions as option (option.value)}
								<ToggleGroup.Item
									value={option.value}
									class="px-2 text-xs"
									disabled={option.disabled}
									title={option.title}
								>
									{option.label}
								</ToggleGroup.Item>
							{/each}
						</ToggleGroup.Root>
					{/if}
					{#if streamView && mode === 'stream'}
						<ToggleGroup.Root
							type="single"
							size="sm"
							variant="outline"
							value={customView ? 'custom' : 'lines'}
							onValueChange={(value) => value && (customView = value === 'custom')}
							aria-label="Layout"
						>
							<ToggleGroup.Item value="custom" class="px-2 text-xs"
								>{streamViewLabel}</ToggleGroup.Item
							>
							<ToggleGroup.Item value="lines" class="px-2 text-xs">Lines</ToggleGroup.Item>
						</ToggleGroup.Root>
					{/if}
					<div class="ml-auto flex items-center gap-1">
						{#if mode === 'stream'}
							<Toggle
								size="sm"
								class="text-xs"
								pressed={wrap}
								onPressedChange={(pressed) => (wrap = pressed)}
								aria-label="Wrap lines"
							>
								<WrapTextIcon />Wrap
							</Toggle>
							<DropdownMenu.Root>
								<DropdownMenu.Trigger>
									{#snippet child({ props })}
										<Button {...props} variant="ghost" size="sm" class="text-xs"
											><Columns3Icon />Columns</Button
										>
									{/snippet}
								</DropdownMenu.Trigger>
								<DropdownMenu.Content align="end" class="w-56">
									{#each STREAM_COLUMNS as column (column)}
										<DropdownMenu.CheckboxItem
											checked={columns.includes(column)}
											onCheckedChange={(checked) => toggleColumn(column, checked)}
										>
											{column}
										</DropdownMenu.CheckboxItem>
									{/each}
									{#if attributeColumns.length > 0}
										<DropdownMenu.Separator />
										<DropdownMenu.Label class="text-xs font-normal text-muted-foreground"
											>Attributes</DropdownMenu.Label
										>
										{#each attributeColumns as column (column)}
											<DropdownMenu.CheckboxItem
												checked={columns.includes(column)}
												onCheckedChange={(checked) => toggleColumn(column, checked)}
											>
												<span class="font-mono text-xs">{column}</span>
											</DropdownMenu.CheckboxItem>
										{/each}
									{/if}
								</DropdownMenu.Content>
							</DropdownMenu.Root>
						{/if}
					</div>
				</div>

				{#if mode === 'stream'}
					<div class="relative">
						{#if pending.length > 0}
							<div
								class="pointer-events-none absolute inset-x-0 z-10 flex justify-center {order ===
								'newest-first'
									? 'top-2'
									: 'bottom-2'}"
							>
								<Button size="xs" class="pointer-events-auto shadow-md" onclick={resume}>
									{#if order === 'newest-first'}<ArrowUpIcon />{:else}<ArrowDownIcon />{/if}
									{pending.length.toLocaleString('en-GB')} new
								</Button>
							</div>
						{/if}
						{#if streamView && customView}
							{@render streamView({ records, live: tailing, done: finished })}
						{:else}
							<LogStream
								bind:this={stream}
								bind:focusedIndex
								{records}
								{order}
								{columns}
								{wrap}
								{tz}
								{showDate}
								{terms}
								selectedId={rowId}
								hasOlder={!loadAll &&
									(olderCursor !== null || trimmed) &&
									records.length < MAX_BUFFER}
								{loadingOlder}
								hasNewer={!tailing && newerCursor !== null && !loadAll}
								{loadingNewer}
								{heightClass}
								onloadolder={loadOlder}
								onloadnewer={loadNewer}
								onselect={(record) => select(record)}
								onhover={(value) => (hoverValue = value)}
								onedge={(edge) => (atEdge = edge)}
							>
								{#snippet empty()}
									{#if loading}
										<div class="flex flex-col items-center gap-3 text-muted-foreground">
											<Spinner />
											<p class="font-sans text-xs">Searching…</p>
										</div>
									{:else if streamError}
										<div class="flex max-w-md flex-col items-center gap-2 text-center font-sans">
											<TriangleAlertIcon class="size-5 text-destructive" />
											<p class="text-sm text-destructive">{streamError}</p>
											<Button variant="outline" size="sm" onclick={() => void load()}
												>Try again</Button
											>
										</div>
									{:else}
										<div
											class="flex max-w-md flex-col items-center gap-2 text-center font-sans text-muted-foreground"
										>
											<ScrollTextIcon class="size-5" />
											<p class="text-sm font-medium text-foreground">
												{tailing ? 'Waiting for new lines' : 'No lines in this window'}
											</p>
											<p class="text-xs">{emptyHint}</p>
											{#if !(time.kind === 'relative' && time.value === '7d')}
												<Button
													variant="outline"
													size="sm"
													onclick={() => setTime({ kind: 'relative', value: '7d' })}
												>
													Search the last 7 days
												</Button>
											{/if}
										</div>
									{/if}
								{/snippet}
							</LogStream>
						{/if}
					</div>
				{:else}
					<TableView
						{mode}
						result={tableQuery.data}
						previous={previousQuery.data}
						loading={tableQuery.isFetching || previousQuery.isFetching}
						error={tableQuery.isError
							? errorText(tableQuery.error, 'The query failed.')
							: previousQuery.isError
								? errorText(previousQuery.error, 'The query failed.')
								: null}
						unavailable={modeUnavailable}
						{tz}
						query={tableQueryText}
						onfilter={filterTo}
					/>
				{/if}
			</div>
		</div>

		<!-- Footer ------------------------------------------------------------------------------- -->
		<div
			class="flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 py-1.5 font-mono text-xs text-muted-foreground"
		>
			{#if phase}
				<span class="inline-flex items-center gap-1.5"
					><span class="size-1.5 rounded-full {phase.tone}"></span>{phase.text}</span
				>
			{/if}
			{#if loading && records.length > 0}<span class="inline-flex items-center gap-1"
					><Spinner class="size-3" />Loading</span
				>{/if}
			<span>{records.length.toLocaleString('en-GB')} lines loaded</span>
			{#if histogramData}<span>{histogramData.total.toLocaleString('en-GB')} in window</span>{/if}
			{#if tail.error && tailing}<span class="text-warning">{tail.error}</span>{/if}
			<span class="ml-auto hidden items-center gap-2 sm:inline-flex">
				{#if engine ?? caps?.engine}
					<span title="Which store answered"
						>{(engine ?? caps?.engine) === 'sqlite' ? 'SQLite · lite' : 'ClickHouse'}</span
					>
				{/if}
				{#if elapsedMs !== null}<span>{elapsedMs} ms</span>{/if}
			</span>
		</div>
	</div>

	<RecordFlyout
		record={flyoutRecord}
		bind:open={flyoutOpen}
		bind:tab={flyoutTab}
		{tz}
		{terms}
		onfilter={(field, value, exclude) => {
			rowId = null;
			filterTo(field, value, exclude);
		}}
		onpivot={pivot}
		onaround={around}
		onopenchange={(next) => {
			if (!next) rowId = null;
		}}
	/>
	<ShortcutsHelp bind:open={helpOpen} />
{/if}
