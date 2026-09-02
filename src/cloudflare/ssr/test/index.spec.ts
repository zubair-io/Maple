import { env, createExecutionContext, waitOnExecutionContext, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

// A one-byte-magic WASM header ("\0asm") followed by version bytes, enough
// to prove the body survives the proxy untouched — a `.text()`-decoded body
// would corrupt these bytes.
const WASM_MAGIC = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0xff, 0x00]);
const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

function navigationRequest(url: string): Request {
	return new IncomingRequest(url, {
		headers: { 'sec-fetch-mode': 'navigate', accept: 'text/html' },
	});
}

describe('Hosted SSR Worker', () => {
	it('streams a WASM object byte-for-byte and forces application/wasm', async () => {
		fetchMock
			.get('https://origin.test')
			.intercept({ path: '/mapleaperture/raw_wasm_bg.wasm', method: 'GET' })
			.reply(200, WASM_MAGIC, {
				headers: { 'content-type': 'application/octet-stream' },
			});

		const request = new IncomingRequest('https://mapleaperture.com/raw_wasm_bg.wasm');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('application/wasm');
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(WASM_MAGIC);
	});

	it('streams a PNG object byte-for-byte with the origin content-type preserved', async () => {
		fetchMock
			.get('https://origin.test')
			.intercept({ path: '/mapleaperture/assets/icon.png', method: 'GET' })
			.reply(200, PNG_MAGIC, { headers: { 'content-type': 'image/png' } });

		const request = new IncomingRequest('https://mapleaperture.com/assets/icon.png');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('image/png');
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_MAGIC);
	});

	it('adds the production security headers to a normal asset response', async () => {
		fetchMock
			.get('https://origin.test')
			.intercept({ path: '/mapleaperture/main.abc123.js', method: 'GET' })
			.reply(200, 'console.log(1)', { headers: { 'content-type': 'text/javascript' } });

		const request = new IncomingRequest('https://mapleaperture.com/main.abc123.js');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
		expect(response.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
		expect(response.headers.get('referrer-policy')).toBe('no-referrer');
		expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
	});

	it('never overrides the origin cache-control with an immutable policy', async () => {
		fetchMock
			.get('https://origin.test')
			.intercept({ path: '/mapleaperture/raw_wasm_bg.wasm', method: 'GET' })
			.reply(200, WASM_MAGIC, {
				headers: { 'content-type': 'application/wasm' },
				// Azure did not set a Cache-Control on this stable-named object —
				// the Worker must not invent one, let alone a one-year immutable
				// policy (the exact production bug in #2474).
			});

		const request = new IncomingRequest('https://mapleaperture.com/raw_wasm_bg.wasm');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.headers.get('cache-control')).toBeNull();
	});

	it('passes an origin cache-control header through untouched', async () => {
		fetchMock
			.get('https://origin.test')
			.intercept({ path: '/mapleaperture/main.abc123.js', method: 'GET' })
			.reply(200, 'console.log(1)', {
				headers: { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=3600' },
			});

		const request = new IncomingRequest('https://mapleaperture.com/main.abc123.js');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
	});

	it('strips Azure implementation-detail headers', async () => {
		fetchMock
			.get('https://origin.test')
			.intercept({ path: '/mapleaperture/assets/icon.png', method: 'GET' })
			.reply(200, PNG_MAGIC, {
				headers: {
					'content-type': 'image/png',
					'x-ms-request-id': 'abc-123',
					'x-ms-version': '2021-08-06',
					server: 'Windows-Azure-Blob/1.0',
				},
			});

		const request = new IncomingRequest('https://mapleaperture.com/assets/icon.png');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.headers.get('x-ms-request-id')).toBeNull();
		expect(response.headers.get('x-ms-version')).toBeNull();
		expect(response.headers.get('server')).toBeNull();
	});

	it('falls back to index.html, with status 200, for an HTML navigation the origin 404s', async () => {
		fetchMock
			.get('https://origin.test')
			.intercept({ path: '/mapleaperture/browse/lib/photo.dng', method: 'GET' })
			.reply(404, 'not found');
		fetchMock
			.get('https://origin.test')
			.intercept({ path: '/mapleaperture/index.html', method: 'GET' })
			.reply(200, '<html>app shell</html>', { headers: { 'content-type': 'text/html' } });

		const request = navigationRequest('https://mapleaperture.com/browse/lib/photo.dng');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
		expect(response.headers.get('cache-control')).toBe('no-cache');
		expect(await response.text()).toBe('<html>app shell</html>');
	});

	it('passes a real 404 through for a missing subresource (not a navigation)', async () => {
		fetchMock
			.get('https://origin.test')
			.intercept({ path: '/mapleaperture/pkg/does-not-exist.js', method: 'GET' })
			.reply(404, 'not found', { headers: { 'content-type': 'text/plain' } });

		const request = new IncomingRequest('https://mapleaperture.com/pkg/does-not-exist.js', {
			headers: { accept: '*/*' },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(404);
		expect(await response.text()).toBe('not found');
	});

	it('root navigation to / streams the origin index.html directly (no fallback needed)', async () => {
		fetchMock
			.get('https://origin.test')
			.intercept({ path: '/mapleaperture/', method: 'GET' })
			.reply(200, '<html>app shell</html>', { headers: { 'content-type': 'text/html' } });

		const request = navigationRequest('https://mapleaperture.com/');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe('<html>app shell</html>');
	});

	it('does not carry a stale If-None-Match from the deep-link request onto the index.html fallback fetch', async () => {
		// Regression for a real bug: a returning visitor's browser sends
		// If-None-Match for the deep-link URL (from a previous fallback
		// response's ETag, which was index.html's own ETag). If that header
		// were forwarded onto the fresh /index.html fetch, a real Azure origin
		// would correctly — and unhelpfully — answer 304 Not Modified with an
		// empty body, and a naive fallback would serve that as "200 OK, empty
		// body": a blank page. This mock always answers 200 with a full body
		// regardless of what headers arrive, so the behavioral assertion below
		// (a full, non-empty app shell) is what actually proves the fallback
		// fetch works correctly whether or not a stale conditional header
		// exists on the original request.
		fetchMock
			.get('https://origin.test')
			.intercept({ path: '/mapleaperture/browse/lib/photo.dng', method: 'GET' })
			.reply(404, 'not found');
		fetchMock
			.get('https://origin.test')
			.intercept({ path: '/mapleaperture/index.html', method: 'GET' })
			.reply(200, '<html>app shell</html>', { headers: { 'content-type': 'text/html' } });

		const request = new IncomingRequest('https://mapleaperture.com/browse/lib/photo.dng', {
			headers: {
				'sec-fetch-mode': 'navigate',
				accept: 'text/html',
				'if-none-match': '"stale-etag-from-a-previous-fallback-response"',
			},
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe('<html>app shell</html>');
	});

	it('passes through the real status when the index.html fallback fetch itself fails', async () => {
		fetchMock
			.get('https://origin.test')
			.intercept({ path: '/mapleaperture/browse/lib/photo.dng', method: 'GET' })
			.reply(404, 'not found');
		fetchMock
			.get('https://origin.test')
			.intercept({ path: '/mapleaperture/index.html', method: 'GET' })
			.reply(500, 'container misconfigured');

		const request = navigationRequest('https://mapleaperture.com/browse/lib/photo.dng');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		// A masked 200 here would render as a blank successful-looking
		// navigation instead of surfacing the real outage.
		expect(response.status).toBe(500);
		expect(await response.text()).toBe('container misconfigured');
	});

	it('preserves the request method when proxying (HEAD stays HEAD)', async () => {
		fetchMock
			.get('https://origin.test')
			.intercept({ path: '/mapleaperture/raw_wasm_bg.wasm', method: 'HEAD' })
			.reply(200, '', { headers: { 'content-type': 'application/octet-stream' } });

		const request = new IncomingRequest('https://mapleaperture.com/raw_wasm_bg.wasm', {
			method: 'HEAD',
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('application/wasm');
	});

	it('drops the query string when fetching the origin', async () => {
		// Azure Blob Storage's REST API treats certain query keys as commands
		// (e.g. ?comp=, ?sig=) — forwarding an arbitrary client query string
		// could turn a should-be-404 into a 400/403 that never reaches the SPA
		// fallback. The interceptor below has no query string in its path, so
		// Undici would fail to match if the Worker forwarded one.
		fetchMock
			.get('https://origin.test')
			.intercept({ path: '/mapleaperture/assets/icon.png', method: 'GET' })
			.reply(200, PNG_MAGIC, { headers: { 'content-type': 'image/png' } });

		const request = new IncomingRequest('https://mapleaperture.com/assets/icon.png?utm_source=x');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
	});

	it('strips Cookie and client-identifying headers before forwarding to the origin', async () => {
		// The interceptor's `headers` predicate makes the mock fail to match
		// (and this test fail with a pending-interceptor error) if the Worker
		// still forwards any of these — none of them belong on a request to a
		// static, unauthenticated Azure Blob Storage origin.
		fetchMock
			.get('https://origin.test')
			.intercept({
				path: '/mapleaperture/assets/icon.png',
				method: 'GET',
				headers: (headers) =>
					!('cookie' in headers) &&
					!('authorization' in headers) &&
					!('x-forwarded-for' in headers) &&
					!('cf-connecting-ip' in headers),
			})
			.reply(200, PNG_MAGIC, { headers: { 'content-type': 'image/png' } });

		const request = new IncomingRequest('https://mapleaperture.com/assets/icon.png', {
			headers: {
				cookie: 'session=super-secret',
				authorization: 'Bearer super-secret',
				'x-forwarded-for': '203.0.113.7',
				'cf-connecting-ip': '203.0.113.7',
			},
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
	});
});
