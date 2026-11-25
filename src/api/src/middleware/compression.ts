/**
 * Response compression for JSON API bodies.
 *
 * Bun.serve never compresses, so a 2,000-photo folder listing left the server
 * as ~740 KB of JSON. Behind a Cloudflare tunnel that body crosses the home
 * uplink uncompressed on every navigation; over brotli it is ~27 KB.
 *
 * Scope is deliberately narrow: only 200 responses whose body is a plain
 * object/array (Elysia would serialize it) or an `application/json` Response.
 * Everything else — streamed originals, SSE, images, XMP, errors — passes
 * through untouched, and the request-context envelope hook still runs for
 * them because this hook returns `undefined`. ETags are left byte-for-byte as
 * the route set them: clients pin exact ETag shapes (the XMP `If-Match`
 * precondition) and every route here validates against the unencoded body.
 *
 * Mounted before `requestContext` so it sees the handler's value first.
 */
import { promisify } from 'node:util';
import { brotliCompress, constants as zlib, gzip } from 'node:zlib';
import { Elysia } from 'elysia';

export type ContentEncoding = 'br' | 'gzip';

/** Below this the encoding overhead outweighs the saving. */
export const MIN_COMPRESSIBLE_BYTES = 1024;
/** A JSON Response this large is a library file being served, not an API body; leave it streamed. */
const MAX_BUFFERED_JSON_BYTES = 16 * 1024 * 1024;

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/** Picks br over gzip when both are acceptable; honours `q=0` refusals. */
export function negotiateEncoding(acceptEncoding: string | null): ContentEncoding | null {
  if (!acceptEncoding) return null;
  const accepted = new Set(
    acceptEncoding
      .toLowerCase()
      .split(',')
      .map((part) => part.trim().split(';'))
      .filter(([, ...params]) => !params.some((p) => /^\s*q\s*=\s*0(\.0*)?\s*$/.test(p)))
      .map(([coding]) => coding!.trim()),
  );
  if (accepted.has('br')) return 'br';
  if (accepted.has('gzip')) return 'gzip';
  return null;
}

/** Brotli quality 4 compresses a 740 KB listing in ~3 ms — close to gzip's cost, 25% smaller. */
export async function compressBytes(
  body: Uint8Array | string,
  encoding: ContentEncoding,
  brotliQuality = 4,
): Promise<Uint8Array> {
  const input = typeof body === 'string' ? Buffer.from(body) : body;
  return encoding === 'br'
    ? brotli(input, {
        params: {
          [zlib.BROTLI_PARAM_QUALITY]: brotliQuality,
          [zlib.BROTLI_PARAM_SIZE_HINT]: input.byteLength,
        },
      })
    : gzipAsync(input, { level: 6 });
}

export function withVaryAcceptEncoding(vary: string | null | undefined): string {
  if (!vary) return 'Accept-Encoding';
  return vary
    .toLowerCase()
    .split(',')
    .some((v) => v.trim() === 'accept-encoding' || v.trim() === '*')
    ? vary
    : `${vary}, Accept-Encoding`;
}

function isPlainJsonValue(value: unknown): value is object {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isJsonType(contentType: string | null | undefined): boolean {
  return !!contentType && /^application\/json\b/i.test(contentType);
}

function statusOf(status: unknown): number {
  return typeof status === 'number' ? status : 200;
}

async function encodedResponse(
  body: string | Uint8Array,
  encoding: ContentEncoding | null,
  headers: Headers,
): Promise<Response> {
  headers.set('Vary', withVaryAcceptEncoding(headers.get('Vary')));
  headers.delete('Content-Length');
  if (!encoding || Buffer.byteLength(body) < MIN_COMPRESSIBLE_BYTES) {
    return new Response(body as BodyInit, { status: 200, headers });
  }
  headers.set('Content-Encoding', encoding);
  return new Response((await compressBytes(body, encoding)) as unknown as BodyInit, {
    status: 200,
    headers,
  });
}

async function compressedJsonResponse(
  request: Request,
  response: unknown,
  set: { status?: unknown; headers: Record<string, string | number | undefined> },
): Promise<Response | undefined> {
  if (request.method !== 'GET' && request.method !== 'POST') return undefined;
  const encoding = negotiateEncoding(request.headers.get('accept-encoding'));

  if (response instanceof Response) {
    if (response.status !== 200 || !response.body) return undefined;
    if (!isJsonType(response.headers.get('content-type'))) return undefined;
    if (response.headers.has('content-encoding')) return undefined;
    const declared = Number(response.headers.get('content-length') ?? NaN);
    if (declared > MAX_BUFFERED_JSON_BYTES) return undefined;
    if (!encoding || declared < MIN_COMPRESSIBLE_BYTES) return undefined;
    return encodedResponse(
      new Uint8Array(await response.arrayBuffer()),
      encoding,
      new Headers(response.headers),
    );
  }

  if (statusOf(set.status) !== 200 || !isPlainJsonValue(response)) return undefined;
  const declaredType = set.headers['content-type'] ?? set.headers['Content-Type'];
  if (declaredType !== undefined && !isJsonType(String(declaredType))) return undefined;
  const body = JSON.stringify(response);
  if (!encoding || body.length < MIN_COMPRESSIBLE_BYTES) return undefined;
  return encodedResponse(
    body,
    encoding,
    new Headers({ 'Content-Type': String(declaredType ?? 'application/json;charset=utf-8') }),
  );
}

export const responseCompression = new Elysia({ name: 'response-compression' })
  // Returning undefined hands the response, untouched, to the next mapResponse
  // hook (request-context's envelope); set.headers are merged into what we return.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .mapResponse((async (ctx: any) =>
    compressedJsonResponse(ctx.request, ctx.response, ctx.set)) as any)
  .as('global');
