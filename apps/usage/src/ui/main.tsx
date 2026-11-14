import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getJson, type SessionState } from './api.ts';
import { Shell } from './components.tsx';
import { Account } from './pages/Account.tsx';
import { Installs } from './pages/Installs.tsx';
import { Login } from './pages/Login.tsx';
import { Overview } from './pages/Overview.tsx';
import { Setup } from './pages/Setup.tsx';
import { Users } from './pages/Users.tsx';
import { RouterProvider, useRouter } from './router.tsx';

/**
 * The gate: setup first (no account exists), then sign-in, then a second factor. Only a person
 * with all three sees data. The server enforces the same rules on every data route; this only
 * decides which screen to show.
 */
function App() {
	const { path, navigate } = useRouter();
	const [session, setSession] = useState<SessionState | null>(null);
	const [failed, setFailed] = useState(false);

	const refresh = useCallback(async () => {
		try {
			setSession(await getJson<SessionState>('/api/v1/session'));
			setFailed(false);
		} catch {
			setFailed(true);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	useEffect(() => {
		if (!session) return;
		if (session.setupRequired) {
			if (path !== '/setup') navigate('/setup', { replace: true });
		} else if (!session.user) {
			if (path !== '/login') navigate('/login', { replace: true });
		} else if (!session.secondFactor) {
			if (path !== '/account') navigate('/account', { replace: true });
		} else if (path === '/login' || path === '/setup' || (path === '/users' && session.user.role !== 'admin')) {
			navigate('/', { replace: true });
		}
	}, [session, path, navigate]);

	const onUnauthorized = useCallback(() => void refresh(), [refresh]);

	if (failed)
		return (
			<main className="auth-wrap">
				<p className="empty">
					The dashboard could not reach its server.{' '}
					<button type="button" className="link-btn" onClick={() => void refresh()}>
						Try again
					</button>
				</p>
			</main>
		);
	if (!session) return null;
	if (session.setupRequired) return <Setup onDone={refresh} />;
	if (!session.user) return <Login onSignedIn={refresh} />;

	const onSignedOut = () => {
		setSession({ setupRequired: false, user: null, secondFactor: false });
		navigate('/login', { replace: true });
	};

	let page;
	if (!session.secondFactor || path === '/account') page = <Account session={session} onChanged={refresh} />;
	else if (path === '/installs') page = <Installs onUnauthorized={onUnauthorized} />;
	else if (path === '/users' && session.user.role === 'admin') page = <Users session={session} />;
	else page = <Overview onUnauthorized={onUnauthorized} />;

	return (
		<Shell session={session} onSignedOut={onSignedOut}>
			{page}
		</Shell>
	);
}

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<RouterProvider>
			<App />
		</RouterProvider>
	</StrictMode>
);
