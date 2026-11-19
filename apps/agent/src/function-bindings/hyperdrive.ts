import { capnpText } from '../function-config.ts';
import type { BindingRenderer } from './types.ts';

/**
 * Hyperdrive (docs/FUNCTIONS.md §4.5): workerd's native `hyperdrive` binding pointed at the
 * attached database's direct Postgres loopback port.
 *
 * Not PgBouncer: workerd's Hyperdrive client never sends an SSLRequest, and the pooler requires
 * client TLS (`client_tls_sslmode = require`), so every query failed with "SSL required". Postgres
 * itself takes a password login without TLS on this host-local hop. The pooler is only a fallback
 * for an env that carries no direct values.
 *
 * **This config carries credentials.** workerd's Hyperdrive binding has no `fromEnvironment` form,
 * so user/password/database must be literals in the capnp text. The rendered config therefore
 * travels to the helper as a 0600 systemd credential (`LoadCredential=function-config:…`) and is
 * never cached as a release artifact or persisted in desired state — an intentional, documented
 * phase-2 exception to "config has no secrets". The values arrive only through the activation env
 * of an attached database (`<PREFIX>_POOL_HOST`, `<PREFIX>_USER`, …).
 */
export const renderHyperdrive: BindingRenderer = ({ binding, env, index }) => {
	if (binding.type !== 'hyperdrive')
		throw new Error(
			`Hyperdrive renderer received binding "${binding.name}" of type "${binding.type}", not "hyperdrive".`,
		);

	const prefix = binding.envPrefix;
	const pick = (...names: string[]): string | undefined => {
		for (const name of names) {
			const value = env[name];
			if (value !== undefined && value !== '') return value;
		}
		return undefined;
	};
	// The direct values; the pooler only when an env has nothing else (see above).
	const host = pick(`${prefix}_HOST`, `${prefix}_POOL_HOST`);
	const port = pick(`${prefix}_PORT`, `${prefix}_POOL_PORT`);
	const user = pick(`${prefix}_USER`);
	const password = pick(`${prefix}_PASSWORD`);
	const database = pick(`${prefix}_NAME`);

	const missing = [
		...(host === undefined ? [`${prefix}_HOST`] : []),
		...(port === undefined ? [`${prefix}_PORT`] : []),
		...(user === undefined ? [`${prefix}_USER`] : []),
		...(password === undefined ? [`${prefix}_PASSWORD`] : []),
		...(database === undefined ? [`${prefix}_NAME`] : []),
	];
	if (missing.length > 0)
		throw new Error(
			`Hyperdrive binding "${binding.name}" cannot be rendered: the activation env is missing ${missing.join(', ')}. ` +
				`Attach the database to this project (prefix ${prefix}) and deploy again.`,
		);

	// The activation env names a loopback port for every non-container runtime; validate it before
	// it becomes a capnp address rather than letting workerd fail at startup.
	if (!/^[0-9]{1,5}$/.test(port!) || Number(port) < 1 || Number(port) > 65_535)
		throw new Error(
			`Hyperdrive binding "${binding.name}" has an invalid ${prefix}_PORT "${port}": expected a port between 1 and 65535.`,
		);

	const serviceName = `hyperdrive-${index}`;
	const address = `127.0.0.1:${Number(port)}`;
	return {
		files: {},
		services: [
			[
				`    ( name = ${capnpText(serviceName)},`,
				`      external = ( address = ${capnpText(address)}, tcp = () ) )`,
			].join('\n'),
		],
		mainBindings: [
			`        ( name = ${capnpText(binding.name)}, hyperdrive = ( designator = ${capnpText(serviceName)}, ` +
				`database = ${capnpText(database!)}, user = ${capnpText(user!)}, ` +
				`password = ${capnpText(password!)}, scheme = "postgres" ) )`,
		],
	};
};
