import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { formatCount, formatDay, formatPercent, type Named, type UsageDay } from './api.ts';

/**
 * Charts, drawn as plain SVG to the dataviz specs: 2px lines, a 10% area wash, hairline solid
 * grid, >= 8px end markers with a 2px surface ring, a crosshair that snaps to the nearest day
 * with one tooltip listing every series, and a table view so nothing hides behind hover.
 * Text always uses text tokens; colour lives only on marks and keys.
 */

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
	const ref = useRef<T>(null);
	const [width, setWidth] = useState(0);
	useEffect(() => {
		const node = ref.current;
		if (!node) return;
		const observer = new ResizeObserver((entries) => setWidth(Math.floor(entries[0]!.contentRect.width)));
		observer.observe(node);
		setWidth(Math.floor(node.getBoundingClientRect().width));
		return () => observer.disconnect();
	}, []);
	return [ref, width];
}

/** Clean ticks from 0: 1, 2 or 5 times a power of ten, about four steps. */
function niceTicks(max: number): number[] {
	if (max <= 0) return [0, 1];
	const rough = max / 4;
	const power = 10 ** Math.floor(Math.log10(rough));
	const step = [1, 2, 5, 10].map((m) => m * power).find((candidate) => candidate >= rough) ?? power * 10;
	const ticks: number[] = [];
	for (let value = 0; value <= max + step * 0.001; value += step) ticks.push(Math.round(value));
	if (ticks[ticks.length - 1]! < max) ticks.push(ticks[ticks.length - 1]! + step);
	return ticks.map((tick) => Math.max(0, Math.round(tick)));
}

interface Series {
	key: 'activeInstalls' | 'newInstalls';
	label: string;
	color: string;
}

const SERIES: Series[] = [
	{ key: 'activeInstalls', label: 'Active installs', color: 'var(--series-1)' },
	{ key: 'newInstalls', label: 'New installs', color: 'var(--series-2)' }
];

export function DailyChart({ days, loading }: { days: UsageDay[]; loading?: boolean }) {
	const [ref, width] = useWidth<HTMLDivElement>();
	const [active, setActive] = useState<number | null>(null);
	const [showTable, setShowTable] = useState(false);
	const height = 240;
	const margin = { top: 14, right: 44, bottom: 26, left: 40 };
	const innerWidth = Math.max(0, width - margin.left - margin.right);
	const innerHeight = height - margin.top - margin.bottom;

	const max = Math.max(1, ...days.flatMap((day) => [day.activeInstalls, day.newInstalls]));
	const ticks = niceTicks(max);
	const top = ticks[ticks.length - 1]!;
	const x = (index: number) => margin.left + (days.length <= 1 ? innerWidth / 2 : (index / (days.length - 1)) * innerWidth);
	const y = (value: number) => margin.top + innerHeight - (value / top) * innerHeight;

	const paths = useMemo(() => {
		if (width === 0 || days.length === 0) return null;
		return SERIES.map((series) => {
			const points = days.map((day, index) => `${x(index).toFixed(1)},${y(day[series.key]).toFixed(1)}`);
			return { series, line: `M${points.join('L')}` };
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [days, width, top]);

	const area = useMemo(() => {
		if (width === 0 || days.length === 0) return '';
		const points = days.map((day, index) => `${x(index).toFixed(1)},${y(day.activeInstalls).toFixed(1)}`);
		return `M${x(0).toFixed(1)},${y(0).toFixed(1)}L${points.join('L')}L${x(days.length - 1).toFixed(1)},${y(0).toFixed(1)}Z`;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [days, width, top]);

	const xTickCount = Math.max(2, Math.min(7, Math.floor(innerWidth / 90)));
	const xTicks = days.length <= 1 ? [0] : Array.from({ length: xTickCount }, (_, i) => Math.round((i / (xTickCount - 1)) * (days.length - 1)));

	const nearest = (clientX: number, target: Element) => {
		const box = target.getBoundingClientRect();
		const relative = clientX - box.left - margin.left;
		if (days.length <= 1) return 0;
		return Math.max(0, Math.min(days.length - 1, Math.round((relative / innerWidth) * (days.length - 1))));
	};

	const onPointer = (event: PointerEvent<SVGRectElement>) => setActive(nearest(event.clientX, event.currentTarget.ownerSVGElement!));
	const onKey = (event: KeyboardEvent<SVGSVGElement>) => {
		if (event.key === 'ArrowRight') setActive((index) => Math.min(days.length - 1, (index ?? days.length - 1) + 1));
		else if (event.key === 'ArrowLeft') setActive((index) => Math.max(0, (index ?? days.length - 1) - 1));
		else if (event.key === 'Escape') setActive(null);
		else return;
		event.preventDefault();
	};

	const last = days[days.length - 1];
	const hovered = active !== null ? days[active] : null;
	const label = `Daily active and new installs over ${days.length} days. Latest: ${last?.activeInstalls ?? 0} active, ${last?.newInstalls ?? 0} new.`;

	return (
		<div>
			<div className="row" style={{ marginBottom: '0.6rem' }}>
				<div className="legend" aria-hidden="true">
					{SERIES.map((series) => (
						<span key={series.key}>
							<i className="key-line" style={{ background: series.color }} />
							{series.label}
						</span>
					))}
				</div>
				<span className="spacer" />
				<button type="button" className="link-btn" onClick={() => setShowTable((value) => !value)}>
					{showTable ? 'Show chart' : 'Show table'}
				</button>
			</div>
			{showTable ? (
				<div className="table-wrap" style={{ maxHeight: 320, overflowY: 'auto' }}>
					<table>
						<thead>
							<tr>
								<th>Day (UTC)</th>
								<th className="num">Active installs</th>
								<th className="num">New installs</th>
								<th className="num">Pings</th>
							</tr>
						</thead>
						<tbody>
							{[...days].reverse().map((day) => (
								<tr key={day.day}>
									<td>{formatDay(day.day)}</td>
									<td className="num">{formatCount(day.activeInstalls)}</td>
									<td className="num">{formatCount(day.newInstalls)}</td>
									<td className="num">{formatCount(day.pings)}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : (
				<div ref={ref} className={`chart ${loading ? 'loading' : ''}`}>
					{width > 0 && (
						<svg
							width={width}
							height={height}
							viewBox={`0 0 ${width} ${height}`}
							role="img"
							aria-label={label}
							tabIndex={0}
							onKeyDown={onKey}
							onBlur={() => setActive(null)}
						>
							{ticks.map((tick) => (
								<g key={tick}>
									<line className="grid-line" x1={margin.left} x2={width - margin.right} y1={y(tick)} y2={y(tick)} />
									<text className="axis-text" x={margin.left - 8} y={y(tick)} dy="0.32em" textAnchor="end">
										{formatCount(tick)}
									</text>
								</g>
							))}
							{xTicks.map((index) => (
								<text key={index} className="axis-text" x={x(index)} y={height - 6} textAnchor={index === 0 ? 'start' : index === days.length - 1 ? 'end' : 'middle'}>
									{days[index] ? formatDay(days[index]!.day) : ''}
								</text>
							))}
							<path d={area} fill="var(--series-1-wash)" />
							{paths?.map(({ series, line }) => (
								<path key={series.key} d={line} fill="none" stroke={series.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
							))}
							{last &&
								SERIES.map((series) => (
									<g key={series.key}>
										<circle cx={x(days.length - 1)} cy={y(last[series.key])} r={4} fill={series.color} stroke="var(--surface)" strokeWidth={2} />
									</g>
								))}
							{last && (
								<text className="end-label" x={x(days.length - 1) + 8} y={y(last.activeInstalls)} dy="0.32em">
									{formatCount(last.activeInstalls)}
								</text>
							)}
							{hovered && active !== null && (
								<g pointerEvents="none">
									<line className="crosshair" x1={x(active)} x2={x(active)} y1={margin.top} y2={margin.top + innerHeight} />
									{SERIES.map((series) => (
										<circle key={series.key} cx={x(active)} cy={y(hovered[series.key])} r={4} fill={series.color} stroke="var(--surface)" strokeWidth={2} />
									))}
								</g>
							)}
							<rect
								x={margin.left}
								y={margin.top}
								width={innerWidth}
								height={innerHeight}
								fill="transparent"
								onPointerMove={onPointer}
								onPointerDown={onPointer}
								onPointerLeave={() => setActive(null)}
							/>
						</svg>
					)}
					{hovered && active !== null && (
						<div className="tooltip" style={{ left: x(active), top: margin.top + Math.min(y(hovered.activeInstalls), y(hovered.newInstalls)) }}>
							<div className="t-head">{formatDay(hovered.day)}</div>
							{SERIES.map((series) => (
								<div className="t-row" key={series.key}>
									<i className="key-line" style={{ background: series.color }} />
									<strong>{formatCount(hovered[series.key])}</strong>
									<span>{series.label.toLowerCase()}</span>
								</div>
							))}
							<div className="t-row">
								<i className="key-line" style={{ background: 'transparent' }} />
								<strong>{formatCount(hovered.pings)}</strong>
								<span>pings</span>
							</div>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

/**
 * Horizontal bars for a share of installs. Single series, so no legend: the card title names it.
 * The value sits at the bar tip with its share of `total`; the full list is the table.
 */
export function BarList({ items, total, limit = 8, label, format }: { items: Named[]; total: number; limit?: number; label: string; format?: (name: string) => string }) {
	const [expanded, setExpanded] = useState(false);
	const shown = expanded ? items : items.slice(0, limit);
	const max = Math.max(1, ...items.map((item) => item.installs));
	if (items.length === 0) return <p className="empty">No installs reported in this window.</p>;
	return (
		<div>
			<ul className="bars" aria-label={label}>
				{shown.map((item) => {
					const share = formatPercent(item.installs, total);
					const name = format ? format(item.name) : item.name;
					return (
						<li key={item.name} className="bar-row" tabIndex={0} title={`${name}: ${item.installs} of ${total} installs (${share})`} aria-label={`${name}: ${item.installs} installs, ${share}`}>
							<span className="bar-name">{name}</span>
							<span className="bar-track" aria-hidden="true">
								<span className={`bar-fill ${item.installs === 0 ? 'zero' : ''}`} style={{ width: `${(item.installs / max) * 100}%`, display: 'block' }} />
							</span>
							<span className="bar-value">
								{formatCount(item.installs)}
								<small>{share}</small>
							</span>
						</li>
					);
				})}
			</ul>
			{items.length > limit && (
				<button type="button" className="link-btn" style={{ marginTop: '0.75rem' }} onClick={() => setExpanded((value) => !value)}>
					{expanded ? 'Show fewer' : `Show all ${items.length}`}
				</button>
			)}
		</div>
	);
}
