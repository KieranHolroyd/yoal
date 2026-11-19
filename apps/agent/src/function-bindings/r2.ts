import type { BindingRenderer, RenderedBinding } from './types.ts';
import { capnpText } from '../function-config.ts';
import r2WorkerSource from '../../../../packages/function-bindings/src/r2.js' with { type: 'text' };

/** Helper credential name the R2 service module is embedded as (fixed contract with the helper). */
export const R2_BINDING_FILE = 'binding-r2';

/** Activation env suffixes the attachment injects (docs/OBJECT-STORAGE.md, D66). */
const R2_ENV_SUFFIXES = ['ENDPOINT_URL', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY', 'REGION', 'FORCE_PATH_STYLE'] as const;

/**
 * Phase-2 R2: one Yoal-supplied Worker service per binding, backed by an attached RustFS instance
 * over the S3 API (docs/FUNCTIONS.md §4.5, D66, FN10).
 *
 * The main Worker only gets the `r2Bucket` capability binding. The service is the authority for
 * which bucket and key prefix it may touch (`BUCKET_NAME`, `KEY_PREFIX`) and gets its S3 endpoint
 * and scoped credentials from the activation env, so the rendered config carries no secret values
 * and can live in the release cache.
 */
export const renderR2Binding: BindingRenderer = (context) => {
	const { binding, index, workload, env } = context;
	if (binding.type !== 'r2') {
		throw new Error(
			`R2 renderer received binding "${binding.name}" of type "${binding.type}", not "r2".`,
		);
	}
	const spec = workload.function;
	if (!spec) {
		throw new Error(`Cannot render an R2 binding for workload ${workload.id}: it has no function spec.`);
	}

	const prefix = binding.envPrefix;
	const serviceName = `r2-api-${index}`;
	// The attachment's S3 endpoint is a loopback port on this node (managed RustFS). The R2 worker
	// would otherwise reach it through the default `internet` network service, which refuses
	// private addresses, so every R2 call failed. Give it the endpoint as its only outbound.
	const s3Address = loopbackHttpAddress(env?.[`${prefix}_ENDPOINT_URL`]);
	const s3ServiceName = `r2-s3-${index}`;
	const service = [
		`    ( name = ${capnpText(serviceName)},`,
		'      worker = (',
		'        modules = [',
		`          ( name = "r2.worker", esModule = embed ${capnpText(R2_BINDING_FILE)} ),`,
		'        ],',
		`        compatibilityDate = ${capnpText(spec.compatibilityDate)},`,
		'        compatibilityFlags = [],',
		'        bindings = [',
		// The attachment's injected S3 settings (D66). `fromEnvironment` keeps the secret out of the
		// config; the service derives the prefix from whichever `<PREFIX>_ENDPOINT_URL` it receives.
		...R2_ENV_SUFFIXES.map(
			(suffix) =>
				`          ( name = ${capnpText(`${prefix}_${suffix}`)}, fromEnvironment = ${capnpText(`${prefix}_${suffix}`)} ),`,
		),
		`          ( name = "BUCKET_NAME", text = ${capnpText(binding.bucket)} ),`,
		`          ( name = "KEY_PREFIX", text = ${capnpText(binding.prefix ?? '')} ),`,
		'        ],',
		...(s3Address ? [`        globalOutbound = ${capnpText(s3ServiceName)},`] : []),
		'      ) ),',
	].join('\n');
	const s3Service = s3Address
		? `    ( name = ${capnpText(s3ServiceName)},\n      external = ( address = ${capnpText(s3Address)}, http = () ) )`
		: null;

	const rendered: RenderedBinding = {
		files: { [R2_BINDING_FILE]: r2WorkerSource },
		services: s3Service ? [service, s3Service] : [service],
		mainBindings: [
			`        ( name = ${capnpText(binding.name)}, r2Bucket = ${capnpText(serviceName)} )`,
		],
		requiresDurableStorage: false,
		namespaces: [],
	};
	return rendered;
};

/**
 * `http://127.0.0.1:19001` → `127.0.0.1:19001`. Only plain-HTTP loopback endpoints become an
 * `external` service; anything else (a public HTTPS endpoint, or none yet) keeps the default
 * outbound, so the binding never gains a private capability the control plane did not issue.
 */
function loopbackHttpAddress(endpoint: string | undefined): string | null {
	if (!endpoint) return null;
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return null;
	}
	if (url.protocol !== 'http:' || !url.port) return null;
	const host = url.hostname.replace(/^\[|\]$/g, '');
	if (!/^127(?:\.\d{1,3}){3}$/.test(host) && host !== 'localhost' && host !== '::1') return null;
	return `${host === '::1' ? '[::1]' : host}:${url.port}`;
}
