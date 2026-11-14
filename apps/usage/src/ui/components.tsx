import type { ReactNode } from 'react';
import type { SessionState } from './api.ts';
import { authClient } from './auth-client.ts';
import logo from './logo.svg';
import { Link, useRouter } from './router.tsx';

export function Logo({ className }: { className?: string }) {
	return <img src={logo} alt="" className={className} width={28} height={28} />;
}

export function Notice({ kind, children }: { kind: 'error' | 'ok' | 'warn'; children: ReactNode }) {
	return (
		<div className={`notice notice-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
			{children}
		</div>
	);
}

export function Card({ title, note, actions, children, className }: { title?: string; note?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
	return (
		<section className={`card ${className ?? ''}`}>
			{(title || actions) && (
				<div className="card-head">
					<div>
						{title && <h2>{title}</h2>}
						{note && <p>{note}</p>}
					</div>
					{actions}
				</div>
			)}
			{children}
		</section>
	);
}

export function Field({ label, hint, children, id }: { label: string; hint?: ReactNode; children: ReactNode; id: string }) {
	return (
		<div className="field">
			<label htmlFor={id}>{label}</label>
			{children}
			{hint && <span className="hint">{hint}</span>}
		</div>
	);
}

export function AuthLayout({ title, lede, children, foot }: { title: string; lede?: ReactNode; children: ReactNode; foot?: ReactNode }) {
	return (
		<main className="auth-wrap">
			<div className="card auth-card">
				<div className="auth-brand">
					<Logo />
					<span>Yoal Analytics</span>
				</div>
				<h1>{title}</h1>
				{lede && <p className="lede">{lede}</p>}
				{children}
				{foot && <p className="auth-foot">{foot}</p>}
			</div>
		</main>
	);
}

const NAV = [
	{ to: '/', label: 'Overview' },
	{ to: '/installs', label: 'Installs' },
	{ to: '/users', label: 'Users', admin: true },
	{ to: '/account', label: 'Account' }
];

export function Shell({ session, children, onSignedOut }: { session: SessionState; children: ReactNode; onSignedOut: () => void }) {
	const { path } = useRouter();
	const user = session.user!;
	const signOut = async () => {
		await authClient.signOut();
		onSignedOut();
	};
	return (
		<div className="shell">
			<header className="topbar">
				<div className="topbar-inner">
					<Link to="/" className="brand">
						<Logo />
						<span>
							Yoal <small>Analytics</small>
						</span>
					</Link>
					<nav className="nav" aria-label="Main">
						{NAV.filter((item) => !item.admin || user.role === 'admin').map((item) => (
							<Link key={item.to} to={item.to} aria-current={path === item.to ? 'page' : undefined}>
								{item.label}
							</Link>
						))}
					</nav>
					<div className="who">
						<span className="email">{user.email}</span>
						<button type="button" className="btn btn-sm" onClick={signOut}>
							Sign out
						</button>
					</div>
				</div>
			</header>
			<main className="main">{children}</main>
		</div>
	);
}

export function PageHead({ title, lede, actions }: { title: string; lede?: ReactNode; actions?: ReactNode }) {
	return (
		<div className="page-head">
			<div>
				<h1>{title}</h1>
				{lede && <p>{lede}</p>}
			</div>
			{actions}
		</div>
	);
}

export function Segmented<T extends string | number>({ value, options, onChange, label }: { value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void; label: string }) {
	return (
		<div className="segmented" role="group" aria-label={label}>
			{options.map((option) => (
				<button key={String(option.value)} type="button" aria-pressed={option.value === value} onClick={() => onChange(option.value)}>
					{option.label}
				</button>
			))}
		</div>
	);
}
