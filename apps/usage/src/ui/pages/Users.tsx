import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { formatDateTime, type SessionState } from '../api.ts';
import { authClient, authMessage } from '../auth-client.ts';
import { Card, Field, Notice, PageHead } from '../components.tsx';

interface UserRow {
	id: string;
	name: string;
	email: string;
	role?: string | null;
	twoFactorEnabled?: boolean | null;
	banned?: boolean | null;
	createdAt: string | Date;
}

/** Admins add and remove accounts. Public sign-up is off, so this is the only way in. */
export function Users({ session }: { session: SessionState }) {
	const me = session.user!;
	const [rows, setRows] = useState<UserRow[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [created, setCreated] = useState<string | null>(null);
	const [name, setName] = useState('');
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const [role, setRole] = useState<'user' | 'admin'>('user');
	const [busy, setBusy] = useState(false);

	const load = useCallback(async () => {
		const { data, error: failure } = await authClient.admin.listUsers({ query: { limit: 200, sortBy: 'createdAt', sortDirection: 'asc' } });
		if (failure) return setError(authMessage(failure, 'Could not load accounts.'));
		setRows((data?.users as UserRow[] | undefined) ?? []);
	}, []);
	useEffect(() => {
		void load();
	}, [load]);

	const create = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		setCreated(null);
		const { error: failure } = await authClient.admin.createUser({ name: name.trim(), email: email.trim(), password, role });
		setBusy(false);
		if (failure) return setError(authMessage(failure, 'Could not create the account.'));
		setCreated(`${email.trim()} can now sign in with the password you set. Share it privately; they should change it and add a second factor straight away.`);
		setName('');
		setEmail('');
		setPassword('');
		setRole('user');
		await load();
	};

	const changeRole = async (row: UserRow, next: 'user' | 'admin') => {
		const { error: failure } = await authClient.admin.setRole({ userId: row.id, role: next });
		if (failure) return setError(authMessage(failure, 'Could not change the role.'));
		await load();
	};

	const remove = async (row: UserRow) => {
		if (!window.confirm(`Delete ${row.email}? They are signed out at once.`)) return;
		const { error: failure } = await authClient.admin.removeUser({ userId: row.id });
		if (failure) return setError(authMessage(failure, 'Could not delete the account.'));
		await load();
	};

	const signOutEverywhere = async (row: UserRow) => {
		const { error: failure } = await authClient.admin.revokeUserSessions({ userId: row.id });
		if (failure) return setError(authMessage(failure, 'Could not sign them out.'));
		setCreated(`${row.email} was signed out everywhere.`);
	};

	return (
		<>
			<PageHead title="Users" lede="Who can sign in. Viewers read the dashboard; admins also manage accounts." />
			{error && <Notice kind="error">{error}</Notice>}
			{created && <Notice kind="ok">{created}</Notice>}
			<div className="grid grid-2 grid-top" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 26rem), 1fr))' }}>
				<Card title="Accounts">
					<ul className="list">
						{rows.map((row) => (
							<li key={row.id}>
								<div style={{ minWidth: 0 }}>
									<div>
										{row.name} {row.id === me.id && <span className="badge">You</span>}
									</div>
									<div className="sub">
										{row.email} · added {formatDateTime(new Date(row.createdAt).toISOString())}
									</div>
									<div className="row" style={{ marginTop: '0.3rem' }}>
										<span className={`badge ${row.role === 'admin' ? 'badge-ok' : ''}`}>{row.role === 'admin' ? 'Admin' : 'Viewer'}</span>
										<span className={`badge ${row.twoFactorEnabled ? 'badge-ok' : ''}`}>{row.twoFactorEnabled ? 'Authenticator on' : 'No authenticator'}</span>
									</div>
								</div>
								<span className="spacer" />
								{row.id !== me.id && (
									<div className="row">
										<select
											aria-label={`Role for ${row.email}`}
											value={row.role === 'admin' ? 'admin' : 'user'}
											onChange={(event) => changeRole(row, event.target.value as 'user' | 'admin')}
											style={{ width: 'auto', minHeight: '2rem', padding: '0.25rem 0.5rem' }}
										>
											<option value="user">Viewer</option>
											<option value="admin">Admin</option>
										</select>
										<button type="button" className="btn btn-sm" onClick={() => signOutEverywhere(row)}>
											Sign out
										</button>
										<button type="button" className="btn btn-sm btn-danger" onClick={() => remove(row)}>
											Delete
										</button>
									</div>
								)}
							</li>
						))}
					</ul>
				</Card>
				<Card title="Add an account">
					<form className="form" onSubmit={create}>
						<Field id="new-name" label="Name">
							<input id="new-name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={100} />
						</Field>
						<Field id="new-email" label="Email">
							<input id="new-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="off" />
						</Field>
						<Field id="new-password" label="Temporary password" hint="At least 12 characters. Share it privately.">
							<input id="new-password" type="password" minLength={12} value={password} onChange={(event) => setPassword(event.target.value)} required autoComplete="new-password" />
						</Field>
						<Field id="new-role" label="Role">
							<select id="new-role" value={role} onChange={(event) => setRole(event.target.value as 'user' | 'admin')}>
								<option value="user">Viewer: reads the dashboard</option>
								<option value="admin">Admin: also manages accounts</option>
							</select>
						</Field>
						<div>
							<button className="btn btn-primary" disabled={busy}>
								{busy ? 'Adding…' : 'Add account'}
							</button>
						</div>
					</form>
				</Card>
			</div>
		</>
	);
}
