interface Env {
	COMPANION_NAME: string;
}

/** Reached from function-suite as `env.COMPANION.fetch(...)` (a Yoal `app` binding). */
export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		return Response.json({
			ok: true,
			service: env.COMPANION_NAME,
			method: request.method,
			path: url.pathname,
			echo: request.method === 'GET' || request.method === 'HEAD' ? null : await request.text(),
			at: Date.now(),
		});
	},
} satisfies ExportedHandler<Env>;
