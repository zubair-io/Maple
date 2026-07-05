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
 *   4. R2 miss -> forward to the origin with the same bearer token, stream
 *      the response to the client, and asynchronously populate R2 for next
 *      time (only for a confirmed 200 with a body).
 */

import { verifyBearer } from './auth';
import { parseThumbPath, thumbR2Key } from './r2';

const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

function unauthorized(): Response {
	return new Response(JSON.stringify({ error: 'unauthorized' }), {
		status: 401,
		headers: { 'content-type': 'application/json' },
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
			// fail safe: pass through to origin rather than 404ing a path we
			// don't understand.
			return fetch(request);
		}

		const key = thumbR2Key(address);

		// `onlyIf` asks R2 to withhold the body when the condition fails (i.e.
		// when the client's `If-None-Match` etag DOES match the stored object —
		// R2 still returns the object's metadata, just without `body`). Three
		// outcomes: `null` (no object at this key — a genuine cache miss),
		// metadata-only (client already has the current bytes — 304), or a
		// full body (bytes differ or no conditional was sent — 200).
		const ifNoneMatch = request.headers.get('if-none-match');
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

		return new Response(object.body, {
			status: 200,
			headers: {
				'content-type': 'image/jpeg',
				etag: object.httpEtag,
				'cache-control': IMMUTABLE_CACHE,
			},
		});
	},
} satisfies ExportedHandler<Env>;

/** Cache miss path: forward to the origin with the same bearer token,
 * stream the response back to the client immediately, and — only for a
 * confirmed 200 JPEG — asynchronously write a copy into R2 so the next
 * request for this key is served from the edge. Non-200 origin responses
 * (202 unindexed, 404, 5xx) pass straight through, uncached. */
async function fetchFromOriginAndCache(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	key: string,
): Promise<Response> {
	const originUrl = new URL(request.url);
	const target = new URL(originUrl.pathname + originUrl.search, env.ORIGIN_API_BASE_URL);

	const originResponse = await fetch(target.toString(), {
		method: 'GET',
		headers: { authorization: request.headers.get('authorization') ?? '' },
	});

	if (originResponse.status !== 200 || !originResponse.body) {
		return originResponse;
	}

	const [toClient, toCache] = originResponse.body.tee();
	ctx.waitUntil(
		env.THUMBS_BUCKET.put(key, toCache, {
			httpMetadata: { contentType: originResponse.headers.get('content-type') ?? 'image/jpeg' },
		}).catch(() => undefined),
	);

	return new Response(toClient, {
		status: 200,
		headers: originResponse.headers,
	});
}
