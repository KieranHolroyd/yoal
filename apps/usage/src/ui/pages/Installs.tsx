import { useEffect, useState } from 'react';
import { ApiError, formatCount, formatDateTime, getJson, relativeTime, type InstallPage, type Overview } from '../api.ts';
import { Card, Notice, PageHead } from '../components.tsx';
import { useRouter } from '../router.tsx';

const PAGE = 50;

export function Installs({ onUnauthorized }: { onUnauthorized: () => void }) {
	const { search, navigate } = useRouter();
	const offset = Math.max(0, Number(search.get('offset')) || 0);
	const version = search.get('version') ?? '';
	const [page, setPage] = useState<InstallPage | null>(null);
	const [versions, setVersions] = useState<string[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		getJson<Overview>('/api/v1/overview?days=400')
			.then((data) => setVersions(data.stats.versions.map((row) => row.name)))
			.catch(() => undefined);
	}, []);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		const query = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
		if (version) query.set('version', version);
		getJson<InstallPage>(`/api/v1/installs?${query}`)
			.then((result) => !cancelled && (setPage(result), setError(null)))
			.catch((failure) => {
				if (cancelled) return;
				if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) return onUnauthorized();
				setError('Could not load installs.');
			})
			.finally(() => !cancelled && setLoading(false));
		return () => {
			cancelled = true;
		};
	}, [offset, version, onUnauthorized]);

	const go = (next: { offset?: number; version?: string }) => {
		const query = new URLSearchParams();
		const v = next.version ?? version;
		const o = next.offset ?? offset;
		if (v) query.set('version', v);
		if (o) query.set('offset', String(o));
		navigate(`/installs${query.size ? `?${query}` : ''}`, { replace: true });
	};

	return (
		<>
			<PageHead
				title="Installs"
				lede="Every install that has sent a ping, most recently seen first. Ids are random and anonymous; only a prefix is shown."
				actions={
					<select aria-label="Filter by version" value={version} onChange={(event) => go({ version: event.target.value, offset: 0 })} style={{ width: 'auto' }}>
						<option value="">All versions</option>
						{versions.map((name) => (
							<option key={name} value={name}>
								{name}
							</option>
						))}
					</select>
				}
			/>
			{error && <Notice kind="error">{error}</Notice>}
			<Card>
				{page && page.rows.length === 0 ? (
					<p className="empty">{version ? `No installs on ${version}.` : 'No installs have sent a ping yet.'}</p>
				) : (
					<div className={`table-wrap ${loading ? 'loading' : ''}`}>
						<table>
							<thead>
								<tr>
									<th>Install</th>
									<th>Version</th>
									<th>Platform</th>
									<th>Last seen</th>
									<th>First seen</th>
									<th className="num">Pings</th>
									<th className="num">Nodes</th>
									<th className="num">Projects</th>
									<th className="num">Users</th>
								</tr>
							</thead>
							<tbody>
								{page?.rows.map((row) => (
									<tr key={row.id}>
										<td className="mono">{row.id}…</td>
										<td>
											{row.lastVersion}
											{row.firstVersion !== row.lastVersion && <span className="sub" style={{ color: 'var(--muted)', marginLeft: 6, fontSize: '0.8rem' }}>from {row.firstVersion}</span>}
										</td>
										<td>
											{row.os} / {row.arch}
										</td>
										<td title={formatDateTime(row.lastSeenAt)}>{relativeTime(row.lastSeenAt)}</td>
										<td>{formatDateTime(row.firstSeenAt)}</td>
										<td className="num">{formatCount(row.pings)}</td>
										<td className="num">{row.nodes ?? '–'}</td>
										<td className="num">{row.projects ?? '–'}</td>
										<td className="num">{row.users ?? '–'}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
				{page && page.total > PAGE && (
					<div className="pager">
						<span>
							{offset + 1}–{Math.min(offset + PAGE, page.total)} of {formatCount(page.total)}
						</span>
						<button type="button" className="btn btn-sm" disabled={offset === 0} onClick={() => go({ offset: Math.max(0, offset - PAGE) })}>
							Previous
						</button>
						<button type="button" className="btn btn-sm" disabled={offset + PAGE >= page.total} onClick={() => go({ offset: offset + PAGE })}>
							Next
						</button>
					</div>
				)}
			</Card>
		</>
	);
}
