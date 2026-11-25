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
import { isUndecodableFilename } from '../../indexer/media-types.ts';
import { isDecodableRasterExt, lowerExt } from '../fs-jail.ts';
import { readVersionedThumb } from '../../library/thumb-version.ts';
import {
  safeStat,
  safeReadBytes,
  MUTABLE_PREVIEW_CACHE,
  findAssetByAddress,
  parseWildcardSegments,
  wildcardSlugParams,
  derivativeDecoderUnavailable,
  derivativeGenerationFailure,
  resolveDerivativeAddress,
} from './shared.ts';

/** Tells the Cloudflare thumb Worker not to mirror this response into R2 (#4750). */
const EDGE_CACHEABLE_HEADER = 'X-Maple-Cacheable';
/** The Worker records this beside the R2 copy, so it can answer a matching `?v=` itself (#6016). */
const THUMB_VERSION_HEADER = 'X-Maple-Thumb-Version';
/** A `?v=` URL names one thumb file's bytes; a re-render changes the version, never these bytes. */
const VERSIONED_THUMB_CACHE = 'private, max-age=31536000, immutable';

const log = childLogger('routes/library/thumb');
const inflightThumbGen = new Map<string, Promise<boolean>>();

function generateThumbDeduped(absPath: string, thumbPath: string): Promise<boolean> {
  const existing = inflightThumbGen.get(thumbPath);
  if (existing) return existing;
  const pending = generateThumb(absPath, thumbPath).finally(() =>
    inflightThumbGen.delete(thumbPath),
  );
  inflightThumbGen.set(thumbPath, pending);
  return pending;
}

function thumbResponse(
  bytes: Uint8Array,
  ifNoneMatch: string | undefined,
  headers: Record<string, string>,
): Response {
  const etag = computeBodyETag(bytes);
  const unchanged = ifNoneMatchEqual(ifNoneMatch, etag);
  return new Response(unchanged ? null : (bytes as unknown as BodyInit), {
    status: unchanged ? 304 : 200,
    headers: { 'Content-Type': 'image/avif', ETag: etag, ...headers },
  });
}

async function renderMissingThumb(
  absPath: string,
  thumbPath: string,
  set: Context['set'],
): Promise<{ error: string } | null> {
  const unavailable = await derivativeDecoderUnavailable(absPath);
  if (unavailable) {
    set.status = 503;
    return { error: unavailable };
  }
  await generateThumbDeduped(absPath, thumbPath);
  if (await isDerivativeCacheFresh(thumbPath, absPath)) return null;
  set.status = 404;
  return { error: 'Thumbnail generation failed' };
}

async function serveThumb(
  absPath: string,
  thumbPath: string,
  ifNoneMatch: string | undefined,
  set: Context['set'],
  edgeCacheable: boolean,
  requestedVersion: string | undefined,
): Promise<Response | { error: string }> {
  try {
    await assertDerivativeCacheDirectory(thumbPath);
    const fresh = await isDerivativeCacheFresh(thumbPath, absPath);
    const failure = fresh ? null : await renderMissingThumb(absPath, thumbPath, set);
    if (failure) return failure;
    const { data: bytes, version } = await readVersionedThumb(thumbPath, safeReadBytes);
    if (!bytes) {
      set.status = 404;
      return { error: 'Thumbnail file unreadable' };
    }
    return thumbResponse(bytes, ifNoneMatch, {
      'X-Thumb-Cache': fresh ? 'hit' : 'miss',
      'Cache-Control':
        version !== null && requestedVersion === version
          ? VERSIONED_THUMB_CACHE
          : MUTABLE_PREVIEW_CACHE,
      ...(version ? { [THUMB_VERSION_HEADER]: version } : {}),
      ...(edgeCacheable ? {} : { [EDGE_CACHEABLE_HEADER]: '0' }),
    });
  } catch (err) {
    log.warn(
      { absPath, thumbPath, err: err instanceof Error ? err.message : err },
      'thumbnail read failed',
    );
    return derivativeGenerationFailure(err, set, 'Thumbnail generation failed');
  }
}

export const thumbRoutes = new Elysia().get(
  '/thumb/:slug/*',
  async ({ params, query, headers, set }) => {
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
    return serveThumb(
      absPath,
      thumbPath,
      headers['if-none-match'],
      set,
      asset !== null && !asset.hidden,
      typeof query.v === 'string' ? query.v : undefined,
    );
  },
  { params: wildcardSlugParams() },
);
