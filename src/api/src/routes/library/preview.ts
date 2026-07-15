/**
 * GET /api/preview/:slug/*
 *
 * Serves the single `<filename>.avif` preview for an indexed image (#2017) —
 * one unversioned file per asset, generated on a cold-cache miss. ETag is the
 * preview file's own mtime + size, so an in-place overwrite by the editor
 * busts it automatically; Cache-Control is `must-revalidate` (not immutable)
 * so clients pick up that overwrite. Honors If-None-Match for 304 responses.
 *
 * Uses `cachePathForAsset(asset, libs, 'previews', PREVIEW_CACHE_SUFFIX)` —
 * the same path as the `preview` stage — so the cache is shared between the
 * background stage and on-demand generation from this route.
 */

import { Elysia, t } from 'elysia';
import { resolveAddress } from '../../library/address.ts';
import { child as childLogger } from '../../log.ts';
import { ifNoneMatchEqual } from '../../runtime/http-etag.ts';
import { cachePathForAsset } from '../../fs/xmp.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import { generatePreview, PREVIEW_CACHE_SUFFIX } from '../../indexer/previewer.ts';
import { previewOndemandLimiter } from '../../indexer/preview-ondemand-limiter.ts';
import {
  safeStat,
  MUTABLE_PREVIEW_CACHE,
  previewFileETag,
  findAssetByAddress,
  parseWildcardSegments,
  serveCachedBytesOr404,
} from './shared.ts';

const log = childLogger('routes/library/preview');

export const previewRoutes = new Elysia().get(
  '/preview/:slug/*',
  // Pre-existing M1-route complexity (wildcard parse, address resolve,
  // indexing-202, on-demand generate, ETag/304). The developed-vs-unedited
  // branch was removed in #2017 (one file per asset), which simplified this.
  // fallow-ignore-next-line complexity
  async ({ params, headers, set }) => {
    const slug = params.slug;
    const wildcard = (params as Record<string, string>)['*'] ?? '';
    const segments = parseWildcardSegments(wildcard);

    const allSegs = segments;
    const filename = allSegs[allSegs.length - 1] ?? '';
    if (!filename) {
      set.status = 400;
      return { error: 'Filename is required' };
    }
    const dirSegs = allSegs.slice(0, -1);
    const relDir = dirSegs.join('/');
    const fileRelPath = dirSegs.length > 0 ? `${relDir}/${filename}` : filename;

    let resolved: Awaited<ReturnType<typeof resolveAddress>>;
    try {
      resolved = await resolveAddress(slug, fileRelPath);
    } catch (err) {
      const e = err as { status?: number; message?: string };
      set.status = e.status ?? 500;
      return { error: e.message ?? 'Internal error' };
    }

    const { libraryId, absPath } = resolved;

    const asset = await findAssetByAddress(libraryId, relDir, filename);

    if (!asset || !asset.maple_id) {
      const diskSt = await safeStat(absPath);
      if (!diskSt) {
        set.status = 404;
        return { error: 'File not found' };
      }
      set.status = 202;
      set.headers['Retry-After'] = '2';
      return {
        status: 'indexing',
        message: 'Image not yet indexed; retry shortly',
      };
    }

    const libs = await loadLibraryRoots();
    const previewPath = cachePathForAsset(
      { maple_id: asset.maple_id as string, fileinfo: asset.fileinfo as never },
      libs,
      'previews',
      PREVIEW_CACHE_SUFFIX,
    );
    if (!previewPath) {
      set.status = 404;
      return { error: 'Cannot resolve preview path for this asset' };
    }

    // Ensure the preview exists, then derive the ETag from the file itself so
    // an in-place overwrite (the editor saving a developed preview) busts it —
    // there is no size/version token in the name to key off instead.
    let previewSt = await safeStat(previewPath);
    if (!previewSt) {
      try {
        // Bound concurrent on-demand regeneration in this API process — see
        // preview-ondemand-limiter.ts. Protects live-request latency from a
        // synchronized cache-miss burst (e.g. opening a large NAS folder
        // shortly after the #2017 rename migration, before the background
        // `preview` stage has caught every asset up).
        await previewOndemandLimiter().run(() => generatePreview(absPath, previewPath));
      } catch (err) {
        log.warn(
          {
            absPath,
            previewPath,
            err: err instanceof Error ? err.message : err,
          },
          'on-demand preview generation failed',
        );
        set.status = 500;
        return { error: 'Preview generation failed' };
      }
      previewSt = await safeStat(previewPath);
      if (!previewSt) {
        set.status = 500;
        return { error: 'Preview generation failed' };
      }
    }

    const etag = previewFileETag(previewSt);
    const ifNoneMatch = headers['if-none-match'];
    if (ifNoneMatchEqual(typeof ifNoneMatch === 'string' ? ifNoneMatch : undefined, etag)) {
      return new Response(null, {
        status: 304,
        headers: { ETag: etag, 'Cache-Control': MUTABLE_PREVIEW_CACHE },
      });
    }

    return serveCachedBytesOr404(
      set,
      previewPath,
      'image/avif',
      etag,
      'Preview file unreadable',
      MUTABLE_PREVIEW_CACHE,
    );
  },
  {
    params: t.Object({
      slug: t.String({ minLength: 1 }),
      '*': t.Optional(t.String()),
    }),
  },
);
