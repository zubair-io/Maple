/**
 * Recursive folder-level trash + restore (#2630).
 *
 * POST /api/folders/:id/trash-folder    — trash every live asset under a
 *                                          subfolder (recursive).
 * POST /api/folders/:id/restore-folder  — restore every trashed asset
 *                                          whose original location was
 *                                          under that subfolder.
 *
 * Both take the subfolder's path relative to the library root in the
 * `X-Maple-Target-Path` header — same header, same validation
 * (`validateRelPathHeader`), and same jail rules as `/mkdir` and `/move`
 * in `routes/folders.ts`. Kept in a separate module rather than added to
 * `routes/folders.ts` (already at the file-size hard limit) — mounted
 * alongside it onto the shared `/api/folders` prefix (see `index.ts`).
 *
 * The heavy lifting — per-asset trash/restore, partial-failure summary,
 * multi-location safety — lives in `library/folder-trash.ts`, itself built
 * on the same single-asset orchestration (`library/asset-trash.ts`) the
 * per-asset routes in `routes/assets/trash.ts` use.
 */

import { Elysia } from 'elysia';
import { ObjectId, type WithId } from 'mongodb';
import { foldersCollection } from '../db/client.ts';
import type { FolderDoc } from '../db/schema.ts';
import { validateRelPathHeader } from './folders.ts';
import { trashFolderRecursive, restoreFolderRecursive } from '../library/folder-trash.ts';
import { requireFileAccess } from '../auth/middleware.ts';

type ResolvedTarget = { folderId: ObjectId; folder: WithId<FolderDoc>; relPath: string };
type ResolveError = { status: number; error: string };

/**
 * Shared `:id` + `X-Maple-Target-Path` resolution for both routes below —
 * parse the folder id, look up the folder doc, and validate the header
 * with the exact same rules `/mkdir` and `/move` use. Both handlers were
 * previously duplicating this ~20-line block; factored out per the #2695
 * review (fallow-audit clone-group finding) so the two routes can't drift.
 */
async function resolveFolderAndTarget(
  paramsId: string,
  headers: Record<string, string | undefined>,
): Promise<ResolvedTarget | ResolveError> {
  let folderId: ObjectId;
  try {
    folderId = new ObjectId(paramsId);
  } catch {
    return { status: 400, error: 'Invalid folder id' };
  }

  const folders = await foldersCollection();
  const folder = await folders.findOne({ _id: folderId });
  if (!folder) {
    return { status: 404, error: 'Folder not found' };
  }

  const validated = validateRelPathHeader(headers['x-maple-target-path'], 'X-Maple-Target-Path');
  if (!validated.ok) {
    return { status: validated.status, error: validated.error };
  }

  return { folderId, folder, relPath: validated.target };
}

function isResolveError(r: ResolvedTarget | ResolveError): r is ResolveError {
  return 'status' in r;
}

/**
 * Shared handler body for both routes below — resolve `:id` + the target
 * header (`resolveFolderAndTarget`), then hand the result to whichever
 * batch op (`trashFolderRecursive` / `restoreFolderRecursive`) the caller
 * wants run. The two routes are otherwise identical (same params, same
 * success/error shaping), so this is the one place that shape lives. Takes
 * `set` by reference (Elysia's own mutable context field) rather than
 * returning a status — kept as a plain async function (not an Elysia
 * handler itself) so each `.post()` call site still gets Elysia's own
 * inferred context typing.
 */
async function runFolderBatch(
  paramsId: string,
  headers: Record<string, string | undefined>,
  set: { status?: number | string },
  runOp: (folderId: ObjectId, folderRoot: string, relPath: string) => Promise<unknown>,
) {
  const resolved = await resolveFolderAndTarget(paramsId, headers);
  if (isResolveError(resolved)) {
    set.status = resolved.status;
    return { error: resolved.error };
  }
  const summary = await runOp(resolved.folderId, resolved.folder.path, resolved.relPath);
  set.status = 200;
  return summary;
}

// Folder trash/restore mutates the filesystem — file-access-gated (#2893).
export const foldersTrashRoutes = new Elysia({ prefix: '/api/folders' })
  .use(requireFileAccess)
  .post('/:id/trash-folder', ({ params, headers, set }) =>
    runFolderBatch(params.id, headers, set, trashFolderRecursive),
  )
  .post('/:id/restore-folder', ({ params, headers, set }) =>
    runFolderBatch(params.id, headers, set, restoreFolderRecursive),
  );
