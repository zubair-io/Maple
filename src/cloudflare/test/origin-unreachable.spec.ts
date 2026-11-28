import { env, createExecutionContext, waitOnExecutionContext, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { SignJWT } from 'jose';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const SECRET = 'test-secret-not-for-production-only';
const ONE_PIXEL_AVIF =
	'AAAAHGZ0eXBhdmlmAAAAAG1pZjFhdmlmbWlhZgAAAXBtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAAA5waXRtAAAAAAABAAAANGlsb2MAAAAAREAAAgABAAAAAAGUAAEAAAAAAAAAHQACAAAAAAGxAAEAAAAAAAAAFAAAADhpaW5mAAAAAAACAAAAFWluZmUCAAAAAAEAAGF2MDEAAAAAFWluZmUCAAAAAAIAAGF2MDEAAAAAr2lwcnAAAACKaXBjbwAAAAxhdjFDgSACAAAAABRpc3BlAAAAAAAAAAEAAAABAAAAEHBpeGkAAAAAAwgICAAAAAxhdjFDgQAcAAAAAA5waXhpAAAAAAEIAAAAOGF1eEMAAAAAdXJuOm1wZWc6bXBlZ0I6Y2ljcDpzeXN0ZW1zOmF1eGlsaWFyeTphbHBoYQAAAAAdaXBtYQAAAAAAAAACAAEDgQIDAAIEhAIFhgAAABppcmVmAAAAAAAAAA5hdXhsAAIAAQABAAAAOW1kYXQSAAoHOAAGEBDQaTIQGAAAAEAAsBNWZDGABE4fIBIACgQYAAYVMgoYAAABAAIhG6Ng';

async function bearerToken(): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	return new SignJWT({ email: 'a@b.c', role: 'owner' })
		.setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
		.setSubject('user-1')
		.setIssuedAt(now)
		.setExpirationTime(now + 900)
		.sign(new TextEncoder().encode(SECRET));
}

async function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(
		new IncomingRequest(`https://example.com${path}`, {
			headers: { authorization: `Bearer ${await bearerToken()}`, ...headers },
		}),
		env,
		ctx,
	);
	await waitOnExecutionContext(ctx);
	return response;
}

async function bytes(response: Response): Promise<number[]> {
	return [...new Uint8Array(await response.arrayBuffer())];
}

function origin() {
	return fetchMock.get(env.ORIGIN_API_BASE_URL);
}

async function storeOlderVersion(name: string, body = new Uint8Array([1])) {
	return env.THUMBS_BUCKET.put(`thumbs/main/${name}/v25`, body, {
		httpMetadata: { contentType: 'image/avif' },
		customMetadata: { 'thumb-version': 'old' },
	});
}

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

describe('versioned thumbnail request while the origin cannot be reached (#6013)', () => {
	it('answers with the edge copy when the connection fails, and does not call it the requested version', async () => {
		const stored = await storeOlderVersion('down.jpg', new Uint8Array([1, 2]));
		origin()
			.intercept({ path: '/api/thumb/main/down.jpg?v=new', method: 'GET' })
			.replyWithError(new Error('connection refused'));

		const response = await get('/api/thumb/main/down.jpg?v=new');

		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('private, no-cache');
		expect(response.headers.get('etag')).toBe(stored.httpEtag);
		expect(response.headers.get('content-type')).toBe('image/avif');
		expect(await bytes(response)).toEqual([1, 2]);
		const untouched = await env.THUMBS_BUCKET.head('thumbs/main/down.jpg/v25');
		expect(untouched!.customMetadata).toEqual({ 'thumb-version': 'old' });
	});

	it.each([502, 503, 504, 522, 530])(
		'answers with the edge copy when the origin side answers %i',
		async (status) => {
			await storeOlderVersion(`gateway-${status}.jpg`, new Uint8Array([status % 200]));
			origin()
				.intercept({ path: `/api/thumb/main/gateway-${status}.jpg?v=new`, method: 'GET' })
				.reply(status, 'origin down', { headers: { 'content-type': 'text/plain' } });

			const response = await get(`/api/thumb/main/gateway-${status}.jpg?v=new`);

			expect(response.status).toBe(200);
			expect(response.headers.get('cache-control')).toBe('private, no-cache');
			expect(await bytes(response)).toEqual([status % 200]);
		},
	);

	it('revalidates with a 304 when the client already holds the edge copy', async () => {
		const stored = await storeOlderVersion('held.jpg');
		origin()
			.intercept({ path: '/api/thumb/main/held.jpg?v=new', method: 'GET' })
			.replyWithError(new Error('connection refused'));

		const response = await get('/api/thumb/main/held.jpg?v=new', {
			'if-none-match': stored.httpEtag,
		});

		expect(response.status).toBe(304);
		expect(response.headers.get('cache-control')).toBe('private, no-cache');
		expect(response.headers.get('etag')).toBe(stored.httpEtag);
	});

	it('revalidates with a 304 after a gateway error when the client holds the edge copy', async () => {
		const stored = await storeOlderVersion('held-502.jpg');
		origin()
			.intercept({ path: '/api/thumb/main/held-502.jpg?v=new', method: 'GET' })
			.reply(502, 'bad gateway');

		const response = await get('/api/thumb/main/held-502.jpg?v=new', {
			'if-none-match': stored.httpEtag,
		});

		expect(response.status).toBe(304);
		expect(response.headers.get('cache-control')).toBe('private, no-cache');
	});

	it('still converts the edge copy for a format=jpg request', async () => {
		await storeOlderVersion(
			'jpeg.avif',
			Uint8Array.from(atob(ONE_PIXEL_AVIF), (c) => c.charCodeAt(0)),
		);
		origin()
			.intercept({ path: '/api/thumb/main/jpeg.avif?v=new&format=jpg', method: 'GET' })
			.replyWithError(new Error('connection refused'));

		const response = await get('/api/thumb/main/jpeg.avif?v=new&format=jpg');

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('image/jpeg');
		expect(response.headers.get('etag')).toBeNull();
		expect((await bytes(response)).slice(0, 3)).toEqual([0xff, 0xd8, 0xff]);
	});

	it('passes through an answer from a reachable origin instead of the edge copy', async () => {
		for (const [status, name] of [
			[404, 'gone.jpg'],
			[500, 'broken.jpg'],
			[202, 'pending.jpg'],
			[501, 'not-implemented.jpg'],
			[505, 'http-version.jpg'],
			[519, 'edge-low.jpg'],
			[531, 'edge-high.jpg'],
		] as const) {
			await storeOlderVersion(name);
			origin()
				.intercept({ path: `/api/thumb/main/${name}?v=new`, method: 'GET' })
				.reply(status, 'origin answer');

			const response = await get(`/api/thumb/main/${name}?v=new`);

			expect(response.status).toBe(status);
			expect(await response.text()).toBe('origin answer');
		}
	});

	it('still refreshes the edge when the origin answers', async () => {
		await storeOlderVersion('fresh.jpg');
		origin()
			.intercept({ path: '/api/thumb/main/fresh.jpg?v=new', method: 'GET' })
			.reply(200, new Uint8Array([9]), {
				headers: { 'content-type': 'image/avif', 'x-maple-thumb-version': 'new' },
			});

		const response = await get('/api/thumb/main/fresh.jpg?v=new');

		expect(await bytes(response)).toEqual([9]);
		const refreshed = await env.THUMBS_BUCKET.head('thumbs/main/fresh.jpg/v25');
		expect(refreshed!.customMetadata).toEqual({ 'thumb-version': 'new' });
	});

	it('has nothing to serve when the edge holds no copy: a gateway error passes through', async () => {
		origin()
			.intercept({ path: '/api/thumb/main/never.jpg?v=new', method: 'GET' })
			.reply(503, 'origin down');

		const response = await get('/api/thumb/main/never.jpg?v=new');

		expect(response.status).toBe(503);
		expect(await response.text()).toBe('origin down');
	});

	it('has nothing to serve when the edge holds no copy: a connection failure still rejects', async () => {
		origin()
			.intercept({ path: '/api/thumb/main/never2.jpg?v=new', method: 'GET' })
			.replyWithError(new Error('connection refused'));

		await expect(get('/api/thumb/main/never2.jpg?v=new')).rejects.toThrow();
	});
});
