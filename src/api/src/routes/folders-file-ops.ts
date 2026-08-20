/**
 * Path-addressed delete (trash) + relocate (move/rename/copy) for
 * non-asset files (#2535) — the write-path half of the "sync every file
 * type" contract. `FileChild`-backed files (video, PDF, extensionless —
 * anything not an indexed image, see `fs/browse.ts`'s `FileChild` doc
 * comment) have no `AssetDoc` and no asset id, so the asset-ID-keyed
 * routes (`routes/assets/trash.ts`, `routes/assets/relocate.ts`) can't
 * address them. These two routes are addressed by `(folderID,
 * relativePath)` instead — the same addressing `GET /:id/file` and
 * `GET /:id/file-meta` (`routes/folders.ts`) already use for reads.
 *
 * Both delegate to the existing crash-safe primitives — `moveToTrash`
 * (`fs/trash.ts`) and `relocateFile` (`fs/relocate.ts`) — the same ones
 * the asset-ID-keyed routes are built on. No new filesystem logic here;
 * this module is HTTP plumbing + the change-feed emit those primitives
 * don't know about.
 *
 * Every request path is validated with `realpathJailCheck` /
 * `resolveRelPathUnderRoot` (`library/address.ts`) — the same
 * symlink-safe, `..`/absolute-rejecting jail the M1 addressing routes and
 * `routes/assets/relocate.ts` share — plus an `isInsideMapleCache` guard
 * (`workers/discover/types.ts`) so a client can never relocate/trash
 * something inside the server's own `.maple/` cache or trash directory.
 *
 * Kept in a separate module rather than added to `routes/folders.ts`
 * (already at the file-size hard limit) — mounted alongside it onto the
 * shared `/api/folders` prefix (see `routes/authed-api.ts`), the same
 * pattern `folders-trash.ts` uses.
 */

import { Elysia, t } from 'elysia';
import { ObjectId } from 'mongodb';
import * as nodePath from 'node:path';
import { foldersCollection, assetsCollection } from '../db/client.ts';
import { recordAndPublishAssetChange } from '../db/changes.repo.ts';
import {
  realpathJailCheck,
  resolveRelPathUnderRoot,
  validateRelPathShape,
} from '../library/address.ts';
import { isSafeFilename } from '../backup/path-formatter.ts';
import { isInsideMapleCache } from '../workers/discover/types.ts';
import { moveToTrash } from '../fs/trash.ts';
import { relocateFile, type CollisionPolicy, type RelocateMode } from '../fs/relocate.ts';
import { stat } from '../fs/mirrored.ts';
import { requireFileAccess } from '../auth/middleware.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('routes:folders-file-ops');

/** Split an already-validated POSIX relative path into its parent dir and
 * filename, matching `FileInfo.path`/`FileInfo.filename`'s storage shape.
 * `relPath` is never backslash-bearing here — `validateRelPathShape` /
 * `realpathJailCheck` reject that before this ever runs — so a plain
 * `lastIndexOf('/')` split is correct without a `path.sep` translation. */
function splitRelPath(relPath: string): { dir: string; filename: string } {
  const idx = relPath.lastIndexOf('/');
  return idx === -1
    ? { dir: '', filename: relPath }
    : { dir: relPath.slice(0, idx), filename: relPath.slice(idx + 1) };
}

/** Inverse of `splitRelPath`, applied to an absolute path once a relocate
 * has landed — mirrors `library/relocate-asset.ts`'s `splitRelPath` helper
 * (POSIX-normalizing `path.sep` so a Windows host's `path.relative` output
 * still matches the POSIX storage contract). */
function relPathFromAbs(root: string, absPath: string): { dir: string; filename: string } {
  const rel = nodePath.relative(root, absPath).split(nodePath.sep).join('/');
  return splitRelPath(rel);
}

async function resolveFolder(
  paramsId: string,
): Promise<
  | { ok: true; folderId: ObjectId; folderPath: string }
  | { ok: false; status: number; error: string }
> {
  let folderId: ObjectId;
  try {
    folderId = new ObjectId(paramsId);
  } catch {
    return { ok: false, status: 400, error: 'Invalid folder id' };
  }
  const folder = await (await foldersCollection()).findOne({ _id: folderId });
  if (!folder) {
    return { ok: false, status: 404, error: 'Folder not found' };
  }
  return { ok: true, folderId, folderPath: folder.path };
}

/** Defensive integrity guard shared by both routes below: refuse to touch
 * a path that's actually a LIVE indexed asset's location. Both new routes
 * are meant to be reached only for `.file`-identified (non-asset) items —
 * but a race (the discover sweep indexes the file between the client's
 * last listing and this request) would otherwise let a bare filesystem
 * move/trash run without repointing the asset's `fileinfo` entry,
 * orphaning the Mongo doc. Returns the indexed asset's hex id when found,
 * so the caller can report exactly which asset-ID-keyed route to use
 * instead. */
async function findLiveIndexedAsset(
  folderId: ObjectId,
  relDir: string,
  filename: string,
): Promise<string | null> {
  const assets = await assetsCollection();
  const hit = await assets.findOne(
    {
      fileinfo: {
        $elemMatch: { library_id: folderId, path: relDir, filename, deleted_at: null },
      },
    },
    { projection: { _id: 1 } },
  );
  return hit ? (hit._id as ObjectId).toHexString() : null;
}

const RelocateFileBodySchema = t.Object({
  source_path: t.String(),
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

// Both routes mutate the filesystem — file-access-gated (#2893), same as
// every other write route in `routes/folders.ts` / `routes/folders-trash.ts`.
export const foldersFileOpsRoutes = new Elysia({ prefix: '/api/folders' })
  .use(requireFileAccess)

  // Trash a non-asset file addressed by its library-relative path. Mirrors
  // `DELETE /api/assets/:id` (trash-first, `routes/assets/trash.ts`) but
  // for a `FileChild` with no asset id to key on.
  .delete('/:id/file', async ({ params, query, set }) => {
    const resolved = await resolveFolder(params.id);
    if (!resolved.ok) {
      set.status = resolved.status;
      return { error: resolved.error };
    }
    const { folderId, folderPath } = resolved;

    const rawPath = query.path;
    if (typeof rawPath !== 'string' || rawPath === '') {
      set.status = 400;
      return { error: 'missing path query param' };
    }
    if (isInsideMapleCache(folderPath, nodePath.join(folderPath, rawPath))) {
      set.status = 400;
      return { error: 'path is inside the .maple cache — refusing' };
    }

    const jailed = await realpathJailCheck(folderPath, rawPath);
    if (!jailed.ok) {
      set.status = jailed.status;
      return { error: jailed.error };
    }

    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(jailed.real);
    } catch {
      set.status = 404;
      return { error: 'file not found' };
    }
    if (!st.isFile()) {
      set.status = 400;
      return { error: 'not a regular file' };
    }

    const { dir: relDir, filename } = splitRelPath(rawPath);
    const indexedAssetId = await findLiveIndexedAsset(folderId, relDir, filename);
    if (indexedAssetId) {
      set.status = 409;
      return {
        error: 'path is an indexed asset — use DELETE /api/assets/:id instead',
        asset_id: indexedAssetId,
      };
    }

    // Same literal-join convention `POST /:id/upload` uses when calling
    // `moveToTrash` — the primitive's `computeTrashPath` requires its
    // input to be prefixed by `folderPath` exactly as registered, not by
    // whatever `realpath` resolved it to (e.g. `/var` vs `/private/var`
    // on macOS).
    const absPath = nodePath.join(folderPath, rawPath);
    const moved = await moveToTrash(absPath, folderPath);
    if (moved.kind === 'error') {
      set.status = 500;
      return { error: `trash failed: ${moved.error}` };
    }

    await recordAndPublishAssetChange({
      kind: 'delete',
      asset_id: null,
      folder_id: folderId,
      abs_path: absPath,
      relative_path: rawPath,
    }).catch((err) => {
      log.warn(
        {
          folderId: folderId.toHexString(),
          rawPath,
          err: err instanceof Error ? err.message : err,
        },
        'change-feed emit failed after file trash (best-effort, ignoring)',
      );
    });

    set.status = 204;
    return;
  })

  // Move, rename, or copy a non-asset file addressed by its
  // library-relative path. Mirrors `POST /api/assets/:id/relocate`
  // (`routes/assets/relocate.ts`) but takes `source_path` in the body
  // instead of an asset id, and is built directly on `relocateFile`
  // (`fs/relocate.ts`) rather than `library/relocate-asset.ts` — there is
  // no Mongo `fileinfo` entry to repoint for a file with no `AssetDoc`.
  .post(
    '/:id/file/relocate',
    async ({ params, body, set }) => {
      const resolved = await resolveFolder(params.id);
      if (!resolved.ok) {
        set.status = resolved.status;
        return { error: resolved.error };
      }
      const { folderId, folderPath } = resolved;

      const sourceShape = validateRelPathShape(body.source_path);
      if (!sourceShape.ok) {
        set.status = sourceShape.status;
        return { error: sourceShape.error };
      }
      if (body.source_path === '') {
        set.status = 400;
        return { error: 'source_path must not be empty' };
      }
      const destShape = validateRelPathShape(body.destination_path);
      if (!destShape.ok) {
        set.status = destShape.status;
        return { error: destShape.error };
      }
      if (body.destination_filename !== undefined && !isSafeFilename(body.destination_filename)) {
        set.status = 400;
        return { error: 'destination_filename is not a valid single-segment filename' };
      }
      if (
        isInsideMapleCache(folderPath, nodePath.join(folderPath, body.source_path)) ||
        isInsideMapleCache(folderPath, nodePath.join(folderPath, body.destination_path))
      ) {
        set.status = 400;
        return { error: 'path is inside the .maple cache — refusing' };
      }

      // Confirm the source exists and stays inside the jail (symlink-safe
      // — same check the read-side `GET /:id/file` uses).
      const sourceJailed = await realpathJailCheck(folderPath, body.source_path);
      if (!sourceJailed.ok) {
        set.status = sourceJailed.status;
        return { error: sourceJailed.error };
      }
      let srcStat: Awaited<ReturnType<typeof stat>>;
      try {
        srcStat = await stat(sourceJailed.real);
      } catch {
        set.status = 404;
        return { error: 'file not found' };
      }
      if (!srcStat.isFile()) {
        set.status = 400;
        return { error: 'source is not a regular file' };
      }

      const { dir: sourceRelDir, filename: sourceFilename } = splitRelPath(body.source_path);
      const indexedAssetId = await findLiveIndexedAsset(folderId, sourceRelDir, sourceFilename);
      if (indexedAssetId) {
        set.status = 409;
        return {
          error: 'path is an indexed asset — use POST /api/assets/:id/relocate instead',
          asset_id: indexedAssetId,
        };
      }

      // Destination directory: symlink-safe jail, tolerant of the
      // destination not existing yet — same helper `library/relocate-asset
      // .ts` uses for the asset-ID-keyed relocate route.
      let destDir: string;
      try {
        destDir = await resolveRelPathUnderRoot(folderPath, body.destination_path);
      } catch (err) {
        set.status = (err as { status?: number } | null)?.status ?? 400;
        return { error: err instanceof Error ? err.message : String(err) };
      }

      const sourceAbsPath = nodePath.join(folderPath, body.source_path);
      const destFilename = body.destination_filename ?? sourceFilename;
      const destAbsPath = nodePath.join(destDir, destFilename);

      const outcome = await relocateFile({
        sourceAbsPath,
        destAbsPath,
        mode: body.mode as RelocateMode,
        collision: body.collision as CollisionPolicy,
        callerTag: 'folders/file/relocate',
      });

      switch (outcome.kind) {
        case 'skipped':
          set.status = 200;
          return { skipped: true, reason: outcome.reason };
        case 'error':
          set.status = 500;
          return { error: outcome.error };
        case 'relocated': {
          const { dir: newPath, filename: newFilename } = relPathFromAbs(
            folderPath,
            outcome.newAbsPath,
          );
          const newRelativePath = newPath === '' ? newFilename : `${newPath}/${newFilename}`;

          // Emit change-feed rows so File Provider clients pick this up
          // without waiting for a re-enumeration. Unlike an indexed asset
          // (a stable Mongo `_id` survives a rename), a path-addressed
          // file's identity IS its `(folderID, relativePath)` pair — see
          // `FileProviderIdentifier.file`'s doc comment — so a move
          // retires the OLD identity and mints a new one: delete + create,
          // never a same-identifier update. A copy only ever creates (the
          // source stays live).
          if (body.mode === 'move') {
            await recordAndPublishAssetChange({
              kind: 'delete',
              asset_id: null,
              folder_id: folderId,
              abs_path: sourceAbsPath,
              relative_path: body.source_path,
            }).catch(() => {});
          }
          await recordAndPublishAssetChange({
            kind: 'create',
            asset_id: null,
            folder_id: folderId,
            abs_path: outcome.newAbsPath,
            relative_path: newRelativePath,
          }).catch((err) => {
            log.warn(
              {
                folderId: folderId.toHexString(),
                newRelativePath,
                err: err instanceof Error ? err.message : err,
              },
              'change-feed emit failed after file relocate (best-effort, ignoring)',
            );
          });

          set.status = 200;
          return {
            new_abs_path: outcome.newAbsPath,
            new_path: newPath,
            new_filename: newFilename,
            renamed_on_collision: outcome.renamedOnCollision,
          };
        }
      }
    },
    { body: RelocateFileBodySchema },
  );
