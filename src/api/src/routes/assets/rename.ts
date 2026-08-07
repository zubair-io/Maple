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
 * FAILS CLOSED when the native engine isn't loaded (`tryGetRawFfi() ===
 * null`): the dylib is a hard runtime dependency of this API already
 * (thumbnails/rendering require it too), so this is near-unreachable in a
 * working deploy — which is exactly why it's safe, and correct, to reject
 * the rename with a 503 rather than silently fall back to `isSafeFilename`
 * alone and risk shipping a name that only breaks later on Windows.
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
import { relocateAsset } from '../../library/relocate-asset.ts';
import { isSafeFilename } from '../../backup/path-formatter.ts';
import { tryGetRawFfi } from '../../ffi/raw_ffi.ts';
import { extensionChanged } from '../../library/filename-template.ts';
import { parseAssetIdOr400, relocateResultResponse } from './_shared.ts';

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
 * `null` when valid, or a `{ status, error }` pair to short-circuit the
 * route with otherwise. FAILS CLOSED: an unavailable engine is a 503, not a
 * silently-passed validation — see this file's module doc. */
function validateNewFilename(name: string): { status: number; error: string } | null {
  if (!isSafeFilename(name)) {
    return { status: 400, error: 'new_filename is not a valid single-segment filename' };
  }
  const ffi = tryGetRawFfi();
  if (!ffi) {
    return {
      status: 503,
      error: 'filename validation engine unavailable — native library not loaded',
    };
  }
  const result = ffi.validateFilename(name);
  return result.ok ? null : { status: 400, error: result.error };
}

export const renameRoutes = new Elysia().post(
  '/:id/rename',
  async ({ params, body, set }) => {
    const idResult = parseAssetIdOr400(params.id);
    if (!idResult.ok) {
      set.status = idResult.status;
      return idResult.body;
    }

    const validation = validateNewFilename(body.new_filename);
    if (validation) {
      set.status = validation.status;
      return { error: validation.error };
    }

    const result = await relocateAsset({
      id: idResult.id,
      mode: 'move',
      collision: body.collision,
      destinationFilename: body.new_filename,
    });

    const { status, body: responseBody } = relocateResultResponse(result, (r) => ({
      extension_changed: extensionChanged(r.oldFilename, r.newFilename),
    }));
    set.status = status;
    return responseBody;
  },
  {
    body: RenameBodySchema,
    detail: {
      summary: 'Rename a single asset (relocate within its current folder) + its XMP sidecar',
      tags: ['assets'],
    },
  },
);
