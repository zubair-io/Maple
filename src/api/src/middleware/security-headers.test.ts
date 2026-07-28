/**
 * Guards the two halves of `securityHeaders` that are easy to break silently.
 *
 * 1. The headers must reach routes in the PARENT app, not just routes defined
 *    inside the plugin. Elysia scopes plugin hooks locally by default, so
 *    without `.as('global')` every CORS + isolation header vanishes from every
 *    API response — and nothing else in CI notices.
 * 2. Streamed-file paths must be exempt (#2382): any `set.headers` write makes
 *    Elysia rebuild a returned `Response`, discarding the `BunFile` slice, so a
 *    206 ships the whole file while advertising a partial `Content-Range`.
 */
import { describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { securityHeaders } from './security-headers.ts';

function app() {
  return new Elysia()
    .use(securityHeaders)
    .get('/api/folders', () => ({ ok: true }))
    .get('/api/video/fs', () => new Response('bytes'));
}

describe('securityHeaders', () => {
  test('applies isolation headers to parent-app routes', async () => {
    const res = await app().handle(new Request('http://localhost/api/folders'));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(res.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
  });

  test('exempts streamed-file paths so the response body is not rebuilt', async () => {
    const res = await app().handle(new Request('http://localhost/api/video/fs'));
    expect(res.headers.get('Cross-Origin-Embedder-Policy')).toBeNull();
    expect(res.headers.get('Cross-Origin-Opener-Policy')).toBeNull();
  });

  test('answers OPTIONS preflight with 204 and the isolation headers', async () => {
    const res = await app().handle(
      new Request('http://localhost/api/folders', { method: 'OPTIONS' }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
  });

  test('echoes Private Network Access only when the preflight asks', async () => {
    const withAsk = await app().handle(
      new Request('http://localhost/api/folders', {
        method: 'OPTIONS',
        headers: { 'access-control-request-private-network': 'true' },
      }),
    );
    expect(withAsk.headers.get('Access-Control-Allow-Private-Network')).toBe('true');

    const withoutAsk = await app().handle(
      new Request('http://localhost/api/folders', { method: 'OPTIONS' }),
    );
    expect(withoutAsk.headers.get('Access-Control-Allow-Private-Network')).toBeNull();
  });
});
