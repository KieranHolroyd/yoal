<script lang="ts">
	import type { EffectiveLogSettings, LogSettingsLevel, LogSettingsRow } from '@yoal/contracts';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';

	/**
	 * The fields of one `log_settings` level (docs/LOGS.md §10). A blank field inherits: its
	 * placeholder shows what it would inherit. Hot tail and archive exist per org (and platform),
	 * not per project.
	 */
	let {
		level,
		prefix,
		row,
		inherited,
		disabled = false
	}: {
		level: LogSettingsLevel;
		prefix: string;
		row: LogSettingsRow;
		/** The effective values one level up (what a blank field means). */
		inherited: EffectiveLogSettings;
		disabled?: boolean;
	} = $props();

	const perOrg = $derived(level !== 'project');
	const value = (key: keyof LogSettingsRow) => (row[key] === undefined ? '' : String(row[key]));
	const percent = $derived(row.edgeSampleRate === undefined ? '' : String(Math.round(row.edgeSampleRate * 1000) / 10));
	let everyRequest = $state(false);
	$effect.pre(() => {
		everyRequest = row.edgeSampleRate === 1;
	});
	const hint = (text: string) => `Inherits ${text}`;
</script>

<div class="space-y-6">
	{#if perOrg}
		<Field.Group>
			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="{prefix}-hot">Hot tail (days)</Field.Label>
					<Input id="{prefix}-hot" name="hotDays" type="number" min={1} max={14} value={value('hotDays')} placeholder={hint(`${inherited.hotDays}`)} {disabled} />
					<Field.Description>
						Kept in the platform database for live tail, context and drains (1–14). Unset: 3 days with the search index, 7 without.
					</Field.Description>
				</Field.Field>
				<Field.Field>
					<Field.Label for="{prefix}-search">Search (days)</Field.Label>
					<Input id="{prefix}-search" name="searchDays" type="number" min={1} max={90} value={value('searchDays')} placeholder={hint(`${inherited.searchDays}`)} {disabled} />
					<Field.Description>Kept in the ClickHouse search index (1–90). Projects may keep fewer.</Field.Description>
				</Field.Field>
				<Field.Field>
					<Field.Label for="{prefix}-archive">Archive</Field.Label>
					<NativeSelect.Root id="{prefix}-archive" name="archiveEnabled" value={row.archiveEnabled === undefined ? '' : row.archiveEnabled ? 'on' : 'off'} class="w-full" {disabled}>
						<NativeSelect.Option value="">Inherit ({inherited.archiveEnabled ? 'on' : 'off'})</NativeSelect.Option>
						<NativeSelect.Option value="on">On: daily Parquet in the object store</NativeSelect.Option>
						<NativeSelect.Option value="off">Off</NativeSelect.Option>
					</NativeSelect.Root>
					<Field.Description>Older ranges are searched from the archive only after you confirm the estimate.</Field.Description>
				</Field.Field>
				<Field.Field>
					<Field.Label for="{prefix}-archive-days">Archive (days)</Field.Label>
					<Input id="{prefix}-archive-days" name="archiveDays" type="number" min={30} max={400} value={value('archiveDays')} placeholder={hint(`${inherited.archiveDays}`)} {disabled} />
				</Field.Field>
			</div>
		</Field.Group>
	{:else}
		<Field.Field>
			<Field.Label for="{prefix}-search">Search (days)</Field.Label>
			<Input id="{prefix}-search" name="searchDays" type="number" min={1} max={90} value={value('searchDays')} placeholder={hint(`${inherited.searchDays}`)} {disabled} />
			<Field.Description>At most the organisation’s window.</Field.Description>
		</Field.Field>
	{/if}

	<Field.Group>
		<div class="grid gap-4 sm:grid-cols-3">
			<Field.Field>
				<Field.Label for="{prefix}-rate">Lines per second</Field.Label>
				<Input id="{prefix}-rate" name="ingestLinesPerSecond" type="number" min={1} value={value('ingestLinesPerSecond')} placeholder={hint(`${inherited.ingestLinesPerSecond}`)} {disabled} />
			</Field.Field>
			<Field.Field>
				<Field.Label for="{prefix}-burst">Burst (lines)</Field.Label>
				<Input id="{prefix}-burst" name="ingestBurst" type="number" min={1} value={value('ingestBurst')} placeholder={hint(`${inherited.ingestBurst}`)} {disabled} />
			</Field.Field>
			<Field.Field>
				<Field.Label for="{prefix}-mb">MB per day</Field.Label>
				<Input id="{prefix}-mb" name="ingestMbPerDay" type="number" min={1} value={value('ingestMbPerDay')} placeholder={hint(`${inherited.ingestMbPerDay}`)} {disabled} />
			</Field.Field>
		</div>
		<Field.Description>
			Per project (and per database, bucket or broker). Lines over the limit are dropped and counted, with one notice a
			minute in the project’s logs. {level === 'platform' ? 'These are the ceiling: an organisation or project can only lower them.' : 'You can lower these below the platform limit, not raise them.'}
		</Field.Description>
	</Field.Group>

	<Field.Group>
		{#if level === 'project'}
			<Field.Field orientation="horizontal" class="gap-2">
				<Switch id="{prefix}-every" bind:checked={everyRequest} {disabled} />
				<Field.Content>
					<Field.Label for="{prefix}-every" class="font-normal">Ship every request</Field.Label>
					<Field.Description>
						Send every 2xx/3xx edge request to logs, not a {Math.round(inherited.edgeSampleRate * 100)}% sample. Errors are always shipped.
					</Field.Description>
				</Field.Content>
			</Field.Field>
			<input type="hidden" name="edgeSamplePercent" value={everyRequest ? '100' : ''} />
		{:else}
			<Field.Field>
				<Field.Label for="{prefix}-edge">Edge 2xx sample (%)</Field.Label>
				<Input id="{prefix}-edge" name="edgeSamplePercent" type="number" min={0} max={100} step="0.1" value={percent} placeholder={hint(`${Math.round(inherited.edgeSampleRate * 1000) / 10}%`)} {disabled} />
				<Field.Description>Share of successful edge requests kept as access records. Every non-2xx response is always shipped.</Field.Description>
			</Field.Field>
		{/if}
	</Field.Group>
</div>
