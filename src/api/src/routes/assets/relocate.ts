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
 *   destination_path: string             — POSIX relative dir under the
 *                                           destination library's root
 *                                           ('' = root)
 *   destination_filename?: string        — defaults to the asset's current
 *                                           filename
 *   destination_library_id?: string      — #2725: the library
 *                                           `destination_path` is relative
 *                                           to. Omit for a same-library
 *                                           relocate (the historical
 *                                           default); a cross-library move
 *                                           needs this — without it there is
 *                                           no way to name a foreign
 *                                           library, and `destination_path`
 *                                           always resolves under the
 *                                           asset's OWN library root.
 *   source_address?: string               — selected file location when an
 *                                           asset has identical-content copies
 */

import { Elysia, t } from 'elysia';
import * as path from 'node:path';
import { ObjectId } from '../../db/object-id.ts';
import type { FileInfo } from '../../db/schema.ts';
import { loadAssetLocationView } from '../../db/repos/assets.locations.repo.ts';
import { relocateAsset } from '../../library/relocate-asset.ts';
import {
  parseAddressString,
  resolveAddressString,
  validateRelPathShape,
} from '../../library/address.ts';
import { isSafeFilename } from '../../backup/path-formatter.ts';
import { resolveAssetIdOrRespond, relocateResultResponse } from './_shared.ts';
import { requireFileAccessBeforeHandle } from '../../auth/middleware.ts';

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
  destination_library_id: t.Optional(t.String()),
  source_address: t.Optional(t.String()),
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

async function resolveSourceFileInfo(
  fileinfo: FileInfo[],
  sourceAddress?: string,
): Promise<{ source?: FileInfo; error?: string; status?: number }> {
  if (sourceAddress === undefined) {
    if (fileinfo.filter((entry) => !entry.deleted_at && !entry.missing_since).length !== 1) {
      return {
        status: 409,
        error: 'Source address required for an asset with multiple locations',
      };
    }
    return {};
  }

  let resolved;
  let relPath: string;
  try {
    resolved = await resolveAddressString(sourceAddress);
    relPath = parseAddressString(sourceAddress).relPath;
  } catch (err) {
    return {
      status: (err as { status?: number }).status ?? 400,
      error: 'Invalid source address',
    };
  }
  if (!relPath) return { status: 400, error: 'Source address must name a file' };

  const filename = path.posix.basename(relPath);
  const directory = path.posix.dirname(relPath);
  const source = fileinfo.find(
    (entry) =>
      !entry.deleted_at &&
      entry.library_id.equals(resolved.libraryId) &&
      entry.path === (directory === '.' ? '' : directory) &&
      entry.filename === filename,
  );
  return source
    ? { source }
    : { status: 409, error: 'Source address no longer belongs to this asset' };
}

export const relocateRoutes = new Elysia().post(
  '/:id/relocate',
  async ({ params, body, set }) => {
    const id = resolveAssetIdOrRespond(params.id, set);
    if (!(id instanceof ObjectId)) return id;

    const shapeError = validateDestinationShape(body);
    if (shapeError) {
      set.status = 400;
      return { error: shapeError };
    }

    let destinationLibraryId: ObjectId | undefined;
    if (body.destination_library_id !== undefined) {
      try {
        destinationLibraryId = new ObjectId(body.destination_library_id);
      } catch {
        set.status = 400;
        return { error: 'destination_library_id is not a valid library id' };
      }
    }

    const view = await loadAssetLocationView(id);
    if (!view) {
      set.status = 404;
      return { error: 'Asset not found' };
    }
    const sourceResult = await resolveSourceFileInfo(view.fileinfo, body.source_address);
    if (sourceResult.error) {
      set.status = sourceResult.status ?? 400;
      return { error: sourceResult.error };
    }

    const result = await relocateAsset({
      id,
      mode: body.mode,
      collision: body.collision,
      destinationPath: body.destination_path,
      destinationFilename: body.destination_filename,
      destinationLibraryId,
      ...(sourceResult.source ? { activeFileInfoOverride: sourceResult.source } : {}),
    });

    const { status, body: responseBody } = relocateResultResponse(result);
    set.status = status;
    return responseBody;
  },
  {
    beforeHandle: requireFileAccessBeforeHandle,
    body: RelocateBodySchema,
    detail: {
      summary: 'Relocate (move or copy) a single asset + its XMP sidecar',
      tags: ['assets'],
    },
  },
);
