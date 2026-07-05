import { env, createExecutionContext, waitOnExecutionContext, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { SignJWT } from 'jose';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const SECRET = 'test-secret-not-for-production-only';

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
	it('rejects a request with no Authorization header, without touching R2 or origin', async () => {
		const request = new IncomingRequest('https://example.com/api/thumb/main/a.jpg');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
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
		await env.THUMBS_BUCKET.put('thumbs/main/hit.jpg', new Uint8Array([1, 2, 3]));

		const request = new IncomingRequest('https://example.com/api/thumb/main/hit.jpg', {
			headers: { authorization: `Bearer ${token}` },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
	});

	it('forwards to the origin on a miss and populates R2 for next time', async () => {
		const token = await bearerToken();
		const bytes = new Uint8Array([9, 9, 9]);

		fetchMock
			.get('https://origin.test')
			.intercept({ path: '/api/thumb/main/miss.jpg', method: 'GET' })
			.reply(200, bytes, { headers: { 'content-type': 'image/jpeg' } });

		const request = new IncomingRequest('https://example.com/api/thumb/main/miss.jpg', {
			headers: { authorization: `Bearer ${token}` },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		expect(response.status).toBe(200);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);

		// ctx.waitUntil'd R2 write only lands once the execution context settles.
		await waitOnExecutionContext(ctx);
		const cached = await env.THUMBS_BUCKET.get('thumbs/main/miss.jpg');
		expect(cached).not.toBeNull();
		expect(new Uint8Array(await cached!.arrayBuffer())).toEqual(bytes);
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
