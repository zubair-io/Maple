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
// Jail: same `MAPLE_ROOTS` policy as `/api/fs/thumb` — paths are realpath-
// resolved and rejected if they fall outside any allowed root.

import { Elysia, t } from 'elysia';
import { stat, readFile, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { ObjectId } from 'mongodb';
import {
  browseRoots,
  isUnderRoot,
  RAW_EXTENSIONS,
  SHARP_EXTENSIONS,
  PSD_HDR_EXTENSIONS,
} from '../fs/browse.ts';
import { cachePathFor, cachePathForAsset } from '../fs/xmp.ts';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';
import { generatePreview, PREVIEW_SIZE_KEY } from '../indexer/previewer.ts';
import { findAssetByAddress } from './library/shared.ts';
import { child as childLogger } from '../log.ts';
import { ifNoneMatchEqual } from '../runtime/http-etag.ts';

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
    return { libraryIdHex, relDir: dir === '.' ? '' : dir, filename: path.basename(rel) };
  }
  return null;
}

/**
 * Resolve the on-disk preview cache path for `real`. Prefers the indexer's
 * content-addressed `<maple_id>_1280.jpg`; falls back to the legacy
 * basename-keyed path when the asset isn't indexed yet. The DB lookup is
 * best-effort — any failure (Mongo down, malformed id) degrades to the
 * legacy path rather than failing the request.
 */
async function resolvePreviewCachePath(real: string): Promise<string> {
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
    const reqPath = query.path;

    if (!path.isAbsolute(reqPath)) {
      set.status = 400;
      return { error: 'path must be absolute' };
    }

    // Resolve symlinks so the jail check matches the parent realpath form
    // (mirrors `/api/fs/thumb` on macOS where /var → /private/var).
    let real: string;
    try {
      real = await realpath(reqPath);
    } catch (err) {
      set.status = 404;
      return {
        error: `Cannot access "${reqPath}": ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const roots = await browseRoots();
    if (!roots.some((r) => isUnderRoot(real, r))) {
      set.status = 403;
      return {
        error: `Path "${real}" is outside MAPLE_ROOTS [${roots.join(', ')}]`,
      };
    }

    // Extension gate — same decodable-raster policy as `/api/fs/thumb`.
    // Video/stub/audio formats have no still frame and 415 here.
    const dot = real.lastIndexOf('.');
    const ext = dot >= 0 ? real.slice(dot + 1).toLowerCase() : '';
    if (!RAW_EXTENSIONS.has(ext) && !SHARP_EXTENSIONS.has(ext) && !PSD_HDR_EXTENSIONS.has(ext)) {
      set.status = 415;
      return { error: `Unsupported file extension: "${ext}"` };
    }

    let srcStat: Awaited<ReturnType<typeof stat>>;
    try {
      srcStat = await stat(real);
    } catch (err) {
      set.status = 404;
      return {
        error: `Cannot stat "${real}": ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!srcStat.isFile()) {
      set.status = 400;
      return { error: `"${real}" is not a regular file` };
    }

    // ETag composes source mtime + size (same validator shape as
    // `/api/fs/thumb`); Cache-Control echoed on 200 and 304 per RFC 9110
    // §15.4.5 so URLSession doesn't downgrade freshness on revalidation.
    const etag = `"${Math.floor(srcStat.mtimeMs)}-${srcStat.size}"`;
    const cacheControl = 'private, max-age=3600';

    const ifNoneMatch = headers['if-none-match'];
    if (ifNoneMatchEqual(typeof ifNoneMatch === 'string' ? ifNoneMatch : undefined, etag)) {
      return new Response(null, {
        status: 304,
        headers: { ETag: etag, 'Cache-Control': cacheControl },
      });
    }

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

    const ab = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    return new Response(ab, {
      status: 200,
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': cacheControl,
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
