import { env, createExecutionContext, waitOnExecutionContext, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { SignJWT } from 'jose';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const SECRET = 'test-secret-not-for-production-only';
const ONE_PIXEL_AVIF =
	'AAAAHGZ0eXBhdmlmAAAAAG1pZjFhdmlmbWlhZgAAAXBtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAAA5waXRtAAAAAAABAAAANGlsb2MAAAAAREAAAgABAAAAAAGUAAEAAAAAAAAAHQACAAAAAAGxAAEAAAAAAAAAFAAAADhpaW5mAAAAAAACAAAAFWluZmUCAAAAAAEAAGF2MDEAAAAAFWluZmUCAAAAAAIAAGF2MDEAAAAAr2lwcnAAAACKaXBjbwAAAAxhdjFDgSACAAAAABRpc3BlAAAAAAAAAAEAAAABAAAAEHBpeGkAAAAAAwgICAAAAAxhdjFDgQAcAAAAAA5waXhpAAAAAAEIAAAAOGF1eEMAAAAAdXJuOm1wZWc6bXBlZ0I6Y2ljcDpzeXN0ZW1zOmF1eGlsaWFyeTphbHBoYQAAAAAdaXBtYQAAAAAAAAACAAEDgQIDAAIEhAIFhgAAABppcmVmAAAAAAAAAA5hdXhsAAIAAQABAAAAOW1kYXQSAAoHOAAGEBDQaTIQGAAAAEAAsBNWZDGABE4fIBIACgQYAAYVMgoYAAABAAIhG6Ng';

function decodeBase64(value: string): Uint8Array {
	return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
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
	it('serves an object already in R2 under the frozen /v25 key, whatever pv is sent', async () => {
		await env.THUMBS_BUCKET.put('thumbs/main/existing.jpg/v25', new Uint8Array([7]), {
			httpMetadata: { contentType: 'image/avif' },
		});
		for (const query of ['', '?pv=25', '?pv=26']) {
			const ctx = createExecutionContext();
			const response = await worker.fetch(
				new IncomingRequest(`https://example.com/api/thumb/main/existing.jpg${query}`, {
					headers: { authorization: `Bearer ${await bearerToken()}` },
				}),
				env,
				ctx,
			);
			await waitOnExecutionContext(ctx);
			expect(response.status).toBe(200);
			expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([7]);
		}
	});

	it('caches an origin 200 that carries no pipeline-version header', async () => {
		const path = '/api/thumb/main/unversioned.jpg';
		fetchMock
			.get(env.ORIGIN_API_BASE_URL)
			.intercept({ path, method: 'GET' })
			.reply(200, new Uint8Array([3]), { headers: { 'content-type': 'image/avif' } });
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new IncomingRequest(`https://example.com${path}`, {
				headers: { authorization: `Bearer ${await bearerToken()}` },
			}),
			env,
			ctx,
		);
		expect(response.status).toBe(200);
		expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([3]);
		await waitOnExecutionContext(ctx);
		const cached = await env.THUMBS_BUCKET.get('thumbs/main/unversioned.jpg/v25');
		expect([...new Uint8Array(await cached!.arrayBuffer())]).toEqual([3]);
	});

	it('revalidates a 304 from R2 instead of stamping it immutable', async () => {
		const stored = await env.THUMBS_BUCKET.put('thumbs/main/etag.jpg/v25', new Uint8Array([5]));
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new IncomingRequest('https://example.com/api/thumb/main/etag.jpg', {
				headers: {
					authorization: `Bearer ${await bearerToken()}`,
					'if-none-match': stored.httpEtag,
				},
			}),
			env,
			ctx,
		);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(304);
		expect(response.headers.get('cache-control')).toBe('private, no-cache');
	});

	it('does not mirror an origin 200 into R2 when the origin opts out, and hides the opt-out header', async () => {
		const path = '/api/thumb/main/hidden.jpg';
		fetchMock
			.get(env.ORIGIN_API_BASE_URL)
			.intercept({ path, method: 'GET' })
			.reply(200, new Uint8Array([9]), {
				headers: { 'content-type': 'image/avif', 'x-maple-cacheable': '0' },
			});
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new IncomingRequest(`https://example.com${path}`, {
				headers: { authorization: `Bearer ${await bearerToken()}` },
			}),
			env,
			ctx,
		);
		expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([9]);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		expect(response.headers.has('x-maple-cacheable')).toBe(false);
		expect(await env.THUMBS_BUCKET.get('thumbs/main/hidden.jpg/v25')).toBeNull();
	});

	it('does not proxy protocol-relative paths carrying capability-shaped tokens', async () => {
		const request = new IncomingRequest(
			`https://example.com//evil.example/collect?token=${'T'.repeat(43)}`,
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
		expect(response.headers.get('cache-control')).toBe('no-store');
	});

	it.each(['/api/thumb/main/legacy.jpg', '/api/preview/main/legacy.jpg'])(
		'rejects URL tokens without a bearer on %s',
		async (path) => {
			const request = new IncomingRequest(`https://example.com${path}?token=${'T'.repeat(43)}`);
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);
			expect(response.status).toBe(401);
			expect(response.headers.get('cache-control')).toBe('no-store');
			expect(response.headers.get('www-authenticate')).toBe('Bearer');
		},
	);

	it('uses bearer authentication with an opaque URL token and converts an R2 hit to JPEG', async () => {
		const token = await bearerToken();
		await env.THUMBS_BUCKET.put(`thumbs/main/legacy.avif/v25`, decodeBase64(ONE_PIXEL_AVIF), {
			httpMetadata: { contentType: 'image/avif' },
		});
		const request = new IncomingRequest(
			`https://example.com/api/thumb/main/legacy.avif?format=jpg&token=${'T'.repeat(43)}`,
			{ headers: { authorization: `Bearer ${token}` } },
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		const jpeg = new Uint8Array(await response.arrayBuffer());
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('image/jpeg');
		expect(response.headers.get('content-length')).toBeNull();
		expect(response.headers.get('etag')).toBeNull();
		expect([...jpeg.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
		const cached = await env.THUMBS_BUCKET.get(`thumbs/main/legacy.avif/v25`);
		expect(new Uint8Array(await cached!.arrayBuffer())).toEqual(decodeBase64(ONE_PIXEL_AVIF));
	});

	it('rejects a request with no Authorization header, without touching R2 or origin', async () => {
		const request = new IncomingRequest(`https://example.com/api/thumb/main/a.jpg`);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('www-authenticate')).toBe('Bearer');
		expect(await env.THUMBS_BUCKET.get(`thumbs/main/a.jpg/v25`)).toBeNull();
	});

	it('refuses non-GET/HEAD methods before touching R2 or the origin', async () => {
		const request = new IncomingRequest('https://example.com/api/thumb/main/a.jpg', {
			method: 'POST',
			headers: { authorization: `Bearer ${await bearerToken()}` },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(405);
	});

	it('rejects an invalid bearer token', async () => {
		const request = new IncomingRequest(`https://example.com/api/thumb/main/a.jpg`, {
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
		await env.THUMBS_BUCKET.put(`thumbs/main/hit.jpg/v25`, new Uint8Array([1, 2, 3]));

		const request = new IncomingRequest(`https://example.com/api/thumb/main/hit.jpg`, {
			headers: { authorization: `Bearer ${token}` },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('private, no-cache');
		expect(response.headers.get('content-type')).toBe('image/avif');
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
	});

	it('serves an R2 hit with the content-type stored on the object, not a hard-coded guess', async () => {
		const token = await bearerToken();
		await env.THUMBS_BUCKET.put(`thumbs/main/hit.png/v25`, new Uint8Array([1, 2, 3]), {
			httpMetadata: { contentType: 'image/png' },
		});

		const request = new IncomingRequest(`https://example.com/api/thumb/main/hit.png`, {
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
			.intercept({ path: `/api/thumb/main/miss.jpg`, method: 'GET' })
			.reply(200, bytes, {
				headers: {
					'content-type': 'image/avif',
				},
			});

		const request = new IncomingRequest(`https://example.com/api/thumb/main/miss.jpg`, {
			headers: { authorization: `Bearer ${token}` },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('image/avif');
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);

		// ctx.waitUntil'd R2 write only lands once the execution context settles.
		await waitOnExecutionContext(ctx);
		const cached = await env.THUMBS_BUCKET.get(`thumbs/main/miss.jpg/v25`);
		expect(cached).not.toBeNull();
		expect(cached!.httpMetadata?.contentType).toBe('image/avif');
		expect(new Uint8Array(await cached!.arrayBuffer())).toEqual(bytes);
	});

	it('forwards If-None-Match to the origin on a miss, so the origin can 304', async () => {
		const token = await bearerToken();

		fetchMock
			.get('https://origin.test')
			.intercept({
				path: `/api/thumb/main/revalidate.jpg`,
				method: 'GET',
				headers: { 'if-none-match': '"abc123"' },
			})
			.reply(304, '');

		const request = new IncomingRequest(`https://example.com/api/thumb/main/revalidate.jpg`, {
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
			.intercept({
				path: `/api/thumb/main/pending.jpg`,
				method: 'GET',
			})
			.reply(202, '', { headers: { 'retry-after': '2' } });

		const request = new IncomingRequest(`https://example.com/api/thumb/main/pending.jpg`, {
			headers: { authorization: `Bearer ${token}` },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(202);
		expect(await env.THUMBS_BUCKET.get(`thumbs/main/pending.jpg/v25`)).toBeNull();
	});
});
