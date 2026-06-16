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
import * as path from 'node:path';
import { parseAddressPath, resolveAddress } from '../../library/address.ts';
import { child as childLogger } from '../../log.ts';
import { ifNoneMatchEqual } from '../../runtime/http-etag.ts';
import { resolveThumbPathForAsset } from '../../fs/xmp.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import { generateThumb } from '../../indexer/thumbnailer.ts';
import { safeStat, safeReadBytes, IMMUTABLE_CACHE, findAssetByAddress } from './shared.ts';

const log = childLogger('routes/library/thumb');

export const thumbRoutes = new Elysia()
  .get(
    '/thumb/:slug/*',
    async ({ params, headers, set }) => {
      const slug = params.slug;
      const wildcard = (params as Record<string, string>)['*'] ?? '';
      const segments = wildcard ? wildcard.split('/') : [];

      // Split on last segment for (relDir, filename)
      const allSegs = segments;
      const filename = allSegs[allSegs.length - 1] ?? '';
      const dirSegs = allSegs.slice(0, -1);
      const { relPath: relDir } = { relPath: dirSegs.join('/') };

      // Resolve address for the CONTAINING DIRECTORY (jail check on parent)
      const fileRelPath = dirSegs.length > 0 ? `${dirSegs.join('/')}/${filename}` : filename;

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
        // File exists on disk but not indexed yet (or indexing in progress).
        const diskSt = await safeStat(absPath);
        if (!diskSt) {
          set.status = 404;
          return { error: 'File not found' };
        }
        // 202 with Retry-After — client should retry after scan completes.
        set.status = 202;
        set.headers['Retry-After'] = '2';
        return { status: 'indexing', message: 'Image not yet indexed; retry shortly' };
      }

      // ETag is the maple_id (content-keyed = stable until content changes).
      const etag = `"${asset.maple_id}"`;
      const ifNoneMatch = headers['if-none-match'];
      if (
        ifNoneMatchEqual(
          typeof ifNoneMatch === 'string' ? ifNoneMatch : undefined,
          etag,
        )
      ) {
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
