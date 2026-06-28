/**
 * GET /api/thumb/:slug/*
 *
 * Returns the content-keyed thumbnail JPEG for an indexed image.
 * ETag: "<maple_id>", Cache-Control: public, max-age=31536000, immutable.
 * Honors If-None-Match for 304 responses.
 *
 * If the image is on disk but not yet indexed (no maple_id), returns 202
 * with Retry-After: 2 so the client retries after the discover scan
 * completes.
 *
 * If the thumb file doesn't exist yet, generates it on-demand via the
 * existing thumb stage renderer (generateThumb).
 */

import { Elysia, t } from 'elysia';
import { resolveAddress } from '../../library/address.ts';
import { child as childLogger } from '../../log.ts';
import { ifNoneMatchEqual } from '../../runtime/http-etag.ts';
import { resolveThumbPath, resolveThumbPathForAsset } from '../../fs/xmp.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import { generateThumb } from '../../indexer/thumbnailer.ts';
import { isVideoFilename } from '../../indexer/media-types.ts';
import {
  safeStat,
  safeReadBytes,
  IMMUTABLE_CACHE,
  findAssetByAddress,
  parseWildcardSegments,
} from './shared.ts';

const log = childLogger('routes/library/thumb');

// Dedupe concurrent on-the-fly generation for the same source path: a folder
// open fires many thumb requests at once, and without this a burst for one
// un-indexed image would launch N overlapping generateThumb writes to the same
// file (thundering herd / torn reads). generateThumb is itself idempotent and
// mtime-guarded; this just collapses the in-flight overlap to a single render.
const inflightThumbGen = new Map<string, Promise<void>>();
function generateThumbDeduped(absPath: string): Promise<void> {
  let p = inflightThumbGen.get(absPath);
  if (!p) {
    p = generateThumb(absPath).finally(() => inflightThumbGen.delete(absPath));
    inflightThumbGen.set(absPath, p);
  }
  return p;
}

export const thumbRoutes = new Elysia().get(
  '/thumb/:slug/*',
  async ({ params, headers, set }) => {
    const slug = params.slug;
    const wildcard = (params as Record<string, string>)['*'] ?? '';
    const segments = parseWildcardSegments(wildcard);

    // Split the last segment off as the filename; the rest is the relative dir.
    const filename = segments[segments.length - 1] ?? '';
    if (!filename) {
      set.status = 400;
      return { error: 'Filename is required' };
    }
    // Video containers have no server-side poster yet. Extracting a frame
    // requires ffmpeg or a native video decoder — a dependency not currently
    // bundled. The grid renders a video placeholder on 404. Apple clients get
    // a poster via AVAssetImageGenerator (shipped in #1642).
    // Follow-up: #1649 (server-side video poster via platform ffmpeg or WASM).
    if (isVideoFilename(filename)) {
      set.status = 404;
      return { error: 'No thumbnail for video assets' };
    }

    const dirSegs = segments.slice(0, -1);
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

    // Look up the asset in the catalog by (library_id, dir, filename).
    const asset = await findAssetByAddress(libraryId, relDir, filename);

    if (!asset || !asset.maple_id) {
      // Not indexed yet — but the file is on disk, so render the thumbnail on
      // the fly instead of making the grid wait for the indexer (which may be
      // idle/behind — file_count can sit at 0). Keyed by file path via
      // resolveThumbPath (no maple_id needed); for RAW this extracts the
      // embedded preview JPEG (cheap), non-RAW goes through sharp. Once the
      // indexer assigns a maple_id the content-keyed branch below takes over.
      const diskSt = await safeStat(absPath);
      if (!diskSt) {
        set.status = 404;
        return { error: 'File not found' };
      }
      // Weak, revalidating validator from the SOURCE file's mtime+size — a
      // path-keyed pre-index thumb is NOT content-immutable (the file may
      // change, and indexing will later serve a different content-keyed image
      // at this same URL), so it must never be cached `immutable`. Computed and
      // checked BEFORE any generation/read so a revalidation 304s without
      // touching disk or rendering; the browser picks up the indexed version
      // later on its own revalidation.
      const wEtag = `W/"u-${Math.trunc(diskSt.mtimeMs)}-${diskSt.size}"`;
      const revalidateCache = 'private, max-age=10, must-revalidate';
      const ifNoneMatchU = headers['if-none-match'];
      if (ifNoneMatchEqual(typeof ifNoneMatchU === 'string' ? ifNoneMatchU : undefined, wEtag)) {
        return new Response(null, {
          status: 304,
          headers: { ETag: wEtag, 'Cache-Control': revalidateCache },
        });
      }
      const thumbPath = resolveThumbPath(absPath);
      // Call generateThumb UNCONDITIONALLY (not only when the thumb is missing):
      // it has its own size+mtime staleness guard, so if the source changed
      // since a prior render it regenerates instead of serving stale bytes under
      // a fresh source-derived ETag; if the thumb still covers the source it's a
      // cheap two-stat no-op. Deduped per source path against the request burst.
      try {
        await generateThumbDeduped(absPath);
      } catch (err) {
        log.warn(
          { absPath, thumbPath, err: err instanceof Error ? err.message : err },
          'on-demand thumb generation failed (unindexed)',
        );
        set.status = 500;
        return { error: 'Thumbnail generation failed' };
      }
      const bytes = await safeReadBytes(thumbPath);
      if (!bytes) {
        set.status = 404;
        return { error: 'Thumbnail file unreadable' };
      }
      return new Response(bytes as unknown as BodyInit, {
        status: 200,
        headers: {
          'Content-Type': 'image/jpeg',
          ETag: wEtag,
          'Cache-Control': revalidateCache,
        },
      });
    }

    // ETag is the maple_id (content-keyed = stable until content changes).
    const etag = `"${asset.maple_id}"`;
    const ifNoneMatch = headers['if-none-match'];
    if (ifNoneMatchEqual(typeof ifNoneMatch === 'string' ? ifNoneMatch : undefined, etag)) {
      return new Response(null, {
        status: 304,
        headers: { ETag: etag, 'Cache-Control': IMMUTABLE_CACHE },
      });
    }

    // Resolve thumb path.
    const libs = await loadLibraryRoots();
    const thumbPath = resolveThumbPathForAsset(
      { maple_id: asset.maple_id as string, fileinfo: asset.fileinfo as never },
      libs,
    );
    if (!thumbPath) {
      set.status = 404;
      return { error: 'Cannot resolve thumbnail path for this asset' };
    }

    // Generate the thumb if it's missing.
    const thumbSt = await safeStat(thumbPath);
    if (!thumbSt) {
      try {
        await generateThumb(absPath, thumbPath);
      } catch (err) {
        log.warn(
          { absPath, thumbPath, err: err instanceof Error ? err.message : err },
          'on-demand thumb generation failed',
        );
        set.status = 500;
        return { error: 'Thumbnail generation failed' };
      }
    }

    const bytes = await safeReadBytes(thumbPath);
    if (!bytes) {
      set.status = 404;
      return { error: 'Thumbnail file unreadable' };
    }

    return new Response(bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'image/jpeg',
        ETag: etag,
        'Cache-Control': IMMUTABLE_CACHE,
      },
    });
  },
  {
    params: t.Object({
      slug: t.String({ minLength: 1 }),
      '*': t.Optional(t.String()),
    }),
  },
);
