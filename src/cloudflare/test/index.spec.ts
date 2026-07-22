import { env, createExecutionContext, waitOnExecutionContext, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { SignJWT } from 'jose';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const SECRET = 'test-secret-not-for-production-only';

function capabilityToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...bytes))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/, '');
}

async function bearerToken(): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	return new SignJWT({ email: 'a@b.c', role: 'owner' })
		.setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
		.setSubject('user-1')
		.setIssuedAt(now)
		.setExpirationTime(now + 900)
		.sign(new TextEncoder().encode(SECRET));
}

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

describe('thumbnail-cache Worker', () => {
	it('proxies URL capabilities to the origin without reading or populating R2', async () => {
		const capability = capabilityToken();
		const bytes = new Uint8Array([7, 8, 9]);
		await env.THUMBS_BUCKET.put('thumbs/main/capability.jpg', new Uint8Array([1, 2, 3]));
		fetchMock
			.get('https://origin.test')
			.intercept({
				path: `/api/thumb/main/capability.jpg?token=${capability}`,
				method: 'GET',
			})
			.reply(200, bytes, {
				headers: { 'content-type': 'image/avif', 'cache-control': 'public, max-age=31536000' },
			});

		const request = new IncomingRequest(
			`https://example.com/api/thumb/main/capability.jpg?token=${capability}`,
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('private, no-store');
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
		await waitOnExecutionContext(ctx);
		const existing = await env.THUMBS_BUCKET.get('thumbs/main/capability.jpg');
		expect(new Uint8Array(await existing!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
	});

	it('passes an origin capability rejection through without caching it', async () => {
		const capability = capabilityToken();
		fetchMock
			.get('https://origin.test')
			.intercept({ path: `/api/thumb/main/expired.jpg?token=${capability}`, method: 'GET' })
			.reply(401, JSON.stringify({ error: 'unauthorized' }), {
				headers: { 'content-type': 'application/json' },
			});

		const request = new IncomingRequest(
			`https://example.com/api/thumb/main/expired.jpg?token=${capability}`,
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		expect(response.status).toBe(401);
		expect(response.headers.get('cache-control')).toBe('private, no-store');
		await response.arrayBuffer();
		await waitOnExecutionContext(ctx);
		expect(await env.THUMBS_BUCKET.get('thumbs/main/expired.jpg')).toBeNull();
	});

	it('rejects a request with no Authorization header, without touching R2 or origin', async () => {
		const request = new IncomingRequest('https://example.com/api/thumb/main/a.jpg');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('www-authenticate')).toBe('Bearer');
		expect(await env.THUMBS_BUCKET.get('thumbs/main/a.jpg')).toBeNull();
	});

	it('rejects an invalid bearer token', async () => {
		const request = new IncomingRequest('https://example.com/api/thumb/main/a.jpg', {
			headers: { authorization: 'Bearer not-a-real-jwt' },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
	});

	it('serves straight from R2 on a hit, without calling the origin', async () => {
		const token = await bearerToken();
		// No httpMetadata — exercises the FALLBACK_CONTENT_TYPE path (an object
		// stored with no recorded content-type falls back to 'image/avif').
		await env.THUMBS_BUCKET.put('thumbs/main/hit.jpg', new Uint8Array([1, 2, 3]));

		const request = new IncomingRequest('https://example.com/api/thumb/main/hit.jpg', {
			headers: { authorization: `Bearer ${token}` },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
		expect(response.headers.get('content-type')).toBe('image/avif');
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
	});

	it('serves an R2 hit with the content-type stored on the object, not a hard-coded guess', async () => {
		const token = await bearerToken();
		await env.THUMBS_BUCKET.put('thumbs/main/hit.png', new Uint8Array([1, 2, 3]), {
			httpMetadata: { contentType: 'image/png' },
		});

		const request = new IncomingRequest('https://example.com/api/thumb/main/hit.png', {
			headers: { authorization: `Bearer ${token}` },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		// Drain the body before the test ends — vitest-pool-workers' isolated
		// storage teardown asserts every R2 object body was fully consumed.
		await response.arrayBuffer();
		await waitOnExecutionContext(ctx);

		expect(response.headers.get('content-type')).toBe('image/png');
	});

	it('forwards to the origin on a miss and populates R2 for next time', async () => {
		const token = await bearerToken();
		const bytes = new Uint8Array([9, 9, 9]);

		fetchMock
			.get('https://origin.test')
			.intercept({ path: '/api/thumb/main/miss.jpg', method: 'GET' })
			.reply(200, bytes, { headers: { 'content-type': 'image/avif' } });

		const request = new IncomingRequest('https://example.com/api/thumb/main/miss.jpg', {
			headers: { authorization: `Bearer ${token}` },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('image/avif');
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);

		// ctx.waitUntil'd R2 write only lands once the execution context settles.
		await waitOnExecutionContext(ctx);
		const cached = await env.THUMBS_BUCKET.get('thumbs/main/miss.jpg');
		expect(cached).not.toBeNull();
		expect(cached!.httpMetadata?.contentType).toBe('image/avif');
		expect(new Uint8Array(await cached!.arrayBuffer())).toEqual(bytes);
	});

	it('forwards If-None-Match to the origin on a miss, so the origin can 304', async () => {
		const token = await bearerToken();

		fetchMock
			.get('https://origin.test')
			.intercept({
				path: '/api/thumb/main/revalidate.jpg',
				method: 'GET',
				headers: { 'if-none-match': '"abc123"' },
			})
			.reply(304, '');

		const request = new IncomingRequest('https://example.com/api/thumb/main/revalidate.jpg', {
			headers: { authorization: `Bearer ${token}`, 'if-none-match': '"abc123"' },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(304);
	});

	it('passes through a non-200 origin response (e.g. 202 unindexed) without caching it', async () => {
		const token = await bearerToken();

		fetchMock
			.get('https://origin.test')
			.intercept({ path: '/api/thumb/main/pending.jpg', method: 'GET' })
			.reply(202, '', { headers: { 'retry-after': '2' } });

		const request = new IncomingRequest('https://example.com/api/thumb/main/pending.jpg', {
			headers: { authorization: `Bearer ${token}` },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(202);
		expect(await env.THUMBS_BUCKET.get('thumbs/main/pending.jpg')).toBeNull();
	});
});
