/**
 * CORS + cross-origin isolation headers for every response.
 *
 * Extracted from `index.ts` (file-size budget) when #2382 added the
 * streamed-file exemption below.
 *
 * T10: COOP: same-origin + COEP: require-corp are required so the hosted
 * Angular bundle can use SharedArrayBuffer for the WASM rayon thread pool.
 * Both the API responses and the static-UI responses share this middleware
 * because the page becomes cross-origin-isolated only when *every* top-level
 * document response carries both headers.
 */
import { Elysia } from 'elysia';
import {
  CORS_ORIGIN,
  STREAMED_FILE_HEADERS,
  isStreamedFilePath,
} from '../routes/library/shared.ts';

export const securityHeaders = new Elysia({ name: 'securityHeaders' })
  // #2382: these MUST NOT be applied via `set.headers` to routes that return a
  // streamed file body. Elysia rebuilds a returned `Response` whenever
  // `set.headers` is non-empty, and that rebuild discards the `BunFile` slice —
  // so a 206 shipped the WHOLE file while still advertising a partial
  // `Content-Range`. AVFoundation reads that as a protocol violation and
  // aborts, which is why video played on no Apple device. Those routes carry
  // the equivalent headers on the response itself (`STREAMED_FILE_HEADERS`).
  .onBeforeHandle(({ set, path }) => {
    if (isStreamedFilePath(path)) return;
    set.headers['Access-Control-Allow-Origin'] = CORS_ORIGIN;
    set.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
    set.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    set.headers['Cross-Origin-Opener-Policy'] = 'same-origin';
    set.headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
  })
  // Streamed-file routes are skipped above so their `Response` body survives,
  // but that also stripped CORS from their ERROR replies — a 401/415 from
  // `/api/video/fs` came back with no CORS headers at all, so a browser could
  // not read the failure (jules review on #2383).
  //
  // Those error branches return a plain object, not a `Response`, so there is
  // no file body to rebuild and writing `set.headers` here is safe. A real
  // streamed `Response` is left untouched — it already carries
  // `STREAMED_FILE_HEADERS` from `streamFileRange`/`streamFile`.
  .onAfterHandle(({ response, set, path }) => {
    if (!isStreamedFilePath(path)) return;
    if (response instanceof Response) return;
    Object.assign(set.headers, STREAMED_FILE_HEADERS);
  })
  // Mirror the isolation headers onto OPTIONS preflight too, so that any
  // cross-origin check counts them as present.
  .options('/*', ({ headers, set }) => {
    set.headers['Access-Control-Allow-Origin'] = CORS_ORIGIN;
    set.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
    set.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    set.headers['Cross-Origin-Opener-Policy'] = 'same-origin';
    set.headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
    // Chrome's Private Network Access: only echo this back when the
    // browser's preflight actually asked for it — a page only sets this
    // header when it resolved the target to a private-network address in
    // the first place, so this only ever fires for the LAN discovery flow
    // (see routes/network.ts), not for every cross-origin request this
    // server answers. Blanket-setting it (as an earlier version of this
    // change did) would let ANY public webpage bypass PNA for every route,
    // not just the intentionally-public one — a meaningfully wider
    // exposure than the feature needs.
    if (headers['access-control-request-private-network'] === 'true') {
      set.headers['Access-Control-Allow-Private-Network'] = 'true';
    }
    set.status = 204;
    return;
  })
  // Promote the hooks to global scope so they cover every route in the parent
  // app, not just the OPTIONS handler defined inside this plugin. Elysia scopes
  // plugin hooks locally by default — without this the CORS + isolation headers
  // silently vanish from every API response (same `.as("global")` requirement
  // as `requestContext`).
  .as('global');
