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
 * Each route handler below is a thin sequence of independent decisions
 * (shape validation, jail/existence checks, the live-indexed-asset
 * guard, destination resolution, outcome→response mapping) — each split
 * into its own named helper so the handler body reads as that sequence
 * rather than one large branching function.
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

/** A `{status, error}` shape shared by every early-return validation
 * step below — routes forward it straight into `set.status` +
 * `{ error }`. */
type RouteError = { ok: false; status: number; error: string };

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
): Promise<{ ok: true; folderId: ObjectId; folderPath: string } | RouteError> {
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

/** Decides whether `relPath` names a path already claimed by a LIVE
 * indexed asset, and if so refuses with the 409 the client should retry
 * against — `suggestedRoute` names that asset-ID-keyed route (e.g.
 * `"DELETE /api/assets/:id"`). Wraps `findLiveIndexedAsset` so both route
 * handlers below share one decision instead of duplicating the response
 * shape. */
async function refuseIfIndexedAsset(
  folderId: ObjectId,
  relPath: string,
  suggestedRoute: string,
): Promise<
  { ok: true } | { ok: false; status: number; body: { error: string; asset_id: string } }
> {
  const { dir, filename } = splitRelPath(relPath);
  const indexedAssetId = await findLiveIndexedAsset(folderId, dir, filename);
  if (!indexedAssetId) return { ok: true };
  return {
    ok: false,
    status: 409,
    body: {
      error: `path is an indexed asset — use ${suggestedRoute} instead`,
      asset_id: indexedAssetId,
    },
  };
}

/** Decides whether any of `relPaths` reaches into the server's own
 * `.maple/` cache/trash directory — a client must never be able to
 * relocate or trash something living there. Pure / no I/O: string-joins
 * each candidate against `folderPath` and defers to
 * `isInsideMapleCache`'s path-segment check. */
function refuseMapleCachePaths(folderPath: string, relPaths: string[]): { ok: true } | RouteError {
  const inside = relPaths.some((p) => isInsideMapleCache(folderPath, nodePath.join(folderPath, p)));
  if (inside) {
    return { ok: false, status: 400, error: 'path is inside the .maple cache — refusing' };
  }
  return { ok: true };
}

/** Decides whether `relPath` is a real, jailed, regular file under
 * `folderPath` — the "this path names something I can act on" check
 * both the trash route's target and the relocate route's source need.
 * Symlink-safe via `realpathJailCheck`; a directory or a dangling
 * symlink is refused, not silently accepted. */
async function resolveExistingFile(
  folderPath: string,
  relPath: string,
): Promise<{ ok: true } | RouteError> {
  const jailed = await realpathJailCheck(folderPath, relPath);
  if (!jailed.ok) return jailed;
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(jailed.real);
  } catch {
    return { ok: false, status: 404, error: 'file not found' };
  }
  if (!st.isFile()) {
    return { ok: false, status: 400, error: 'not a regular file' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// POST /:id/file/relocate — request shape + destination resolution
// ---------------------------------------------------------------------------

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

type RelocateFileBody = typeof RelocateFileBodySchema.static;

/** Decides whether a relocate request's `source_path` / `destination_path`
 * / `destination_filename` are well-formed — pure shape validation, no
 * I/O, no jail/existence check (that's `resolveExistingFile` /
 * `resolveRelocateDestination`). Mirrors `routes/assets/relocate.ts`'s
 * `validateDestinationShape`, extended with the source-side checks this
 * route also needs (asset relocate has no `source_path` — it's keyed by
 * asset id instead). */
function validateRelocateShape(body: RelocateFileBody): { ok: true } | RouteError {
  const sourceShape = validateRelPathShape(body.source_path);
  if (!sourceShape.ok) return sourceShape;
  if (body.source_path === '') {
    return { ok: false, status: 400, error: 'source_path must not be empty' };
  }
  const destShape = validateRelPathShape(body.destination_path);
  if (!destShape.ok) return destShape;
  if (body.destination_filename !== undefined && !isSafeFilename(body.destination_filename)) {
    return {
      ok: false,
      status: 400,
      error: 'destination_filename is not a valid single-segment filename',
    };
  }
  return { ok: true };
}

/** Resolves the relocate destination to an absolute path: a symlink-safe
 * jail check on `destinationPath` (tolerant of the leaf not existing yet
 * — the destination commonly doesn't), then joins the final filename
 * (`destinationFilename`, defaulting to the source's own). Same helper
 * (`resolveRelPathUnderRoot`) `library/relocate-asset.ts` uses for the
 * asset-ID-keyed relocate route's destination. */
async function resolveRelocateDestination(
  folderPath: string,
  destinationPath: string,
  destinationFilename: string | undefined,
  sourceFilename: string,
): Promise<{ ok: true; destAbsPath: string } | RouteError> {
  let destDir: string;
  try {
    destDir = await resolveRelPathUnderRoot(folderPath, destinationPath);
  } catch (err) {
    return {
      ok: false,
      status: (err as { status?: number } | null)?.status ?? 400,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const destFilename = destinationFilename ?? sourceFilename;
  return { ok: true, destAbsPath: nodePath.join(destDir, destFilename) };
}

// ---------------------------------------------------------------------------
// Outcome -> HTTP response mapping (+ the change-feed emit each outcome
// needs — see each function's doc comment for why the emit lives here
// rather than back in the route handler).
// ---------------------------------------------------------------------------

/** Maps a `moveToTrash` result to the route's `(status, body)`, emitting
 * the `delete` change-feed row on success so File Provider clients pick
 * the trash up without waiting for a re-enumeration. Best-effort: an emit
 * failure is logged, never surfaced — matches every other change-feed
 * call site in this codebase (`recordAndPublishAssetChange`'s own
 * best-effort contract). */
async function respondToTrashOutcome(
  moved: Awaited<ReturnType<typeof moveToTrash>>,
  ctx: { folderId: ObjectId; absPath: string; relativePath: string },
): Promise<{ status: number; body?: { error: string } }> {
  if (moved.kind === 'error') {
    return { status: 500, body: { error: `trash failed: ${moved.error}` } };
  }
  await recordAndPublishAssetChange({
    kind: 'delete',
    asset_id: null,
    folder_id: ctx.folderId,
    abs_path: ctx.absPath,
    relative_path: ctx.relativePath,
  }).catch((err) => {
    log.warn(
      {
        folderId: ctx.folderId.toHexString(),
        rawPath: ctx.relativePath,
        err: err instanceof Error ? err.message : err,
      },
      'change-feed emit failed after file trash (best-effort, ignoring)',
    );
  });
  return { status: 204 };
}

/** Maps a `relocateFile` outcome to the route's `(status, body)`. The
 * `relocated` case also emits the change-feed rows the move/copy needs:
 * unlike an indexed asset (a stable Mongo `_id` survives a rename), a
 * path-addressed file's identity IS its `(folderID, relativePath)` pair
 * — see `FileProviderIdentifier.file`'s doc comment — so a MOVE retires
 * the OLD identity (`delete`) and mints a new one (`create`), never a
 * same-identifier update. A COPY only ever creates (the source stays
 * live). */
async function respondToRelocateOutcome(
  outcome: Awaited<ReturnType<typeof relocateFile>>,
  ctx: {
    folderId: ObjectId;
    folderPath: string;
    mode: RelocateMode;
    sourceAbsPath: string;
    sourceRelativePath: string;
  },
): Promise<{ status: number; body: unknown }> {
  switch (outcome.kind) {
    case 'skipped':
      return { status: 200, body: { skipped: true, reason: outcome.reason } };
    case 'error':
      return { status: 500, body: { error: outcome.error } };
    case 'relocated': {
      const { dir: newPath, filename: newFilename } = relPathFromAbs(
        ctx.folderPath,
        outcome.newAbsPath,
      );
      const newRelativePath = newPath === '' ? newFilename : `${newPath}/${newFilename}`;

      if (ctx.mode === 'move') {
        await recordAndPublishAssetChange({
          kind: 'delete',
          asset_id: null,
          folder_id: ctx.folderId,
          abs_path: ctx.sourceAbsPath,
          relative_path: ctx.sourceRelativePath,
        }).catch(() => {});
      }
      await recordAndPublishAssetChange({
        kind: 'create',
        asset_id: null,
        folder_id: ctx.folderId,
        abs_path: outcome.newAbsPath,
        relative_path: newRelativePath,
      }).catch((err) => {
        log.warn(
          {
            folderId: ctx.folderId.toHexString(),
            newRelativePath,
            err: err instanceof Error ? err.message : err,
          },
          'change-feed emit failed after file relocate (best-effort, ignoring)',
        );
      });

      return {
        status: 200,
        body: {
          new_abs_path: outcome.newAbsPath,
          new_path: newPath,
          new_filename: newFilename,
          renamed_on_collision: outcome.renamedOnCollision,
        },
      };
    }
  }
}

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

    const cacheCheck = refuseMapleCachePaths(folderPath, [rawPath]);
    if (!cacheCheck.ok) {
      set.status = cacheCheck.status;
      return { error: cacheCheck.error };
    }

    const fileCheck = await resolveExistingFile(folderPath, rawPath);
    if (!fileCheck.ok) {
      set.status = fileCheck.status;
      return { error: fileCheck.error };
    }

    const assetGuard = await refuseIfIndexedAsset(folderId, rawPath, 'DELETE /api/assets/:id');
    if (!assetGuard.ok) {
      set.status = assetGuard.status;
      return assetGuard.body;
    }

    // Same literal-join convention `POST /:id/upload` uses when calling
    // `moveToTrash` — the primitive's `computeTrashPath` requires its
    // input to be prefixed by `folderPath` exactly as registered, not by
    // whatever `realpath` resolved it to (e.g. `/var` vs `/private/var`
    // on macOS).
    const absPath = nodePath.join(folderPath, rawPath);
    const moved = await moveToTrash(absPath, folderPath);
    const response = await respondToTrashOutcome(moved, {
      folderId,
      absPath,
      relativePath: rawPath,
    });
    set.status = response.status;
    return response.body;
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

      const shapeCheck = validateRelocateShape(body);
      if (!shapeCheck.ok) {
        set.status = shapeCheck.status;
        return { error: shapeCheck.error };
      }

      const cacheCheck = refuseMapleCachePaths(folderPath, [
        body.source_path,
        body.destination_path,
      ]);
      if (!cacheCheck.ok) {
        set.status = cacheCheck.status;
        return { error: cacheCheck.error };
      }

      // Confirm the source exists and stays inside the jail (symlink-safe
      // — same check the read-side `GET /:id/file` uses).
      const sourceCheck = await resolveExistingFile(folderPath, body.source_path);
      if (!sourceCheck.ok) {
        set.status = sourceCheck.status;
        return { error: sourceCheck.error };
      }

      const assetGuard = await refuseIfIndexedAsset(
        folderId,
        body.source_path,
        'POST /api/assets/:id/relocate',
      );
      if (!assetGuard.ok) {
        set.status = assetGuard.status;
        return assetGuard.body;
      }

      const { filename: sourceFilename } = splitRelPath(body.source_path);
      const destCheck = await resolveRelocateDestination(
        folderPath,
        body.destination_path,
        body.destination_filename,
        sourceFilename,
      );
      if (!destCheck.ok) {
        set.status = destCheck.status;
        return { error: destCheck.error };
      }

      const sourceAbsPath = nodePath.join(folderPath, body.source_path);
      const mode = body.mode as RelocateMode;
      const outcome = await relocateFile({
        sourceAbsPath,
        destAbsPath: destCheck.destAbsPath,
        mode,
        collision: body.collision as CollisionPolicy,
        callerTag: 'folders/file/relocate',
      });

      const response = await respondToRelocateOutcome(outcome, {
        folderId,
        folderPath,
        mode,
        sourceAbsPath,
        sourceRelativePath: body.source_path,
      });
      set.status = response.status;
      return response.body;
    },
    { body: RelocateFileBodySchema },
  );
