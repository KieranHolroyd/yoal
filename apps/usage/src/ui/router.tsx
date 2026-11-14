import { createContext, useCallback, useContext, useEffect, useState, type MouseEvent, type ReactNode } from 'react';

/** A tiny pathname router: the server serves the same page for every dashboard path. */

interface RouterValue {
	path: string;
	search: URLSearchParams;
	navigate: (to: string, options?: { replace?: boolean }) => void;
}

const RouterContext = createContext<RouterValue | null>(null);

export function RouterProvider({ children }: { children: ReactNode }) {
	const [location, setLocation] = useState(() => ({ path: window.location.pathname, search: window.location.search }));
	useEffect(() => {
		const onPop = () => setLocation({ path: window.location.pathname, search: window.location.search });
		window.addEventListener('popstate', onPop);
		return () => window.removeEventListener('popstate', onPop);
	}, []);
	const navigate = useCallback((to: string, options: { replace?: boolean } = {}) => {
		const url = new URL(to, window.location.origin);
		if (options.replace) window.history.replaceState(null, '', url);
		else window.history.pushState(null, '', url);
		setLocation({ path: url.pathname, search: url.search });
		window.scrollTo(0, 0);
	}, []);
	return (
		<RouterContext.Provider value={{ path: location.path, search: new URLSearchParams(location.search), navigate }}>
			{children}
		</RouterContext.Provider>
	);
}

export function useRouter(): RouterValue {
	const value = useContext(RouterContext);
	if (!value) throw new Error('useRouter outside RouterProvider');
	return value;
}

export function Link({ to, children, className, ...rest }: { to: string; children: ReactNode; className?: string; 'aria-current'?: 'page' | undefined }) {
	const { navigate } = useRouter();
	const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
		event.preventDefault();
		navigate(to);
	};
	return (
		<a href={to} onClick={onClick} className={className} {...rest}>
			{children}
		</a>
	);
}
