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
 *   1. Fetch the requested path from the origin, cloning the incoming
 *      request's method/headers/body via `new Request(target, request)`
 *      (same pattern as the sibling thumbnail-cache Worker) rather than
 *      hand-picking a subset of request init — never call `.text()` or
 *      otherwise decode the body, proxy the `ReadableStream` straight
 *      through. Query strings are intentionally dropped: Azure Blob
 *      Storage's REST API treats certain query keys (`sig`, `comp`, ...) as
 *      commands, so an innocuous tracking parameter that collides with one
 *      could turn a should-be-404 into a 400/403 that never reaches the SPA
 *      fallback below. The served content is a static build with no
 *      per-query variation, so nothing is lost by not forwarding it —
 *      Angular's router still sees the full URL client-side.
 *   2. Origin 404 + the request is an HTML navigation -> SPA fallback:
 *      re-fetch `/index.html` from the origin with a fresh, header-free
 *      request (deliberately not the original request's headers — see
 *      `spaFallback`'s doc comment for why) and serve it with status 200.
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

/** Headers that make sense on a browser->Worker request but have no
 * business reaching a static, unauthenticated Azure Blob Storage origin —
 * session/auth material and client-identifying data that would otherwise
 * leak into Azure's own request logs for no operational benefit. */
const STRIPPED_REQUEST_HEADERS = [
	'cookie',
	'authorization',
	'x-forwarded-for',
	'cf-connecting-ip',
	'cf-ipcountry',
	'cf-ray',
];

function isNavigationRequest(request: Request): boolean {
	if (request.headers.get('sec-fetch-mode') === 'navigate') return true;
	// Fallback for clients that don't send Sec-Fetch-Mode (older browsers,
	// curl, the smoke-check script): a navigation asks for HTML first.
	const accept = request.headers.get('accept') ?? '';
	return accept.includes('text/html');
}

function originTarget(originBaseUrl: string, pathname: string): URL {
	const base = new URL(originBaseUrl);
	// Azure's container path (e.g. "/mapleaperture") is the base URL's own
	// pathname — append the requested path onto it rather than replacing it.
	const basePath = base.pathname.endsWith('/') ? base.pathname.slice(0, -1) : base.pathname;
	base.pathname = `${basePath}${pathname}`;
	return base;
}

/** Fetches `pathname` from the origin, cloning the incoming request's
 * method, headers and body onto the new URL — full request semantics
 * preserved, not a hand-picked subset — except for `STRIPPED_REQUEST_HEADERS`,
 * which never had any reason to leave this Worker. */
async function fetchOrigin(originBaseUrl: string, request: Request, pathname: string) {
	const target = originTarget(originBaseUrl, pathname);
	const originRequest = new Request(target.toString(), request);
	for (const name of STRIPPED_REQUEST_HEADERS) originRequest.headers.delete(name);
	return fetch(originRequest);
}

function withWasmContentType(headers: Headers, pathname: string): Headers {
	if (pathname.endsWith('.wasm')) headers.set('Content-Type', WASM_CONTENT_TYPE);
	return headers;
}

/**
 * SPA fallback: re-fetch `/index.html` from the origin and serve it in
 * place of the 404 the requested path produced.
 *
 * Deliberately issues a plain, header-free `fetch()` rather than cloning
 * the original request (unlike `fetchOrigin`): the original request's
 * conditional-cache headers (`If-None-Match` / `If-Modified-Since`), if
 * present, describe the client's cached copy of the *requested deep-link
 * URL* — a previous fallback response for that same URL, built from this
 * same `index.html` object and carrying its ETag. Forwarding them onto a
 * *fresh* `/index.html` fetch asks Azure to compare against that ETag, and
 * since the object hasn't changed it correctly answers `304 Not Modified`
 * with an empty body — which this function would otherwise wrap in a
 * `200 OK`, serving a blank page to a returning visitor.
 *
 * Guards on the fetch's own status: if `/index.html` itself is unavailable
 * (a misconfigured container, a missing object, an Azure outage), the real
 * status passes through rather than being masked as a successful
 * navigation.
 */
async function spaFallback(originBaseUrl: string): Promise<Response> {
	const target = originTarget(originBaseUrl, '/index.html');
	const indexResponse = await fetch(target.toString());
	const headers = buildResponseHeaders(indexResponse.headers);

	if (indexResponse.status !== 200) {
		return new Response(indexResponse.body, {
			status: indexResponse.status,
			statusText: indexResponse.statusText,
			headers,
		});
	}

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
		const originResponse = await fetchOrigin(env.ORIGIN_BASE_URL, request, url.pathname);

		if (originResponse.status === 404 && isNavigationRequest(request)) {
			// The 404 body is discarded in favor of the fallback response —
			// cancel it rather than let it dangle, so the Worker isn't holding
			// an open connection to the origin for a response nobody reads.
			originResponse.body?.cancel();
			return spaFallback(env.ORIGIN_BASE_URL);
		}

		const headers = withWasmContentType(buildResponseHeaders(originResponse.headers), url.pathname);
		return new Response(originResponse.body, {
			status: originResponse.status,
			statusText: originResponse.statusText,
			headers,
		});
	},
} satisfies ExportedHandler<Env>;
