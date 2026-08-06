/**
 * POST /api/assets/:id/relocate — generic single-asset relocate (#2629).
 *
 * The public HTTP surface for `relocateAsset` (`library/relocate-asset.ts`),
 * itself built on the generic crash-safe `relocateFile` primitive
 * (`fs/relocate.ts`). This is the foundation endpoint later Milestone 23
 * tickets (rename, drag-to-folder, folder move) call into — see
 * docs/superpowers/specs/2026-08-04-file-management-design.md.
 *
 * Body:
 *   mode: 'move' | 'copy'
 *   collision: 'auto-suffix' | 'skip' | 'replace' | 'keep-both'
 *   destination_path: string        — POSIX relative dir under the asset's
 *                                      library root ('' = root)
 *   destination_filename?: string   — defaults to the asset's current filename
 */

import { Elysia, t } from 'elysia';
import { parseAssetId } from '../../db/assets.repo.ts';
import { relocateAsset } from '../../library/relocate-asset.ts';
import { validateRelPathShape } from '../../library/address.ts';
import { isSafeFilename } from '../../backup/path-formatter.ts';

const RelocateBodySchema = t.Object({
  mode: t.Union([t.Literal('move'), t.Literal('copy')]),
  collision: t.Union([
    t.Literal('auto-suffix'),
    t.Literal('skip'),
    t.Literal('replace'),
    t.Literal('keep-both'),
  ]),
  destination_path: t.String(),
  destination_filename: t.Optional(t.String()),
});

/** Fast, I/O-free rejection of an obviously-hostile `destination_path` /
 * `destination_filename` (absolute paths, backslashes, `..` segments, a
 * filename carrying its own directory separators) — before this request
 * touches Mongo or the filesystem at all. `library/relocate-asset.ts`
 * enforces the same rules again (its `resolveRelPathUnderRoot` /
 * `isSafeFilename` calls), as defense in depth for any caller that isn't
 * this route; this boundary check exists so a hostile request fails fast
 * with a precise 400 rather than surfacing as a generic 500 later. */
function validateDestinationShape(body: {
  destination_path: string;
  destination_filename?: string;
}): string | null {
  const pathShape = validateRelPathShape(body.destination_path);
  if (!pathShape.ok) return pathShape.error;
  if (body.destination_filename !== undefined && !isSafeFilename(body.destination_filename)) {
    return 'destination_filename is not a valid single-segment filename';
  }
  return null;
}

export const relocateRoutes = new Elysia().post(
  '/:id/relocate',
  async ({ params, body, set }) => {
    const id = parseAssetId(params.id);
    if (!id) {
      set.status = 400;
      return { error: 'Invalid asset id' };
    }

    const shapeError = validateDestinationShape(body);
    if (shapeError) {
      set.status = 400;
      return { error: shapeError };
    }

    const result = await relocateAsset({
      id,
      mode: body.mode,
      collision: body.collision,
      destinationPath: body.destination_path,
      destinationFilename: body.destination_filename,
    });

    switch (result.kind) {
      case 'relocated':
        set.status = 200;
        return {
          new_abs_path: result.newAbsPath,
          new_path: result.newPath,
          new_filename: result.newFilename,
          renamed_on_collision: result.renamedOnCollision,
        };
      case 'skipped':
        set.status = 200;
        return { skipped: true, reason: result.reason };
      case 'not-found':
        set.status = 404;
        return { error: 'Asset not found' };
      case 'invalid':
        set.status = 400;
        return { error: result.error };
      case 'error':
        set.status = 500;
        return { error: result.error };
    }
  },
  {
    body: RelocateBodySchema,
    detail: {
      summary: 'Relocate (move or copy) a single asset + its XMP sidecar',
      tags: ['assets'],
    },
  },
);
