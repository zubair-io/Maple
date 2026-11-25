import { describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { negotiateEncoding, responseCompression, withVaryAcceptEncoding } from './compression.ts';
import { requestContext } from './request-context.ts';

const rows = Array.from({ length: 200 }, (_, i) => ({ name: `IMG_${i}.DNG`, rating: i % 5 }));

const app = new Elysia()
  .use(responseCompression)
  .use(requestContext)
  .get('/rows', ({ set }) => {
    set.headers['ETag'] = '"0123456789abcdef0123456789abcdef01234567"';
    return { rows };
  })
  .get('/small', () => ({ ok: true }))
  .get(
    '/listing',
    () =>
      new Response(JSON.stringify({ rows }), {
        headers: { 'Content-Type': 'application/json', ETag: '"listing"' },
      }),
  )
  .get(
    '/xmp',
    () => new Response('<x/>'.repeat(1000), { headers: { 'Content-Type': 'application/rdf+xml' } }),
  )
  .get('/bad', ({ set }) => {
    set.status = 400;
    return { error: 'x'.repeat(4000) };
  })
  .get(
    '/streamed',
    () => new Response('y'.repeat(4000), { headers: { 'Content-Type': 'text/event-stream' } }),
  );

function get(path: string, acceptEncoding?: string): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      headers: acceptEncoding ? { 'accept-encoding': acceptEncoding } : {},
    }),
  );
}

async function decoded(res: Response): Promise<string> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  const encoding = res.headers.get('content-encoding');
  if (encoding === 'br') return brotliDecompressSync(bytes).toString();
  if (encoding === 'gzip') return gunzipSync(bytes).toString();
  return new TextDecoder().decode(bytes);
}

describe('negotiateEncoding', () => {
  it('prefers brotli, falls back to gzip, honours q=0', () => {
    expect(negotiateEncoding('gzip, deflate, br')).toBe('br');
    expect(negotiateEncoding('gzip;q=1.0, br;q=0')).toBe('gzip');
    expect(negotiateEncoding('identity')).toBeNull();
    expect(negotiateEncoding(null)).toBeNull();
  });

  it('appends Accept-Encoding to an existing Vary once', () => {
    expect(withVaryAcceptEncoding(undefined)).toBe('Accept-Encoding');
    expect(withVaryAcceptEncoding('Origin')).toBe('Origin, Accept-Encoding');
    expect(withVaryAcceptEncoding('origin, accept-encoding')).toBe('origin, accept-encoding');
  });
});

describe('responseCompression', () => {
  it('compresses a serialized object and keeps the route ETag byte-for-byte', async () => {
    for (const [accept, encoding] of [
      ['br, gzip', 'br'],
      ['gzip', 'gzip'],
    ] as const) {
      const res = await get('/rows', accept);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-encoding')).toBe(encoding);
      expect(res.headers.get('vary')).toContain('Accept-Encoding');
      expect(res.headers.get('etag')).toBe('"0123456789abcdef0123456789abcdef01234567"');
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(res.headers.get('x-request-id')).toBeTruthy();
      expect(JSON.parse(await decoded(res))).toEqual({ rows });
    }
  });

  it('compresses a JSON Response built by the route', async () => {
    const res = await get('/listing', 'gzip, br');
    expect(res.headers.get('content-encoding')).toBe('br');
    expect(res.headers.get('etag')).toBe('"listing"');
    expect(JSON.parse(await decoded(res))).toEqual({ rows });
  });

  it('leaves identity clients, small bodies and non-JSON types alone', async () => {
    const identity = await get('/rows');
    expect(identity.headers.get('content-encoding')).toBeNull();
    expect(JSON.parse(await identity.text())).toEqual({ rows });
    expect((await get('/small', 'br')).headers.get('content-encoding')).toBeNull();
    expect((await get('/xmp', 'br')).headers.get('content-encoding')).toBeNull();
    expect((await get('/streamed', 'br')).headers.get('content-encoding')).toBeNull();
  });

  it('still lets the error envelope wrap a non-2xx body', async () => {
    const res = await get('/bad', 'br');
    expect(res.status).toBe(400);
    expect(res.headers.get('content-encoding')).toBeNull();
    const body = (await res.json()) as { code: string; requestId: string };
    expect(body.code).toBeTruthy();
    expect(body.requestId).toBeTruthy();
  });
});
