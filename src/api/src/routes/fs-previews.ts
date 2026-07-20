// src/api/src/routes/fs-previews.ts
//
// GET /api/fs/preview?path=<abs-path-to-image>
//   Returns the display-resolution (1280 px long-edge) `image/avif` preview
//   for the image at `path` — the path-addressed sibling of `/api/fs/thumb`
//   for clients that browse by absolute path (the Apple `CloudSource` /
//   `CloudThumbClient` fs-walk flow). `/api/fs/thumb` cannot serve this tier:
//   it keeps ONE cache file per RAW with an mtime-only freshness check, so a
//   `size=2048` request just returns the cached 512 px grid thumb.
//
//   Cache: `.maple/previews/` next to the image. When the indexer has an
//   asset row for this file, the path-keyed `<filename>.avif` written by the
//   background `preview` stage is used — shared artifact, no duplicate render
//   (no `maple_id` needed, unlike thumbs — see `cachePathForAsset`'s doc).
//   Un-indexed files (no DB row yet, or DB unreachable) fall back to the
//   basename-keyed `<filename>.avif` and are generated on demand via the same
//   `generatePreview` the stage uses (which also owns the mtime staleness
//   check).
//
//   The preview is a single, unversioned file overwritten in place (#2017),
//   so the served ETag is the preview FILE's mtime + size (not the source
//   RAW's — its mtime is unchanged by an edit) and Cache-Control is
//   `must-revalidate`, so an in-place overwrite busts client caches.
//
// Auth: this Elysia plugin must be `.use()`d AFTER `requireAuth` in
// `index.ts` so callers must present a valid bearer.
//
// Jail: same `MAPLE_ROOTS` policy as `/api/fs/thumb`, via the shared
// `resolveJailedFile` preamble in fs-jail.ts.

import { Elysia, t } from 'elysia';
import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { ObjectId } from 'mongodb';
import { isUnderRoot } from '../fs/browse.ts';
import { cachePathFor, cachePathForAsset } from '../fs/xmp.ts';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';
import {
  generatePreview,
  isPreviewCacheFresh,
  PREVIEW_CACHE_SUFFIX,
} from '../indexer/previewer.ts';
import { previewOndemandLimiter } from '../indexer/preview-ondemand-limiter.ts';
import { isVideoFilename } from '../indexer/media-types.ts';
import { ffmpegBinary } from '../thumbs/video-poster.ts';
import { isDbConnected } from '../db/client.ts';
import { findAssetByAddress, previewFileETag, MUTABLE_PREVIEW_CACHE } from './library/shared.ts';
import { resolveJailedFile, notModifiedResponse } from './fs-jail.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('fs-previews');

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
    return {
      libraryIdHex,
      relDir: dir === '.' ? '' : dir,
      filename: path.basename(rel),
    };
  }
  return null;
}

/**
 * Resolve the on-disk preview cache path for `real`. Prefers the indexer's
 * path-keyed `<filename>.avif` (needs only an asset row with `fileinfo`, not
 * `maple_id` — see `cachePathForAsset`'s doc); falls back to the basename-keyed
 * path when there's no asset row at all yet. The DB lookup is best-effort —
 * any failure (lookup error, DB down) degrades to the fallback path rather
 * than failing the request.
 */
async function resolvePreviewCachePath(real: string): Promise<string> {
  const legacy = () => cachePathFor(real, 'previews', PREVIEW_CACHE_SUFFIX);
  // `lookupAssetByReal` is a no-op when Mongo isn't connected — attempting a
  // lookup while it's down would eat the driver's 5 s server-selection timeout
  // on EVERY request; the legacy basename path serves immediately instead
  // (Copilot review, PR #1907).
  try {
    const asset = await lookupAssetByReal(real);
    if (asset) {
      const libs = await loadLibraryRoots();
      const pathKeyed = cachePathForAsset(
        {
          maple_id: asset.maple_id as string | undefined,
          fileinfo: asset.fileinfo as never,
        },
        libs,
        'previews',
        PREVIEW_CACHE_SUFFIX,
      );
      if (pathKeyed) return pathKeyed;
    }
  } catch (err) {
    log.debug(
      { real, err: err instanceof Error ? err.message : err },
      'asset lookup failed; using legacy basename-keyed preview path',
    );
  }
  return legacy();
}

/** Look up the indexed asset for a symlink-resolved path, or null (un-indexed
 * / DB down / no matching library). Used by `resolvePreviewCachePath` to key
 * the shared path-keyed cache off the asset's `fileinfo`. */
async function lookupAssetByReal(real: string) {
  if (!isDbConnected()) return null;
  const libs = await loadLibraryRoots();
  const addr = libraryAddressFor(real, libs);
  if (!addr) return null;
  return findAssetByAddress(new ObjectId(addr.libraryIdHex), addr.relDir, addr.filename);
}

/**
 * The operator-facing 503 message when `real` is a video and this host has no
 * runnable ffmpeg, or null when the request can proceed.
 *
 * Video reaches this route as of #2132; its preview is an ffmpeg poster frame.
 * Answering the missing-decoder case up front matters because otherwise
 * `generatePreview` writes nothing and the request lands on the generic
 * "Preview generation failed" 500 below — which reads as a server fault when
 * it is really an uninstalled dependency the operator can fix.
 *
 * A named helper rather than an inline guard: the route handler is already at
 * the edge of the complexity gate, and this keeps the branch out of it.
 */
async function videoDecoderUnavailable(real: string): Promise<string | null> {
  if (!isVideoFilename(real)) return null;
  return (await ffmpegBinary())
    ? null
    : 'Video previews need ffmpeg on the server — install it and retry (no restart needed)';
}

export const fsPreviewsRoutes = new Elysia({ prefix: '/api/fs' }).get(
  '/preview',
  async ({ query, headers, set }) => {
    const resolved = await resolveJailedFile(query.path);
    if (!resolved.ok) {
      set.status = resolved.status;
      return { error: resolved.error };
    }
    const { real } = resolved;

    const noDecoder = await videoDecoderUnavailable(real);
    if (noDecoder) {
      set.status = 503;
      return { error: noDecoder };
    }

    const previewPath = await resolvePreviewCachePath(real);

    // `generatePreview` owns mkdir, the mtime staleness check (fresh cache →
    // fast return), and the RAW-FFI / sharp / PSD render dispatch. It logs
    // failures instead of throwing; a missing output file below is the
    // failure signal.
    //
    // Only route a genuine cache MISS through the on-demand concurrency
    // limiter (preview-ondemand-limiter.ts) — a warm cache is two cheap
    // `stat` calls (which `generatePreview` would just repeat and no-op on),
    // and gating that too would make it queue behind unrelated cold-cache
    // regeneration work during a migration burst, hurting the common (warm)
    // case to protect against the rare (cold) one.
    if (!(await isPreviewCacheFresh(previewPath, real))) {
      await previewOndemandLimiter().run(() => generatePreview(real, previewPath));
    }

    // ETag from the preview FILE (mtime + size), not the source RAW: the
    // preview is overwritten in place on edit while the RAW's mtime is
    // unchanged, so a source-keyed ETag would never bust across edits (#2017).
    let previewStat: Awaited<ReturnType<typeof stat>>;
    try {
      previewStat = await stat(previewPath);
    } catch (err) {
      log.warn(
        { real, previewPath, err: err instanceof Error ? err.message : err },
        'preview generation produced no readable file',
      );
      set.status = 500;
      return { error: 'Preview generation failed (see server log)' };
    }

    const etag = previewFileETag(previewStat);
    const cached304 = notModifiedResponse(headers['if-none-match'], etag, MUTABLE_PREVIEW_CACHE);
    if (cached304) return cached304;

    let bytes: Buffer;
    try {
      bytes = await readFile(previewPath);
    } catch (err) {
      log.warn(
        { real, previewPath, err: err instanceof Error ? err.message : err },
        'preview file unreadable after generation',
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
        'Content-Type': 'image/avif',
        'Cache-Control': MUTABLE_PREVIEW_CACHE,
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
