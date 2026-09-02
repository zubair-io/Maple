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
});
