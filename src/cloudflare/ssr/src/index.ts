/**
 * Cloudflare Worker fronting the Maple Hosted production domain
 * (`mapleaperture.com`) — see the production-blocker writeup at `#2474`.
 *
 * The origin is `dist/maple-syrup/browser` uploaded to Azure Blob Storage
 * by `.github/workflows/deploy-hosted.yml` (`hornbeam/mapleaperture`). This
 * Worker's entire job is: fetch the requested object from that origin,
 * stream it back byte-for-byte with the right status/headers, fall back to
 * `index.html` only for a real single-page-app navigation, and apply the
 * production security policy (`security-headers.ts`) — see that ticket for
 * the concrete list of things the previous, un-source-controlled Worker got
 * wrong (decoded every response as text, corrupting binary assets; served
 * `index.html` for `/raw_wasm_bg.wasm`; forced every status to 200; stamped
 * a one-year immutable cache policy onto stable-named files; omitted
 * COOP/COEP).
 *
 * Flow:
 *   1. Fetch the requested path from the origin. Never call `.text()` or
 *      otherwise decode the body — proxy the `ReadableStream` straight
 *      through.
 *   2. Origin 404 + the request is an HTML navigation -> SPA fallback:
 *      re-fetch `/index.html` from the origin and serve it with status 200.
 *   3. Origin 404 + not a navigation (a missing JS chunk, a stale asset
 *      path, ...) -> pass the real 404 through untouched.
 *   4. Any other status -> pass it through untouched, with the origin's own
 *      `Content-Type` and `Cache-Control` preserved (this Worker never
 *      invents a cache policy) except `.wasm`, which is forced to
 *      `application/wasm` regardless of what the origin reports.
 *   5. Every response gets the production security headers.
 */

import { buildResponseHeaders } from './security-headers';

const WASM_CONTENT_TYPE = 'application/wasm';

function isNavigationRequest(request: Request): boolean {
	if (request.headers.get('sec-fetch-mode') === 'navigate') return true;
	// Fallback for clients that don't send Sec-Fetch-Mode (older browsers,
	// curl, the smoke-check script): a navigation asks for HTML first.
	const accept = request.headers.get('accept') ?? '';
	return accept.includes('text/html');
}

function originTarget(originBaseUrl: string, pathname: string, search = ''): URL {
	const base = new URL(originBaseUrl);
	// Azure's container path (e.g. "/mapleaperture") is the base URL's own
	// pathname — append the requested path onto it rather than replacing it.
	const basePath = base.pathname.endsWith('/') ? base.pathname.slice(0, -1) : base.pathname;
	base.pathname = `${basePath}${pathname}`;
	base.search = search;
	return base;
}

async function fetchOrigin(
	originBaseUrl: string,
	request: Request,
	pathname: string,
	search: string,
) {
	const target = originTarget(originBaseUrl, pathname, search);
	return fetch(target.toString(), { method: request.method, headers: request.headers });
}

function withWasmContentType(headers: Headers, pathname: string): Headers {
	if (pathname.endsWith('.wasm')) headers.set('Content-Type', WASM_CONTENT_TYPE);
	return headers;
}

async function spaFallback(originBaseUrl: string, request: Request): Promise<Response> {
	const indexResponse = await fetchOrigin(originBaseUrl, request, '/index.html', '');
	const headers = buildResponseHeaders(indexResponse.headers);
	headers.set('Content-Type', 'text/html; charset=utf-8');
	// index.html names the current build's hashed bundles, so a cached copy
	// would strand a returning client on a stale deploy — never cache it,
	// same rule the upload step in deploy-hosted.yml applies at the origin.
	headers.set('Cache-Control', 'no-cache');
	return new Response(indexResponse.body, { status: 200, headers });
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		const originResponse = await fetchOrigin(
			env.ORIGIN_BASE_URL,
			request,
			url.pathname,
			url.search,
		);

		if (originResponse.status === 404 && isNavigationRequest(request)) {
			return spaFallback(env.ORIGIN_BASE_URL, request);
		}

		const headers = withWasmContentType(buildResponseHeaders(originResponse.headers), url.pathname);
		return new Response(originResponse.body, {
			status: originResponse.status,
			statusText: originResponse.statusText,
			headers,
		});
	},
} satisfies ExportedHandler<Env>;
