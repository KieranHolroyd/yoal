/** S4 lab topology: one bridge segment, every name `yoal-w0-s4-*`, no published host ports. */
const NET = '172.31.214';

export const LAB = {
	network: 'yoal-w0-s4-net',
	subnet: `${NET}.0/24`,
	domain: 's4.test',
	/** The ACME directory the ingresses and lego use (Pebble's TLS cert names `pebble`). */
	acme: 'https://pebble:14000/dir',
	pebble: { container: 'yoal-w0-s4-pebble', ip: `${NET}.10`, alias: 'pebble' },
	dns: { container: 'yoal-w0-s4-dns', ip: `${NET}.11` },
	haproxy: { container: 'yoal-w0-s4-haproxy', ip: `${NET}.20` },
	ingress: [
		{ name: 'ing-a', container: 'yoal-w0-s4-ing-a', ip: `${NET}.21` },
		{ name: 'ing-b', container: 'yoal-w0-s4-ing-b', ip: `${NET}.22` },
		{ name: 'ing-c', container: 'yoal-w0-s4-ing-c', ip: `${NET}.23` },
	],
	minio: { container: 'yoal-w0-s4-minio', ip: `${NET}.30`, alias: 'minio', user: 's4lab', pass: 's4lab-not-a-secret', bucket: 's4-certs' },
	cp: { container: 'yoal-w0-s4-cp', ip: `${NET}.40`, alias: 'cp' },
	client: { container: 'yoal-w0-s4-client', ip: `${NET}.50` },
	images: {
		pebble: 'ghcr.io/letsencrypt/pebble:2.10.3@sha256:0c81f05db371f436c97fb894bd6d2ab8fc9c8e2ce40f8bef8a8e15941bcd75ef',
		challtestsrv: 'ghcr.io/letsencrypt/pebble-challtestsrv:2.10.3@sha256:0152c8cb506e2ecba2900ed47d23932e27e3e6575a7d2c8ef93c7719ee3dea4c',
		haproxy: 'haproxy:3.4.8-alpine',
		bun: 'oven/bun:1.4.4-alpine',
		// MinIO no longer publishes images (see spikes/s3-cas/stores/minio.Dockerfile on ha/w0-spike-s3);
		// this is the last community image, as spike S2 pinned it.
		minio: 'quay.io/minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e',
		ingressLock: 'yoal-w0-s4-ingress:lock',
		ingressNoLock: 'yoal-w0-s4-ingress:nolock',
		cp: 'yoal-w0-s4-cp',
	},
} as const;

/** Paths as seen inside the containers. */
export const IN = {
	rig: '/rig',
	shared: '/etc/s4-shared', // pebble-ca.pem (Pebble's API root, not a secret)
	node: '/etc/s4', // per-ingress caddy.json
	out: '/out',
} as const;
