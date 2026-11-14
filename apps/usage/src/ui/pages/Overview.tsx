import { useEffect, useState } from 'react';
import { ApiError, formatCount, getJson, humanize, relativeTime, type Overview as OverviewData } from '../api.ts';
import { BarList, DailyChart } from '../charts.tsx';
import { Card, Notice, PageHead, Segmented } from '../components.tsx';
import { useRouter } from '../router.tsx';

const WINDOWS = [
	{ value: 7, label: '7 days' },
	{ value: 30, label: '30 days' },
	{ value: 90, label: '90 days' },
	{ value: 365, label: '1 year' }
];

export function Overview({ onUnauthorized }: { onUnauthorized: () => void }) {
	const { search, navigate } = useRouter();
	const days = Number(search.get('days')) || 30;
	const [data, setData] = useState<OverviewData | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		getJson<OverviewData>(`/api/v1/overview?days=${days}`)
			.then((result) => {
				if (cancelled) return;
				setData(result);
				setError(null);
			})
			.catch((failure) => {
				if (cancelled) return;
				if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) return onUnauthorized();
				setError('Could not load the numbers. Try again in a moment.');
			})
			.finally(() => !cancelled && setLoading(false));
		return () => {
			cancelled = true;
		};
	}, [days, onUnauthorized]);

	const stats = data?.stats;
	const activeInWindow = stats ? stats.os.reduce((sum, row) => sum + row.installs, 0) : 0;
	const newInWindow = data ? data.daily.reduce((sum, day) => sum + day.newInstalls, 0) : 0;
	const windowLabel = WINDOWS.find((option) => option.value === days)?.label ?? `${days} days`;

	return (
		<>
			<PageHead
				title="Overview"
				lede={stats ? `Updated ${relativeTime(stats.generatedAt)}. Counts are installs, from each one's latest ping in the window.` : 'Usage pings from self-hosted Yoal installs.'}
				actions={<Segmented label="Time window" value={days} options={WINDOWS} onChange={(value) => navigate(`/?days=${value}`, { replace: true })} />}
			/>
			{error && <Notice kind="error">{error}</Notice>}
			{stats && stats.installs.total === 0 && (
				<Notice kind="warn">
					No pings yet. An install that turns on usage analytics sends one ping a day to <code>{window.location.origin}/api/v1/ping</code>.
				</Notice>
			)}
			{stats && data && (
				<div className={loading ? 'loading' : ''} style={{ display: 'contents' }}>
					<div className="tiles">
						<Card className="hero">
							<div className="tile-label">Active installs, last {windowLabel}</div>
							<div className="tile-value">{formatCount(activeInWindow)}</div>
							<div className="tile-note">{formatCount(stats.installs.total)} seen in total</div>
						</Card>
						<Card>
							<div className="tile-label">Active, last 7 days</div>
							<div className="tile-value">{formatCount(stats.installs.active7d)}</div>
							<div className="tile-note">{formatCount(stats.installs.active30d)} in the last 30 days</div>
						</Card>
						<Card>
							<div className="tile-label">New in window</div>
							<div className="tile-value">{formatCount(newInWindow)}</div>
							<div className="tile-note">First ping in the last {windowLabel}</div>
						</Card>
						<Card>
							<div className="tile-label">Pings, last 24 hours</div>
							<div className="tile-value">{formatCount(stats.pings.last24h)}</div>
							<div className="tile-note">{formatCount(stats.pings.inWindow)} in window</div>
						</Card>
					</div>

					<Card title="Installs per day" note="UTC days. An install is active on a day it sent a ping.">
						<DailyChart days={data.daily} loading={loading} />
					</Card>

					<div className="grid grid-3">
						<Card title="Versions" note="Latest version per active install">
							<BarList label="Installs by version" items={stats.versions} total={activeInWindow} limit={6} />
						</Card>
						<Card title="Operating system">
							<BarList label="Installs by operating system" items={stats.os} total={activeInWindow} />
						</Card>
						<Card title="Architecture">
							<BarList label="Installs by architecture" items={stats.arch} total={activeInWindow} />
						</Card>
					</div>

					<div className="grid grid-2">
						<Card title="Features turned on" note="Share of active installs with each feature flag on">
							<BarList label="Feature adoption" items={stats.features} total={activeInWindow} limit={10} format={humanize} />
						</Card>
						<Card title="Services configured" note="Share of active installs that set each one up">
							<BarList label="Configured services" items={stats.capabilities} total={activeInWindow} limit={10} format={humanize} />
						</Card>
					</div>

					<Card title="Platform size" note="From each active install's latest ping">
						<div className="table-wrap">
							<table>
								<thead>
									<tr>
										<th>Metric</th>
										<th className="num">Installs reporting</th>
										<th className="num">Total</th>
										<th className="num">Average per install</th>
									</tr>
								</thead>
								<tbody>
									{Object.entries(stats.metrics).map(([key, metric]) => (
										<tr key={key}>
											<td>{humanize(key)}</td>
											<td className="num">{formatCount(metric.installs)}</td>
											<td className="num">{formatCount(metric.total)}</td>
											<td className="num">{metric.average.toLocaleString('en')}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					</Card>
				</div>
			)}
			{!stats && loading && <p className="empty">Loading…</p>}
		</>
	);
}
