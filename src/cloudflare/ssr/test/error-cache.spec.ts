import { env, createExecutionContext, waitOnExecutionContext, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const fetchWorker: ExportedHandlerFetchHandler<Env> = worker.fetch;

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

function navigationRequest(url: string): Request<unknown, IncomingRequestCfProperties> {
	return new IncomingRequest(url, {
		headers: { 'sec-fetch-mode': 'navigate', accept: 'text/html' },
	});
}

describe('Hosted SSR Worker error cache policy', () => {
	it('marks a missing subresource no-store so a file uploaded by the next deploy is not shadowed', async () => {
		fetchMock
			.get('https://origin.test')
			.intercept({ path: '/mapleaperture/pkg/does-not-exist.js', method: 'GET' })
			.reply(404, 'not found');

		const request = new IncomingRequest('https://mapleaperture.com/pkg/does-not-exist.js', {
			headers: { accept: '*/*' },
		});
		const ctx = createExecutionContext();
		const response = await fetchWorker(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(404);
		expect(response.headers.get('cache-control')).toBe('no-store');
	});

	it.each([
		[403, 'forbidden'],
		[404, 'not found'],
		[410, 'gone'],
		[500, 'internal error'],
		[503, 'unavailable'],
	])('replaces a cacheable origin %i with no-store', async (status, body) => {
		fetchMock
			.get('https://origin.test')
			.intercept({ path: '/mapleaperture/assets/photo.png', method: 'GET' })
			.reply(status, body, { headers: { 'cache-control': 'public, max-age=14400' } });

		const request = new IncomingRequest('https://mapleaperture.com/assets/photo.png');
		const ctx = createExecutionContext();
		const response = await fetchWorker(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(status);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
		expect(response.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
		expect(await response.text()).toBe(body);
	});

	it('keeps no-transform next to no-store on an HTML error body', async () => {
		fetchMock
			.get('https://origin.test')
			.intercept({ path: '/mapleaperture/assets/page.html', method: 'GET' })
			.reply(500, '<html>error</html>', {
				headers: { 'content-type': 'text/html', 'cache-control': 'public, max-age=14400' },
			});

		const request = new IncomingRequest('https://mapleaperture.com/assets/page.html');
		const ctx = createExecutionContext();
		const response = await fetchWorker(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(500);
		expect(response.headers.get('cache-control')).toBe('no-store, no-transform');
	});

	it('treats 416 as an error and leaves a 304 revalidation response untouched', async () => {
		fetchMock
			.get('https://origin.test')
			.intercept({ path: '/mapleaperture/assets/range.bin', method: 'GET' })
			.reply(416, 'bad range', { headers: { 'cache-control': 'public, max-age=60' } });
		fetchMock
			.get('https://origin.test')
			.intercept({ path: '/mapleaperture/assets/etag.bin', method: 'GET' })
			.reply(304, '', { headers: { 'cache-control': 'public, max-age=60' } });

		const run = async (path: string) => {
			const ctx = createExecutionContext();
			const response = await fetchWorker(
				new IncomingRequest(`https://mapleaperture.com${path}`),
				env,
				ctx,
			);
			await waitOnExecutionContext(ctx);
			return response;
		};
		const ranged = await run('/assets/range.bin');
		const revalidated = await run('/assets/etag.bin');

		expect(ranged.status).toBe(416);
		expect(ranged.headers.get('cache-control')).toBe('no-store');
		expect(revalidated.status).toBe(304);
		expect(revalidated.headers.get('cache-control')).toBe('public, max-age=60');
	});

	it('marks an index.html fallback failure no-store', async () => {
		fetchMock
			.get('https://origin.test')
			.intercept({ path: '/mapleaperture/browse/lib/photo.dng', method: 'GET' })
			.reply(404, 'not found');
		fetchMock
			.get('https://origin.test')
			.intercept({ path: '/mapleaperture/index.html', method: 'GET' })
			.reply(500, 'container misconfigured', {
				headers: { 'cache-control': 'public, max-age=14400' },
			});

		const request = navigationRequest('https://mapleaperture.com/browse/lib/photo.dng');
		const ctx = createExecutionContext();
		const response = await fetchWorker(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(500);
		expect(response.headers.get('cache-control')).toBe('no-store');
	});

	it('forbids the edge from storing error statuses of the origin subrequest', async () => {
		fetchMock
			.get('https://origin.test')
			.intercept({ path: '/mapleaperture/pkg/does-not-exist.js', method: 'GET' })
			.reply(404, 'not found');
		const realFetch = globalThis.fetch;
		const subrequestInits: (RequestInit | undefined)[] = [];
		const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
			subrequestInits.push(init);
			return realFetch(input, init);
		});

		const request = new IncomingRequest('https://mapleaperture.com/pkg/does-not-exist.js', {
			headers: { accept: '*/*' },
		});
		const ctx = createExecutionContext();
		await fetchWorker(request, env, ctx);
		await waitOnExecutionContext(ctx);
		spy.mockRestore();

		expect(subrequestInits[0]?.cf?.cacheTtlByStatus).toEqual({ '400-599': -1 });
	});

	it('leaves a successful response cache-control exactly as the origin set it', async () => {
		fetchMock
			.get('https://origin.test')
			.intercept({ path: '/mapleaperture/main-ABC123.js', method: 'GET' })
			.reply(200, 'console.log(1)', {
				headers: { 'cache-control': 'public, max-age=31536000' },
			});

		const request = new IncomingRequest('https://mapleaperture.com/main-ABC123.js');
		const ctx = createExecutionContext();
		const response = await fetchWorker(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('public, max-age=31536000');
	});
});
