/**
 * Cloudflare Worker fronting `GET /api/thumb/*` with an R2 edge cache
 * (#1757, #1760). DNS/route configuration must scope this Worker to that
 * path prefix only (see wrangler.jsonc) — everything else, including the
 * legacy path-keyed `/api/fs/thumb`, must bypass it and go straight to the
 * origin API.
 *
 * Flow:
 *   1. Verify the bearer token (HS256, shared secret) — reject before
 *      touching R2 or the origin.
 *   2. Derive the R2 key from the URL alone (no DB access here — see r2.ts).
 *   3. R2 hit  -> stream back with immutable cache headers.
 *   4. R2 miss -> forward to the origin with the same bearer token (and any
 *      conditional-request headers), stream the response to the client, and
 *      asynchronously populate R2 for next time (only for a confirmed 200
 *      with a body).
 */

import { verifyBearer } from './auth';
import { parseThumbPath, thumbR2Key } from './r2';

const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const FALLBACK_CONTENT_TYPE = 'image/avif';

function unauthorized(): Response {
	return new Response(JSON.stringify({ error: 'unauthorized' }), {
		status: 401,
		headers: {
			'content-type': 'application/json',
			// Never cacheable — an intermediary caching a 401 would keep
			// rejecting a client that later authenticates successfully.
			'cache-control': 'no-store',
			'www-authenticate': 'Bearer',
		},
	});
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);

		const authorized = await verifyBearer(request.headers.get('authorization'), env.JWT_SECRET);
		if (!authorized) return unauthorized();

		const address = parseThumbPath(url.pathname);
		if (!address) {
			// Shouldn't happen given the route scoping in wrangler.jsonc, but
			// fail safe: forward explicitly to the origin's own host rather than
			// re-fetching `request` as-is — refetching the incoming request would
			// hit this same Worker's route again if the route scoping were ever
			// misconfigured to include a path outside /api/thumb/*, looping
			// forever instead of degrading to a normal origin round-trip.
			// `new Request(url, request)` clones method/headers/body from the
			// original request onto the new URL.
			const target = new URL(url.pathname + url.search, env.ORIGIN_API_BASE_URL);
			return fetch(new Request(target, request));
		}

		const key = thumbR2Key(address);

		// `onlyIf` asks R2 to withhold the body when the condition fails (i.e.
		// when the client's `If-None-Match` etag DOES match the stored object —
		// R2 still returns the object's metadata, just without `body`). Three
		// outcomes: `null` (no object at this key — a genuine cache miss),
		// metadata-only (client already has the current bytes — 304), or a
		// full body (bytes differ or no conditional was sent — 200).
		//
		// HTTP etags are quoted (`If-None-Match: "abc123"`); R2's `onlyIf`
		// wants the bare value and throws on a quoted one.
		const ifNoneMatch = request.headers.get('if-none-match')?.replace(/^"|"$/g, '') ?? null;
		const object = await env.THUMBS_BUCKET.get(key, {
			onlyIf: ifNoneMatch ? { etagDoesNotMatch: ifNoneMatch } : undefined,
		});

		if (object === null) {
			return await fetchFromOriginAndCache(request, env, ctx, key);
		}

		if (!('body' in object) || object.body === undefined) {
			return new Response(null, {
				status: 304,
				headers: { etag: object.httpEtag, 'cache-control': IMMUTABLE_CACHE },
			});
		}

		// Prefer the content-type stored alongside the object (set from the
		// origin's own response header when it was cached) over a hard-coded
		// guess — the origin could in principle serve a different image format.
		const headers = new Headers();
		object.writeHttpMetadata(headers);
		if (!headers.has('content-type')) headers.set('content-type', FALLBACK_CONTENT_TYPE);
		headers.set('etag', object.httpEtag);
		headers.set('cache-control', IMMUTABLE_CACHE);

		return new Response(object.body, { status: 200, headers });
	},
} satisfies ExportedHandler<Env>;

/** Cache miss path: forward to the origin with the same bearer token and
 * any conditional-request headers (`If-None-Match` — the origin's own
 * `/api/thumb/*` route supports 304s; dropping this header would turn a
 * cheap revalidation into a full body re-download on every miss), stream
 * the response back to the client immediately, and — only for a confirmed
 * 200 with a body — asynchronously write a copy into R2 so the next
 * request for this key is served from the edge. Non-200 origin responses
 * (202 unindexed, 304, 404, 5xx) pass straight through, uncached. */
async function fetchFromOriginAndCache(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	key: string,
): Promise<Response> {
	const originUrl = new URL(request.url);
	const target = new URL(originUrl.pathname + originUrl.search, env.ORIGIN_API_BASE_URL);

	const forwardHeaders = new Headers();
	const authorization = request.headers.get('authorization');
	if (authorization) forwardHeaders.set('authorization', authorization);
	const ifNoneMatch = request.headers.get('if-none-match');
	if (ifNoneMatch) forwardHeaders.set('if-none-match', ifNoneMatch);

	const originResponse = await fetch(target.toString(), {
		method: 'GET',
		headers: forwardHeaders,
	});

	if (originResponse.status !== 200 || !originResponse.body) {
		return originResponse;
	}

	const [toClient, toCache] = originResponse.body.tee();
	ctx.waitUntil(
		env.THUMBS_BUCKET.put(key, toCache, {
			httpMetadata: {
				contentType: originResponse.headers.get('content-type') ?? FALLBACK_CONTENT_TYPE,
			},
		}).catch(() => undefined),
	);

	return new Response(toClient, {
		status: 200,
		headers: originResponse.headers,
	});
}
