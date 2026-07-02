/**
 * /api/assets metadata + binary reads.
 *
 *   GET /api/assets/:id          — single asset metadata
 *   GET /api/assets/:id/raw      — binary RAW bytes (streaming)
 *   GET /api/assets/:id/thumb    — thumbnail from .maple/ cache
 *
 * Mounted into `assetsRoutes` (see ./index.ts) which provides the
 * `/api/assets` prefix.
 *
 * Mongo access lives in `src/db/assets.repo.ts`.
 */

import { Elysia } from 'elysia';
import { stat } from 'node:fs/promises';
import { resolveThumbPathForAsset } from '../../fs/xmp.ts';
import { safeReadFile } from '../../fs/root.ts';
import { ifNoneMatchEqual } from '../../runtime/http-etag.ts';
import { buildContentDispositionAttachment } from '../../runtime/http-content-disposition.ts';
import { findCoreInfoById, findDetailById, parseAssetId } from '../../db/assets.repo.ts';
import { assetAbsPath } from '../../indexer/images.repo.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';

export const metadataRoutes = new Elysia()
  // Single asset metadata
  .get('/:id', async ({ params, set }) => {
    const id = parseAssetId(params.id);
    if (!id) {
      set.status = 400;
      return { error: 'Invalid asset id' };
    }

    const dto = await findDetailById(id);
    if (!dto) {
      set.status = 404;
      return { error: 'Asset not found' };
    }
    return dto;
  })

  // Stream raw bytes
  .get('/:id/raw', async ({ params, set }) => {
    const id = parseAssetId(params.id);
    if (!id) {
      set.status = 400;
      return { error: 'Invalid asset id' };
    }

    const info = await findCoreInfoById(id);
    if (!info) {
      set.status = 404;
      return { error: 'Asset not found' };
    }

    const libs = await loadLibraryRoots();
    const absPath = assetAbsPath(info, libs);
    if (!absPath) {
      set.status = 404;
      return { error: 'Asset has no resolvable location' };
    }

    const result = await safeReadFile(absPath);
    if (!result.ok) {
      set.status = 403;
      return { error: result.error };
    }

    set.headers['Content-Type'] = 'application/octet-stream';
    // RFC 6266 / RFC 5987 — quoted-string ASCII fallback + percent-encoded
    // UTF-8 form. Guards against header injection from filenames that
    // contain `"`, CR/LF, NUL, or non-ASCII bytes. See #167.
    set.headers['Content-Disposition'] = buildContentDispositionAttachment(info.filename);
    set.headers['Content-Length'] = String(result.data!.byteLength);
    return result.data;
  })

  // Serve thumbnail from .maple/ cache
  .get('/:id/thumb', async ({ params, headers, set }) => {
    const id = parseAssetId(params.id);
    if (!id) {
      set.status = 400;
      return { error: 'Invalid asset id' };
    }

    const info = await findCoreInfoById(id);
    if (!info) {
      set.status = 404;
      return { error: 'Asset not found' };
    }

    // Single per-file thumb (size param is render-target advisory only;
    // the cache key no longer includes size — see fs/xmp.ts).
    // Content-addressed cache key: requires `maple_id` + `fileinfo[0]`.
    // The legacy basename-keyed fallback was retired in the
    // drop-abs-path-2026-05-21 migration.
    const libs = await loadLibraryRoots();
    const thumbPath = resolveThumbPathForAsset(
      { maple_id: info.maple_id ?? undefined, fileinfo: info.fileinfo },
      libs,
    );
    if (!thumbPath) {
      set.status = 404;
      return { error: 'Asset has no resolvable thumbnail location' };
    }

    // Stat the thumb FIRST so a 304-bound request never pays the
    // body-read cost. The previous shape (read then stat) defeated
    // the short-circuit — the disk read happened on every request
    // regardless of If-None-Match. With this order, the only cost on
    // a cache-hit revalidation is one stat() call.
    let etag: string;
    try {
      const st = await stat(thumbPath);
      etag = `"${Math.floor(st.mtimeMs)}-${st.size}"`;
    } catch {
      set.status = 404;
      return { error: 'Thumbnail not yet generated' };
    }

    // RFC 9110 §15.4.5: 304 must carry the same Cache-Control as the
    // 200 path so URLSession's HTTP cache doesn't downgrade freshness
    // on revalidation. Pin the value here and reuse it on both paths.
    const cacheControl = 'public, max-age=604800, immutable';
    const ifNoneMatch = headers['if-none-match'];
    if (ifNoneMatchEqual(typeof ifNoneMatch === 'string' ? ifNoneMatch : undefined, etag)) {
      return new Response(null, {
        status: 304,
        headers: { ETag: etag, 'Cache-Control': cacheControl },
      });
    }

    // Cache miss — now do the body read.
    const result = await safeReadFile(thumbPath);
    if (!result.ok) {
      // Race: stat succeeded but read failed (file removed between
      // calls, or jail-rejected). Treat as 404 either way.
      set.status = 404;
      return { error: 'Thumbnail not yet generated' };
    }
    set.headers['ETag'] = etag;
    set.headers['Content-Type'] = 'image/jpeg';
    set.headers['Cache-Control'] = cacheControl;
    return result.data;
  });
