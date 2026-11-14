import { useState, type FormEvent } from 'react';
import { ApiError, postJson } from '../api.ts';
import { authClient } from '../auth-client.ts';
import { AuthLayout, Field, Notice } from '../components.tsx';

const ERRORS: Record<string, string> = {
	invalid_setup_token: 'That setup token is not right. Copy it again from the app logs.',
	already_set_up: 'Someone has already set this dashboard up. Sign in instead.',
	weak_password: 'Use a password of at least 12 characters.',
	invalid_setup: 'Check the fields: a name, a valid email and a password of at least 12 characters.',
	rate_limited: 'Too many attempts. Wait a minute and try again.',
	cross_origin: 'Open this page from the dashboard address itself.'
};

export function Setup({ onDone }: { onDone: () => void }) {
	const [token, setToken] = useState('');
	const [name, setName] = useState('');
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const [confirm, setConfirm] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (password !== confirm) return setError('The two passwords do not match.');
		setBusy(true);
		setError(null);
		try {
			await postJson('/api/v1/setup', { token: token.trim(), name, email, password });
			await authClient.signIn.email({ email: email.trim(), password });
			onDone();
		} catch (failure) {
			setError(failure instanceof ApiError ? (ERRORS[failure.code] ?? 'Setup failed. Try again.') : 'Setup failed. Try again.');
			setBusy(false);
		}
	};

	return (
		<AuthLayout
			title="Set up the dashboard"
			lede={
				<>
					Create the first admin account. The setup token is in the app's logs (<code>yoal logs yoal-analytics-engine</code>), and stops
					working once this account exists.
				</>
			}
			foot="You will set up a second factor next: an authenticator app or a passkey."
		>
			<form className="form" onSubmit={submit}>
				{error && <Notice kind="error">{error}</Notice>}
				<Field id="token" label="Setup token">
					<input id="token" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" spellCheck={false} className="mono" required />
				</Field>
				<Field id="name" label="Your name">
					<input id="name" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" required />
				</Field>
				<Field id="email" label="Email">
					<input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" required />
				</Field>
				<Field id="password" label="Password" hint="At least 12 characters.">
					<input id="password" type="password" minLength={12} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" required />
				</Field>
				<Field id="confirm" label="Confirm password">
					<input id="confirm" type="password" minLength={12} value={confirm} onChange={(event) => setConfirm(event.target.value)} autoComplete="new-password" required />
				</Field>
				<button className="btn btn-primary" disabled={busy}>
					{busy ? 'Creating…' : 'Create admin account'}
				</button>
			</form>
		</AuthLayout>
	);
}
