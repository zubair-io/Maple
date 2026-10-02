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

import { incompatiblePipelineVersion } from '../../runtime/http-pipeline-version.ts';
import { Elysia } from 'elysia';
import { child as childLogger } from '../../log.ts';
import { ifNoneMatchEqual } from '../../runtime/http-etag.ts';
import { cachePathForAsset } from '../../fs/xmp.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import {
  generatePreview,
  PREVIEW_CACHE_SUFFIX,
  isPreviewCacheFresh,
} from '../../indexer/previewer.ts';
import { assertDerivativeCacheDirectory } from '../../indexer/derivative-cache.ts';
import { isUndecodableFilename } from '../../indexer/media-types.ts';
import { isDecodableRasterExt, lowerExt } from '../fs-jail.ts';
import { previewOndemandLimiter } from '../../indexer/preview-ondemand-limiter.ts';
import {
  safeStat,
  derivativeDecoderUnavailable,
  resolveDerivativeAddress,
  MUTABLE_PREVIEW_CACHE,
  previewFileETag,
  findAssetByAddress,
  parseWildcardSegments,
  serveCachedBytesOr404,
  wildcardSlugParams,
} from './shared.ts';

const log = childLogger('routes/library/preview');

export const previewRoutes = new Elysia().get(
  '/preview/:slug/*',
  // Pre-existing M1-route complexity (wildcard parse, address resolve,
  // indexing-202, on-demand generate, ETag/304). The developed-vs-unedited
  // branch was removed in #2017 (one file per asset), which simplified this.
  // fallow-ignore-next-line complexity
  async ({ params, headers, query, set }) => {
    const versionError = incompatiblePipelineVersion(query.pv, set);
    if (versionError) return versionError;
    const slug = params.slug;
    const wildcard = (params as Record<string, string>)['*'] ?? '';
    const segments = parseWildcardSegments(wildcard);

    const allSegs = segments;
    const filename = allSegs[allSegs.length - 1] ?? '';
    if (!filename) {
      set.status = 400;
      return { error: 'Filename is required' };
    }
    if (isUndecodableFilename(filename)) {
      set.status = 404;
      return { error: 'No preview for this file type' };
    }
    if (!isDecodableRasterExt(lowerExt(filename))) {
      set.status = 415;
      return { error: 'Unsupported image format' };
    }
    const dirSegs = allSegs.slice(0, -1);
    const relDir = dirSegs.join('/');
    const fileRelPath = dirSegs.length > 0 ? `${relDir}/${filename}` : filename;

    const resolved = await resolveDerivativeAddress(slug, fileRelPath, set);
    if ('error' in resolved) return resolved;
    const { libraryId, absPath } = resolved;

    const asset = await findAssetByAddress(libraryId, relDir, filename);

    if (!asset) {
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
    const previewPath = cachePathForAsset(asset, libs, 'previews', PREVIEW_CACHE_SUFFIX);
    if (!previewPath) {
      set.status = 404;
      return { error: 'Cannot resolve preview path for this asset' };
    }

    try {
      await assertDerivativeCacheDirectory(previewPath);
      if (!(await isPreviewCacheFresh(previewPath, absPath))) {
        const unavailable = await derivativeDecoderUnavailable(absPath);
        if (unavailable) {
          set.status = 503;
          return { error: unavailable };
        }
        await previewOndemandLimiter().run(() => generatePreview(absPath, previewPath));
        if (!(await isPreviewCacheFresh(previewPath, absPath))) {
          set.status = 500;
          return { error: 'Preview generation failed' };
        }
      }
    } catch (err) {
      log.warn(
        { absPath, previewPath, err: err instanceof Error ? err.message : err },
        'preview read failed',
      );
      set.status = 500;
      return { error: 'Preview generation failed' };
    }
    const previewSt = await safeStat(previewPath);
    if (!previewSt) {
      set.status = 404;
      return { error: 'Preview file unreadable' };
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
    params: wildcardSlugParams(),
  },
);
