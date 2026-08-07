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
import { ObjectId } from 'mongodb';
import { foldersCollection } from '../db/client.ts';
import { validateRelPathHeader } from './folders.ts';
import { trashFolderRecursive, restoreFolderRecursive } from '../library/folder-trash.ts';

export const foldersTrashRoutes = new Elysia({ prefix: '/api/folders' })
  .post('/:id/trash-folder', async ({ params, headers, set }) => {
    let folderId: ObjectId;
    try {
      folderId = new ObjectId(params.id);
    } catch {
      set.status = 400;
      return { error: 'Invalid folder id' };
    }

    const folders = await foldersCollection();
    const folder = await folders.findOne({ _id: folderId });
    if (!folder) {
      set.status = 404;
      return { error: 'Folder not found' };
    }

    const validated = validateRelPathHeader(headers['x-maple-target-path'], 'X-Maple-Target-Path');
    if (!validated.ok) {
      set.status = validated.status;
      return { error: validated.error };
    }

    const summary = await trashFolderRecursive(folderId, folder.path, validated.target);
    set.status = 200;
    return summary;
  })

  .post('/:id/restore-folder', async ({ params, headers, set }) => {
    let folderId: ObjectId;
    try {
      folderId = new ObjectId(params.id);
    } catch {
      set.status = 400;
      return { error: 'Invalid folder id' };
    }

    const folders = await foldersCollection();
    const folder = await folders.findOne({ _id: folderId });
    if (!folder) {
      set.status = 404;
      return { error: 'Folder not found' };
    }

    const validated = validateRelPathHeader(headers['x-maple-target-path'], 'X-Maple-Target-Path');
    if (!validated.ok) {
      set.status = validated.status;
      return { error: validated.error };
    }

    const summary = await restoreFolderRecursive(folderId, folder.path, validated.target);
    set.status = 200;
    return summary;
  });
