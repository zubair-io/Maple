import { incompatiblePipelineVersion } from '../../runtime/http-pipeline-version.ts';
import { Elysia, type Context } from 'elysia';
import { child as childLogger } from '../../log.ts';
import { computeBodyETag, ifNoneMatchEqual } from '../../runtime/http-etag.ts';
import { resolveThumbPath, resolveThumbPathForAsset } from '../../fs/xmp.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import { generateThumb } from '../../indexer/thumbnailer.ts';
import {
  assertDerivativeCacheDirectory,
  isDerivativeCacheFresh,
} from '../../indexer/derivative-cache.ts';
import { PIPELINE_OUTPUT_VERSION } from '../../generated/adjustment-fields.generated.ts';
import { isUndecodableFilename } from '../../indexer/media-types.ts';
import { isDecodableRasterExt, lowerExt } from '../fs-jail.ts';
import {
  safeStat,
  safeReadBytes,
  MUTABLE_PREVIEW_CACHE,
  findAssetByAddress,
  parseWildcardSegments,
  wildcardSlugParams,
  derivativeDecoderUnavailable,
  resolveDerivativeAddress,
} from './shared.ts';

const log = childLogger('routes/library/thumb');
const inflightThumbGen = new Map<string, Promise<void>>();

function generateThumbDeduped(absPath: string, thumbPath: string): Promise<void> {
  const existing = inflightThumbGen.get(thumbPath);
  if (existing) return existing;
  const pending = generateThumb(absPath, thumbPath).finally(() =>
    inflightThumbGen.delete(thumbPath),
  );
  inflightThumbGen.set(thumbPath, pending);
  return pending;
}

async function serveThumb(
  absPath: string,
  thumbPath: string,
  ifNoneMatch: string | undefined,
  set: Context['set'],
): Promise<Response | { error: string }> {
  try {
    await assertDerivativeCacheDirectory(thumbPath);
    const fresh = await isDerivativeCacheFresh(thumbPath, absPath);
    if (!fresh) {
      const unavailable = await derivativeDecoderUnavailable(absPath);
      if (unavailable) {
        set.status = 503;
        return { error: unavailable };
      }
      await generateThumbDeduped(absPath, thumbPath);
      if (!(await isDerivativeCacheFresh(thumbPath, absPath))) {
        set.status = 404;
        return { error: 'Thumbnail generation failed' };
      }
    }
    const bytes = await safeReadBytes(thumbPath);
    if (!bytes) {
      set.status = 404;
      return { error: 'Thumbnail file unreadable' };
    }
    const etag = computeBodyETag(bytes);
    const unchanged = ifNoneMatchEqual(ifNoneMatch, etag);
    return new Response(unchanged ? null : (bytes as unknown as BodyInit), {
      status: unchanged ? 304 : 200,
      headers: {
        'Content-Type': 'image/avif',
        'X-Maple-Pipeline-Version': String(PIPELINE_OUTPUT_VERSION),
        ETag: etag,
        'Cache-Control': MUTABLE_PREVIEW_CACHE,
        'X-Thumb-Cache': fresh ? 'hit' : 'miss',
      },
    });
  } catch (err) {
    log.warn(
      { absPath, thumbPath, err: err instanceof Error ? err.message : err },
      'thumbnail read failed',
    );
    set.status = 500;
    return { error: 'Thumbnail generation failed' };
  }
}

export const thumbRoutes = new Elysia().get(
  '/thumb/:slug/*',
  async ({ params, headers, query, set }) => {
    const versionError = incompatiblePipelineVersion(query.pv, set);
    if (versionError) return versionError;
    const segments = parseWildcardSegments((params as Record<string, string>)['*'] ?? '');
    const filename = segments.at(-1) ?? '';
    if (!filename) {
      set.status = 400;
      return { error: 'Filename is required' };
    }
    if (isUndecodableFilename(filename)) {
      set.status = 404;
      return { error: 'No thumbnail for this file type' };
    }
    if (!isDecodableRasterExt(lowerExt(filename))) {
      set.status = 415;
      return { error: 'Unsupported image format' };
    }
    const resolved = await resolveDerivativeAddress(params.slug, segments.join('/'), set);
    if ('error' in resolved) return resolved;
    const { libraryId, absPath } = resolved;
    const asset = await findAssetByAddress(libraryId, segments.slice(0, -1).join('/'), filename);
    if (!asset?.maple_id && !(await safeStat(absPath))?.isFile()) {
      set.status = 404;
      return { error: 'File not found' };
    }
    const thumbPath = asset?.maple_id
      ? resolveThumbPathForAsset(asset, await loadLibraryRoots())
      : resolveThumbPath(absPath);
    if (!thumbPath) {
      set.status = 404;
      return { error: 'Cannot resolve thumbnail path for this asset' };
    }
    return serveThumb(absPath, thumbPath, headers['if-none-match'], set);
  },
  { params: wildcardSlugParams() },
);
