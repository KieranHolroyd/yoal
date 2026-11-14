import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { renderSVG } from 'uqr';
import { formatDateTime, relativeTime, type SessionState } from '../api.ts';
import { authClient, authMessage } from '../auth-client.ts';
import { Card, Field, Notice, PageHead } from '../components.tsx';

/**
 * Account: second factor (authenticator app, passkeys), password and sessions. A person without a
 * second factor lands here and sees nothing else until they enrol one.
 */
export function Account({ session, onChanged }: { session: SessionState; onChanged: () => void }) {
	const user = session.user!;
	return (
		<>
			<PageHead title="Account" lede={`${user.name} · ${user.email} · ${user.role === 'admin' ? 'Admin' : 'Viewer'}`} />
			{!session.secondFactor && (
				<Notice kind="warn">
					Set up a second factor to see the dashboard: an authenticator app or a passkey. Accounts with only a password cannot read usage data.
				</Notice>
			)}
			<div className="grid grid-2 grid-top">
				<Authenticator enabled={user.twoFactorEnabled} onChanged={onChanged} />
				<Passkeys onChanged={onChanged} />
				<PasswordCard />
				<Sessions />
			</div>
		</>
	);
}

type Enrolment = { stage: 'idle' } | { stage: 'password'; action: 'enable' | 'disable' | 'codes' } | { stage: 'scan'; uri: string; codes: string[] } | { stage: 'codes'; codes: string[] };

function Authenticator({ enabled, onChanged }: { enabled: boolean; onChanged: () => void }) {
	const [state, setState] = useState<Enrolment>({ stage: 'idle' });
	const [password, setPassword] = useState('');
	const [code, setCode] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const reset = () => {
		setPassword('');
		setCode('');
		setError(null);
	};

	const confirmPassword = async (event: FormEvent) => {
		event.preventDefault();
		if (state.stage !== 'password') return;
		setBusy(true);
		setError(null);
		if (state.action === 'enable') {
			const { data, error: failure } = await authClient.twoFactor.enable({ password });
			setBusy(false);
			if (failure || !data || !('totpURI' in data)) return setError(authMessage(failure, 'Could not start set-up. Check your password.'));
			reset();
			setState({ stage: 'scan', uri: data.totpURI, codes: data.backupCodes });
		} else if (state.action === 'disable') {
			const { error: failure } = await authClient.twoFactor.disable({ password });
			setBusy(false);
			if (failure) return setError(authMessage(failure, 'Could not turn it off. Check your password.'));
			reset();
			setState({ stage: 'idle' });
			onChanged();
		} else {
			const { data, error: failure } = await authClient.twoFactor.generateBackupCodes({ password });
			setBusy(false);
			if (failure || !data) return setError(authMessage(failure, 'Could not make new codes. Check your password.'));
			reset();
			setState({ stage: 'codes', codes: data.backupCodes });
		}
	};

	const verify = async (event: FormEvent) => {
		event.preventDefault();
		if (state.stage !== 'scan') return;
		setBusy(true);
		setError(null);
		const { error: failure } = await authClient.twoFactor.verifyTotp({ code: code.replace(/\s/g, '') });
		setBusy(false);
		if (failure) return setError(authMessage(failure, 'That code did not work. Codes change every 30 seconds.'));
		const codes = state.codes;
		reset();
		setState({ stage: 'codes', codes });
		onChanged();
	};

	const qr = useMemo(() => (state.stage === 'scan' ? renderSVG(state.uri, { border: 1 }) : ''), [state]);
	const secret = state.stage === 'scan' ? (new URL(state.uri).searchParams.get('secret') ?? '') : '';

	return (
		<Card title="Authenticator app" actions={enabled ? <span className="badge badge-ok">On</span> : <span className="badge">Off</span>}>
			{error && (
				<div style={{ marginBottom: '0.8rem' }}>
					<Notice kind="error">{error}</Notice>
				</div>
			)}
			{state.stage === 'idle' && (
				<div className="form">
					<p style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>
						{enabled ? 'Sign-in asks for a 6-digit code from your authenticator app.' : 'Use an app such as 1Password, Bitwarden or Google Authenticator for a 6-digit code at sign-in.'}
					</p>
					<div className="row">
						{enabled ? (
							<>
								<button type="button" className="btn" onClick={() => setState({ stage: 'password', action: 'codes' })}>
									New backup codes
								</button>
								<button type="button" className="btn btn-danger" onClick={() => setState({ stage: 'password', action: 'disable' })}>
									Turn off
								</button>
							</>
						) : (
							<button type="button" className="btn btn-primary" onClick={() => setState({ stage: 'password', action: 'enable' })}>
								Set up
							</button>
						)}
					</div>
				</div>
			)}
			{state.stage === 'password' && (
				<form className="form" onSubmit={confirmPassword}>
					<Field id="totp-password" label="Confirm your password">
						<input id="totp-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" autoFocus required />
					</Field>
					<div className="row">
						<button className="btn btn-primary" disabled={busy}>
							Continue
						</button>
						<button type="button" className="btn btn-ghost" onClick={() => (reset(), setState({ stage: 'idle' }))}>
							Cancel
						</button>
					</div>
				</form>
			)}
			{state.stage === 'scan' && (
				<form className="form" onSubmit={verify}>
					<p style={{ fontSize: '0.9rem' }}>Scan this with your authenticator app, then enter the code it shows.</p>
					<div className="qr" aria-label="QR code for your authenticator app" role="img" dangerouslySetInnerHTML={{ __html: qr }} />
					<p style={{ fontSize: '0.82rem', color: 'var(--muted)' }}>
						Can't scan? Enter this key: <code style={{ wordBreak: 'break-all' }}>{secret}</code>
					</p>
					<Field id="totp-code" label="Code">
						<input id="totp-code" value={code} onChange={(event) => setCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" required />
					</Field>
					<div className="row">
						<button className="btn btn-primary" disabled={busy}>
							Turn on
						</button>
						<button type="button" className="btn btn-ghost" onClick={() => (reset(), setState({ stage: 'idle' }))}>
							Cancel
						</button>
					</div>
				</form>
			)}
			{state.stage === 'codes' && (
				<div className="form">
					<Notice kind="ok">Save these backup codes somewhere safe. Each one works once if you lose your device. They are not shown again.</Notice>
					<div className="codes">
						{state.codes.map((value) => (
							<span key={value}>{value}</span>
						))}
					</div>
					<div className="row">
						<button type="button" className="btn" onClick={() => navigator.clipboard?.writeText(state.codes.join('\n'))}>
							Copy
						</button>
						<button type="button" className="btn btn-primary" onClick={() => setState({ stage: 'idle' })}>
							Done
						</button>
					</div>
				</div>
			)}
		</Card>
	);
}

interface PasskeyRow {
	id: string;
	name?: string | null;
	createdAt: string | Date;
	deviceType?: string;
}

function Passkeys({ onChanged }: { onChanged: () => void }) {
	const [rows, setRows] = useState<PasskeyRow[]>([]);
	const [name, setName] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const load = useCallback(async () => {
		const { data } = await authClient.passkey.listUserPasskeys();
		setRows((data as PasskeyRow[] | null) ?? []);
	}, []);
	useEffect(() => {
		void load();
	}, [load]);

	const add = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		const result = await authClient.passkey.addPasskey({ name: name.trim() || undefined });
		setBusy(false);
		if (result?.error) return setError(authMessage(result.error, 'The passkey was not added.'));
		setName('');
		await load();
		onChanged();
	};

	const remove = async (id: string) => {
		if (!window.confirm('Remove this passkey? You will not be able to sign in with it.')) return;
		const { error: failure } = await authClient.passkey.deletePasskey({ id });
		if (failure) return setError(authMessage(failure, 'Could not remove it.'));
		await load();
		onChanged();
	};

	return (
		<Card title="Passkeys" actions={<span className={`badge ${rows.length ? 'badge-ok' : ''}`}>{rows.length}</span>}>
			{error && (
				<div style={{ marginBottom: '0.8rem' }}>
					<Notice kind="error">{error}</Notice>
				</div>
			)}
			{rows.length > 0 && (
				<ul className="list" style={{ marginBottom: '0.9rem' }}>
					{rows.map((row) => (
						<li key={row.id}>
							<div>
								<div>{row.name || 'Passkey'}</div>
								<div className="sub">Added {formatDateTime(new Date(row.createdAt).toISOString())}</div>
							</div>
							<span className="spacer" />
							<button type="button" className="btn btn-sm btn-danger" onClick={() => remove(row.id)}>
								Remove
							</button>
						</li>
					))}
				</ul>
			)}
			<form className="form" onSubmit={add}>
				<p style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>Sign in with Touch ID, Windows Hello, your phone or a security key. A passkey also counts as your second factor.</p>
				<div className="row">
					<input aria-label="Passkey name" placeholder="Name, e.g. MacBook" value={name} onChange={(event) => setName(event.target.value)} style={{ flex: 1, minWidth: '10rem' }} maxLength={60} />
					<button className="btn btn-primary" disabled={busy}>
						Add passkey
					</button>
				</div>
			</form>
		</Card>
	);
}

function PasswordCard() {
	const [current, setCurrent] = useState('');
	const [next, setNext] = useState('');
	const [confirm, setConfirm] = useState('');
	const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
	const [busy, setBusy] = useState(false);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (next !== confirm) return setMessage({ kind: 'error', text: 'The new passwords do not match.' });
		setBusy(true);
		const { error } = await authClient.changePassword({ currentPassword: current, newPassword: next, revokeOtherSessions: true });
		setBusy(false);
		if (error) return setMessage({ kind: 'error', text: authMessage(error, 'Could not change the password.') });
		setCurrent('');
		setNext('');
		setConfirm('');
		setMessage({ kind: 'ok', text: 'Password changed. Your other sessions were signed out.' });
	};

	return (
		<Card title="Password">
			<form className="form" onSubmit={submit}>
				{message && <Notice kind={message.kind}>{message.text}</Notice>}
				<Field id="current-password" label="Current password">
					<input id="current-password" type="password" value={current} onChange={(event) => setCurrent(event.target.value)} autoComplete="current-password" required />
				</Field>
				<Field id="new-password" label="New password" hint="At least 12 characters.">
					<input id="new-password" type="password" minLength={12} value={next} onChange={(event) => setNext(event.target.value)} autoComplete="new-password" required />
				</Field>
				<Field id="confirm-password" label="Confirm new password">
					<input id="confirm-password" type="password" minLength={12} value={confirm} onChange={(event) => setConfirm(event.target.value)} autoComplete="new-password" required />
				</Field>
				<div>
					<button className="btn btn-primary" disabled={busy}>
						Change password
					</button>
				</div>
			</form>
		</Card>
	);
}

interface SessionRow {
	id: string;
	token: string;
	createdAt: string | Date;
	updatedAt: string | Date;
	userAgent?: string | null;
	ipAddress?: string | null;
}

function describeAgent(agent: string | null | undefined): string {
	if (!agent) return 'Unknown device';
	const browser = /Edg\//.test(agent) ? 'Edge' : /Chrome\//.test(agent) ? 'Chrome' : /Firefox\//.test(agent) ? 'Firefox' : /Safari\//.test(agent) ? 'Safari' : 'Browser';
	const os = /Mac OS X/.test(agent) ? 'macOS' : /Windows/.test(agent) ? 'Windows' : /Android/.test(agent) ? 'Android' : /iPhone|iPad/.test(agent) ? 'iOS' : /Linux/.test(agent) ? 'Linux' : '';
	return os ? `${browser} on ${os}` : browser;
}

function Sessions() {
	const [rows, setRows] = useState<SessionRow[]>([]);
	const current = authClient.useSession();
	const load = useCallback(async () => {
		const { data } = await authClient.listSessions();
		setRows(((data as SessionRow[] | null) ?? []).sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt)));
	}, []);
	useEffect(() => {
		void load();
	}, [load]);
	const currentToken = current.data?.session.token;

	return (
		<Card
			title="Sessions"
			actions={
				rows.length > 1 && (
					<button type="button" className="btn btn-sm" onClick={async () => (await authClient.revokeOtherSessions(), load())}>
						Sign out others
					</button>
				)
			}
		>
			<ul className="list">
				{rows.map((row) => (
					<li key={row.id}>
						<div>
							<div>
								{describeAgent(row.userAgent)} {row.token === currentToken && <span className="badge badge-ok">This device</span>}
							</div>
							<div className="sub">
								Active {relativeTime(new Date(row.updatedAt).toISOString())} · signed in {formatDateTime(new Date(row.createdAt).toISOString())}
							</div>
						</div>
						<span className="spacer" />
						{row.token !== currentToken && (
							<button type="button" className="btn btn-sm" onClick={async () => (await authClient.revokeSession({ token: row.token }), load())}>
								Sign out
							</button>
						)}
					</li>
				))}
			</ul>
		</Card>
	);
}
