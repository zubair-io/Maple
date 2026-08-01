// src/api/src/routes/fs.ts
//
// GET /api/fs/list?path=<abs>&showAll=0|1
//   Lists subdirectories under `path` (no files). Used by the library-picker
//   empty-state to let the user pick a folder to register.
//
// GET /api/fs/dir?path=<abs>
//   Lists subdirectories AND image files at a single directory level, with
//   per-image enrichment (Mongo asset_id, EXIF subdoc) and paired XMP
//   sidecars. Used by the Apple File Provider extension and the iOS/macOS
//   cloud-source browse — both depend on asset_id to publish items into
//   Finder / build the in-app grid. Does two `$in` Mongo lookups per
//   request; cost grows with collection size.
//
// GET /api/fs/dir-fast?path=<abs>
//   Pure-filesystem variant of `/dir`: readdir + realpath + stat, no Mongo,
//   no EXIF, no sidecars. Used by the Angular Browse grid, which doesn't
//   need any of that (per-image badges / EXIF live in search/timeline).
//   Same paging cursor contract as `/dir`.
//
// GET /api/fs/raw?path=<abs>
//   Streams the original file bytes (Content-Type: application/octet-stream)
//   for the editor to decode. RAW formats feed the FFI/WASM RAW decoder;
//   non-RAW bitmap formats (jpg/heic/png/…) stream their original bytes for
//   the client to decode directly. Allowlist = RAW ∪ SHARP extensions (same
//   set the dir listing + thumb endpoint surface); other extensions 415.
//   Bytes may be served from the library's mirror as well as its primary —
//   see `fs/mirror-read.ts` for the round-robin + failover contract.
//
// All endpoints share the same MAPLE_ROOTS jail and system-directory
// denylist enforced in `../fs/browse.ts`.

import { Elysia, t } from 'elysia';
import { realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import {
  listDir,
  listDirContents,
  listDirFast,
  browseRoots,
  isUnderRoot,
  RAW_EXTENSIONS,
  SHARP_EXTENSIONS,
} from '../fs/browse.ts';
import { resolveOriginalReadSource } from '../fs/mirror-read.ts';
import { child as childLogger } from '../log.ts';
import { computeBodyETag, ifNoneMatchEqual } from '../runtime/http-etag.ts';

const log = childLogger('fs/dir');

/**
 * Resolve symlinks for the jail check, falling back to a lexical resolve when
 * the path can't be walked. An unmounted primary volume ENOENTs every component,
 * which would otherwise 404 the request before the mirror failover below ever
 * ran. The jail check still applies to the resolved result, and failover only
 * ever reads inside an operator-configured mirror root.
 */
async function realpathOrResolve(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return path.resolve(p);
  }
}

export const fsRoutes = new Elysia({ prefix: '/api/fs' })
  .get(
    '/list',
    async ({ query, set }) => {
      const reqPath = query.path;
      const showAll = query.showAll === '1' || query.showAll === 'true';

      const res = await listDir(reqPath, showAll);
      if (!res.ok) {
        set.status = 400;
        return { error: res.error };
      }
      return res.data!;
    },
    {
      query: t.Object({
        path: t.String({ minLength: 1 }),
        showAll: t.Optional(t.String()),
      }),
    },
  )
  // GET /api/fs/roots — the MAPLE_ROOTS jail roots (default ["/"]). Lets a
  // picker start browsing at the configured filesystem root instead of a
  // registered library.
  .get('/roots', async () => {
    return { roots: await browseRoots() };
  })
  .get(
    '/dir',
    async ({ query, headers, set }) => {
      try {
        // Strict integer validation — Number.parseInt accepts partially
        // numeric strings ("10abc" → 10), which contradicts the error
        // message. Pre-check with a regex (same pattern as
        // routes/geocode-reverse.ts and routes/assets.ts).
        let parsedLimit: number | undefined;
        if (query.limit !== undefined) {
          if (!/^\d+$/.test(query.limit)) {
            set.status = 400;
            return { error: `limit must be an integer, got "${query.limit}"` };
          }
          parsedLimit = Number.parseInt(query.limit, 10);
        }
        const res = await listDirContents(query.path, {
          cursor: query.cursor,
          limit: parsedLimit,
        });
        if (!res.ok) {
          // 400 covers "outside MAPLE_ROOTS", "cannot access", and
          // "malformed cursor" — the listDirContents error message
          // distinguishes them.
          set.status = 400;
          return { error: res.error };
        }
        // Body-hash ETag + If-None-Match short-circuit. The File Provider
        // extension uses this on warm folder refreshes to avoid re-decoding
        // unchanged directory listings.
        const body = JSON.stringify(res.data);
        const etag = computeBodyETag(body);
        const ifNoneMatch = headers['if-none-match'];
        if (ifNoneMatchEqual(typeof ifNoneMatch === 'string' ? ifNoneMatch : undefined, etag)) {
          return new Response(null, { status: 304, headers: { ETag: etag } });
        }
        return new Response(body, {
          status: 200,
          headers: { ETag: etag, 'Content-Type': 'application/json' },
        });
      } catch (err) {
        // Defensive: if anything inside listDirContents throws (e.g. a
        // permission edge case on a child entry that escapes the inner
        // try/catch), surface as JSON 500 so the SPA can render a banner
        // instead of getting an opaque error page.
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ path: query.path, err: msg }, 'unhandled error');
        set.status = 500;
        return { error: msg };
      }
    },
    {
      query: t.Object({
        path: t.String({ minLength: 1 }),
        cursor: t.Optional(t.String()),
        limit: t.Optional(t.String()),
      }),
    },
  )
  .get(
    // Pure-filesystem variant of /dir. Used by the Angular Browse grid,
    // which doesn't need EXIF / asset_id / sidecar pairing (those live in
    // the search/timeline grid). Same paging contract as /dir.
    '/dir-fast',
    async ({ query, headers, set }) => {
      try {
        let parsedLimit: number | undefined;
        if (query.limit !== undefined) {
          if (!/^\d+$/.test(query.limit)) {
            set.status = 400;
            return { error: `limit must be an integer, got "${query.limit}"` };
          }
          parsedLimit = Number.parseInt(query.limit, 10);
        }
        const res = await listDirFast(query.path, {
          cursor: query.cursor,
          limit: parsedLimit,
        });
        if (!res.ok) {
          set.status = 400;
          return { error: res.error };
        }
        const body = JSON.stringify(res.data);
        const etag = computeBodyETag(body);
        const ifNoneMatch = headers['if-none-match'];
        if (ifNoneMatchEqual(typeof ifNoneMatch === 'string' ? ifNoneMatch : undefined, etag)) {
          return new Response(null, { status: 304, headers: { ETag: etag } });
        }
        return new Response(body, {
          status: 200,
          headers: { ETag: etag, 'Content-Type': 'application/json' },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ path: query.path, err: msg }, 'unhandled error (dir-fast)');
        set.status = 500;
        return { error: msg };
      }
    },
    {
      query: t.Object({
        path: t.String({ minLength: 1 }),
        cursor: t.Optional(t.String()),
        limit: t.Optional(t.String()),
      }),
    },
  )
  .get(
    '/raw',
    async ({ query, set }) => {
      const reqPath = query.path;
      if (!path.isAbsolute(reqPath)) {
        set.status = 400;
        return { error: 'path must be absolute' };
      }
      const real = await realpathOrResolve(reqPath);
      const roots = await browseRoots();
      if (!roots.some((r) => isUnderRoot(real, r))) {
        set.status = 403;
        return { error: `Path "${real}" is outside MAPLE_ROOTS [${roots.join(', ')}]` };
      }
      const dot = real.lastIndexOf('.');
      const ext = dot >= 0 ? real.slice(dot + 1).toLowerCase() : '';
      // RAW formats stream into the client's FFI/WASM RAW decoder; non-RAW
      // bitmap formats (jpg/heic/png/…) stream their ORIGINAL bytes for the
      // client to decode directly (ImageIO on Apple, the browser on web).
      // Both are just a file byte stream from here — only genuinely
      // unsupported extensions (docs, etc.) 415. Without the sharp branch,
      // non-RAW cloud images can be listed + thumbnailed but never opened
      // full-resolution in the editor (#782).
      if (!RAW_EXTENSIONS.has(ext) && !SHARP_EXTENSIONS.has(ext)) {
        set.status = 415;
        return { error: `Unsupported file extension: "${ext}"` };
      }
      // Originals are immutable (root CLAUDE.md principle 1), so a same-size,
      // same-mtime mirror copy IS the file — reads round-robin across the
      // primary and the library's healthy mirrors to spread load, and fail over
      // to a mirror when the primary volume is unreachable (#926). The stat we
      // report comes from the authoritative copy either way, so Content-Length
      // and ETag are identical whichever replica served.
      const source = await resolveOriginalReadSource(real);
      if (source === null) {
        set.status = 404;
        return { error: `Cannot read "${real}": no readable copy on the primary or a mirror` };
      }
      const st = source.stat;
      // Stream the bytes. Web ReadableStream is built from the Node stream
      // so we don't have to slurp 100MP RAWs (~200MB) into memory.
      const nodeStream = createReadStream(source.path);
      // Cast through `unknown` because @types/node's `node:stream/web`
      // ReadableStream and the DOM ReadableStream lib types don't share a
      // structural overlap (different `getReader` overload signatures), but
      // they're the same runtime type — bun:Response accepts either.
      const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;
      return new Response(webStream, {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(st.size),
          'Cache-Control': 'private, max-age=86400',
          ETag: `"${Math.floor(st.mtimeMs)}-${st.size}"`,
        },
      });
    },
    {
      query: t.Object({
        path: t.String({ minLength: 1 }),
      }),
    },
  );
