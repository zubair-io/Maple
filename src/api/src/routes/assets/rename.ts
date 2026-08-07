/**
 * POST /api/assets/:id/rename — single-asset rename (#2636).
 *
 * A rename IS a relocate within the asset's current folder — this is a thin
 * wrapper over `relocateAsset` (`library/relocate-asset.ts`) that omits
 * `destinationPath` (which now defaults to the asset's current relPath, see
 * that function's doc) and passes `new_filename` as `destinationFilename`.
 * See docs/superpowers/specs/2026-08-04-file-management-design.md § "Rename".
 *
 * `new_filename` MUST validate through the shared `raw-core` filename
 * engine (`ffi/raw_ffi.ts`'s `validateFilename`, backed by
 * `maple_validate_filename`) before this touches Mongo or the filesystem —
 * the same Windows-reserved-name / trailing-dot / path-separator rules a
 * batch-rename template's output is checked against, so a rename that would
 * break the Windows client is rejected here rather than shipping a name
 * only macOS/Linux tolerate. `isSafeFilename` is checked first as a fast,
 * I/O-free rejection of the same traversal shapes `routes/assets/relocate.ts`
 * guards against; the engine check is defense in depth beyond it, not a
 * replacement (e.g. it also catches `CON.dng`, `trailing. `, leading `.`).
 *
 * Extension changes are ALLOWED (the design doc: "retyping it is allowed
 * but warns, since it doesn't transcode anything") — the response flags
 * `extension_changed` rather than rejecting, so the caller's UI can warn
 * without this endpoint making the call on the user's behalf.
 *
 * Body:
 *   new_filename: string             — full desired filename, with extension
 *   collision: 'auto-suffix' | 'skip' | 'replace' | 'keep-both'
 */

import { Elysia, t } from 'elysia';
import { parseAssetId } from '../../db/assets.repo.ts';
import { relocateAsset } from '../../library/relocate-asset.ts';
import { isSafeFilename } from '../../backup/path-formatter.ts';
import { tryGetRawFfi } from '../../ffi/raw_ffi.ts';
import { extensionChanged } from '../../library/filename-template.ts';

const RenameBodySchema = t.Object({
  new_filename: t.String(),
  collision: t.Union([
    t.Literal('auto-suffix'),
    t.Literal('skip'),
    t.Literal('replace'),
    t.Literal('keep-both'),
  ]),
});

/** Validate `new_filename` before touching Mongo or the filesystem. Returns
 * an error message, or `null` when valid (or when the native engine isn't
 * loaded — see `tryGetRawFfi`'s doc; `isSafeFilename` still applies in that
 * case, so validation degrades rather than disappears). */
function validateNewFilename(name: string): string | null {
  if (!isSafeFilename(name)) return 'new_filename is not a valid single-segment filename';
  const ffi = tryGetRawFfi();
  if (!ffi) return null;
  const result = ffi.validateFilename(name);
  return result.ok ? null : result.error;
}

export const renameRoutes = new Elysia().post(
  '/:id/rename',
  async ({ params, body, set }) => {
    const id = parseAssetId(params.id);
    if (!id) {
      set.status = 400;
      return { error: 'Invalid asset id' };
    }

    const shapeError = validateNewFilename(body.new_filename);
    if (shapeError) {
      set.status = 400;
      return { error: shapeError };
    }

    const result = await relocateAsset({
      id,
      mode: 'move',
      collision: body.collision,
      destinationFilename: body.new_filename,
    });

    switch (result.kind) {
      case 'relocated':
        set.status = 200;
        return {
          new_abs_path: result.newAbsPath,
          new_path: result.newPath,
          new_filename: result.newFilename,
          renamed_on_collision: result.renamedOnCollision,
          extension_changed: extensionChanged(result.oldFilename, result.newFilename),
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
    body: RenameBodySchema,
    detail: {
      summary: 'Rename a single asset (relocate within its current folder) + its XMP sidecar',
      tags: ['assets'],
    },
  },
);
