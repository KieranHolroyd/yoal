import { useState, type FormEvent } from 'react';
import { authClient, authMessage } from '../auth-client.ts';
import { AuthLayout, Field, Notice } from '../components.tsx';

type Step = { kind: 'password' } | { kind: 'totp'; backup: boolean };

export function Login({ onSignedIn }: { onSignedIn: () => void }) {
	const [step, setStep] = useState<Step>({ kind: 'password' });
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const [code, setCode] = useState('');
	const [trustDevice, setTrustDevice] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const signIn = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		const { data, error: failure } = await authClient.signIn.email({ email: email.trim(), password });
		setBusy(false);
		if (failure) return setError(authMessage(failure, 'That email and password do not match an account.'));
		if (data && 'twoFactorRedirect' in data && data.twoFactorRedirect) {
			setPassword('');
			return setStep({ kind: 'totp', backup: false });
		}
		onSignedIn();
	};

	const verify = async (event: FormEvent) => {
		event.preventDefault();
		if (step.kind !== 'totp') return;
		setBusy(true);
		setError(null);
		const { error: failure } = step.backup
			? await authClient.twoFactor.verifyBackupCode({ code: code.trim(), trustDevice })
			: await authClient.twoFactor.verifyTotp({ code: code.replace(/\s/g, ''), trustDevice });
		setBusy(false);
		if (failure) return setError(authMessage(failure, 'That code did not work. Check it and try again.'));
		onSignedIn();
	};

	const passkey = async () => {
		setBusy(true);
		setError(null);
		const result = await authClient.signIn.passkey();
		setBusy(false);
		if (result?.error) return setError(authMessage(result.error, 'Passkey sign-in did not complete.'));
		onSignedIn();
	};

	if (step.kind === 'totp')
		return (
			<AuthLayout
				title="Two-step verification"
				lede={step.backup ? 'Enter one of the backup codes you saved when you set up your authenticator app.' : 'Enter the 6-digit code from your authenticator app.'}
			>
				<form className="form" onSubmit={verify}>
					{error && <Notice kind="error">{error}</Notice>}
					<Field id="code" label={step.backup ? 'Backup code' : 'Code'}>
						<input
							id="code"
							value={code}
							onChange={(event) => setCode(event.target.value)}
							autoComplete="one-time-code"
							inputMode={step.backup ? 'text' : 'numeric'}
							autoFocus
							required
						/>
					</Field>
					<label className="row" style={{ fontSize: '0.88rem' }}>
						<input type="checkbox" checked={trustDevice} onChange={(event) => setTrustDevice(event.target.checked)} style={{ width: 'auto', minHeight: 0 }} />
						Trust this device for 30 days
					</label>
					<button className="btn btn-primary" disabled={busy}>
						{busy ? 'Checking…' : 'Verify'}
					</button>
					<button
						type="button"
						className="link-btn"
						onClick={() => {
							setCode('');
							setError(null);
							setStep({ kind: 'totp', backup: !step.backup });
						}}
					>
						{step.backup ? 'Use your authenticator app instead' : 'Use a backup code instead'}
					</button>
				</form>
			</AuthLayout>
		);

	return (
		<AuthLayout
			title="Sign in"
			lede="The operator dashboard for anonymous usage pings from self-hosted Yoal installs."
			foot={
				<>
					Installs send pings to <code>/api/v1/ping</code>. The protocol is open source in the Yoal repository.
				</>
			}
		>
			<form className="form" onSubmit={signIn}>
				{error && <Notice kind="error">{error}</Notice>}
				<Field id="email" label="Email">
					<input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username webauthn" autoFocus required />
				</Field>
				<Field id="password" label="Password">
					<input id="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
				</Field>
				<button className="btn btn-primary" disabled={busy}>
					{busy ? 'Signing in…' : 'Sign in'}
				</button>
				<div className="divider">or</div>
				<button type="button" className="btn" onClick={passkey} disabled={busy}>
					Sign in with a passkey
				</button>
			</form>
		</AuthLayout>
	);
}
