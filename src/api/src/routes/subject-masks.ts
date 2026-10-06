/**
 * Subject mask endpoints (#4284, #3300 slice 3).
 *
 *   GET /api/subject-masks/persons?asset=<urlencoded assetKey>
 *     Returns detected person candidates and the server model id.
 *     404 when no segmentation doc exists for the asset.
 *
 *   GET /api/subject-masks/raster/:digest
 *     Returns the grayscale PNG raster (1024px long edge) from the stage cache.
 *     404 when the digest is unknown.
 */

import { Elysia, t } from 'elysia';
import { getPersonSegmentation } from '../db/repos/subject-masks.repo.ts';
import { isValidDigest, readRasterPng } from '../enrichment/subject-masks/subject-mask-cache.ts';

export const subjectMasksRoutes = new Elysia({ prefix: '/api/subject-masks' })
  .get(
    '/persons',
    async ({ query, set }) => {
      const assetKey = query.asset;
      if (!assetKey) {
        set.status = 400;
        return { error: 'Missing asset query parameter' };
      }

      const segmentation = await getPersonSegmentation(assetKey);
      if (!segmentation) {
        set.status = 404;
        return { error: 'No segmentation available for this asset' };
      }

      return {
        model: segmentation.model,
        persons: segmentation.persons,
      };
    },
    {
      query: t.Object({
        asset: t.String(),
      }),
    },
  )
  .get('/raster/:digest', async ({ params, set }) => {
    const { digest } = params;
    if (!isValidDigest(digest)) {
      set.status = 404;
      return { error: 'Invalid mask digest' };
    }

    const pngBytes = await readRasterPng(digest);
    if (!pngBytes) {
      set.status = 404;
      return { error: 'Unknown mask digest' };
    }

    return new Response(pngBytes, {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  });
