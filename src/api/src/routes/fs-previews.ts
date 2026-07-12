// src/api/src/routes/fs-previews.ts
//
// GET /api/fs/preview?path=<abs-path-to-image>
//   Returns the display-resolution (1280 px long-edge) `image/jpeg` preview
//   for the image at `path` — the path-addressed sibling of `/api/fs/thumb`
//   for clients that browse by absolute path (the Apple `CloudSource` /
//   `CloudThumbClient` fs-walk flow). `/api/fs/thumb` cannot serve this tier:
//   it keeps ONE cache file per RAW with an mtime-only freshness check, so a
//   `size=2048` request just returns the cached 512 px grid thumb.
//
//   Cache: `.maple/previews/` next to the image. When the indexer has already
//   assigned the asset a `maple_id`, the content-addressed
//   `<maple_id>_1280.jpg` written by the background `preview` stage is used —
//   shared artifact, no duplicate render. Un-indexed files fall back to the
//   legacy basename-keyed `<basename_no_ext>_1280.jpg` and are generated on
//   demand via the same `generatePreview` the stage uses (which also owns the
//   mtime staleness check).
//
// Auth: this Elysia plugin must be `.use()`d AFTER `requireAuth` in
// `index.ts` so callers must present a valid bearer.
//
// Jail: same `MAPLE_ROOTS` policy as `/api/fs/thumb`, via the shared
// `resolveJailedFile` preamble in fs-jail.ts.

import { Elysia, t } from 'elysia';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { ObjectId } from 'mongodb';
import { isUnderRoot } from '../fs/browse.ts';
import { cachePathFor, cachePathForAsset } from '../fs/xmp.ts';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';
import { generatePreview, PREVIEW_SIZE_KEY } from '../indexer/previewer.ts';
import { isDbConnected } from '../db/client.ts';
import { findAssetByAddress } from './library/shared.ts';
import { resolveJailedFile, sourceETag, notModifiedResponse } from './fs-jail.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('fs-previews');

const CACHE_CONTROL = 'private, max-age=3600';

/**
 * Split `real` into (libraryIdHex, relDir, filename) against the registered
 * library roots. Returns null when `real` is not under any registered
 * library (e.g. a MAPLE_ROOTS browse path that isn't an indexed library).
 * Pure over the roots map — exported for unit tests.
 */
export function libraryAddressFor(
  real: string,
  roots: ReadonlyMap<string, string>,
): { libraryIdHex: string; relDir: string; filename: string } | null {
  for (const [libraryIdHex, root] of roots) {
    const r = root.replace(/\/$/, '') || '/';
    if (!isUnderRoot(real, r)) continue;
    const rel = r === '/' ? real.slice(1) : real.slice(r.length + 1);
    const dir = path.dirname(rel);
    return { libraryIdHex, relDir: dir === '.' ? '' : dir, filename: path.basename(rel) };
  }
  return null;
}

/**
 * Resolve the on-disk preview cache path for `real`. Prefers the indexer's
 * content-addressed `<maple_id>_1280.jpg`; falls back to the legacy
 * basename-keyed path when the asset isn't indexed yet. The DB lookup is
 * best-effort — any failure (malformed id, lookup error) degrades to the
 * legacy path rather than failing the request.
 */
async function resolvePreviewCachePath(real: string): Promise<string> {
  // Only consult the DB when the process already holds a live connection
  // (the server connects at boot). Attempting a lookup while Mongo is down
  // would eat the driver's 5 s server-selection timeout on EVERY request
  // before falling back — the legacy path can serve immediately instead
  // (Copilot review, PR #1907).
  if (!isDbConnected()) {
    return cachePathFor(real, 'previews', PREVIEW_SIZE_KEY);
  }
  try {
    const libs = await loadLibraryRoots();
    const addr = libraryAddressFor(real, libs);
    if (addr) {
      const asset = await findAssetByAddress(
        new ObjectId(addr.libraryIdHex),
        addr.relDir,
        addr.filename,
      );
      if (asset?.maple_id) {
        const contentAddressed = cachePathForAsset(
          { maple_id: asset.maple_id as string, fileinfo: asset.fileinfo as never },
          libs,
          'previews',
          PREVIEW_SIZE_KEY,
        );
        if (contentAddressed) return contentAddressed;
      }
    }
  } catch (err) {
    log.debug(
      { real, err: err instanceof Error ? err.message : err },
      'asset lookup failed; using legacy basename-keyed preview path',
    );
  }
  return cachePathFor(real, 'previews', PREVIEW_SIZE_KEY);
}

export const fsPreviewsRoutes = new Elysia({ prefix: '/api/fs' }).get(
  '/preview',
  async ({ query, headers, set }) => {
    const resolved = await resolveJailedFile(query.path);
    if (!resolved.ok) {
      set.status = resolved.status;
      return { error: resolved.error };
    }
    const { real, stat: srcStat } = resolved;

    const etag = sourceETag(srcStat);
    const cached304 = notModifiedResponse(headers['if-none-match'], etag, CACHE_CONTROL);
    if (cached304) return cached304;

    const previewPath = await resolvePreviewCachePath(real);

    // `generatePreview` owns mkdir, the mtime staleness check (fresh cache →
    // fast return), and the RAW-FFI / sharp / PSD render dispatch. It logs
    // failures instead of throwing; a missing output file below is the
    // failure signal.
    await generatePreview(real, previewPath);

    let bytes: Buffer;
    try {
      bytes = await readFile(previewPath);
    } catch (err) {
      log.warn(
        { real, previewPath, err: err instanceof Error ? err.message : err },
        'preview generation produced no readable file',
      );
      set.status = 500;
      return { error: 'Preview generation failed (see server log)' };
    }

    // `Buffer` extends `Uint8Array`, which Bun's `Response` accepts directly
    // — no ArrayBuffer copy needed (Jules review, PR #1907). The cast is
    // type-level only: TS's DOM `BodyInit` excludes Buffer's ArrayBufferLike
    // backing, but the bytes are passed through zero-copy at runtime.
    return new Response(bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': CACHE_CONTROL,
        ETag: etag,
      },
    });
  },
  {
    query: t.Object({
      path: t.String({ minLength: 1 }),
    }),
  },
);
