/**
 * Per-asset move for the on-demand geo-relocate route (#1671), rebuilt on
 * top of the generic `relocateAsset` primitive (#2629/#2667) instead of the
 * migration-only `workers/migration/move-backup-asset.ts` (`moveBackupAsset`)
 * — see #2667.
 *
 * Two behaviors `moveBackupAsset` → `restructure-fs.ts`'s `planAndPlace`
 * implemented that the generic primitive doesn't natively know about are
 * reproduced here, at the caller level:
 *
 *   1. The Apple companions (`apple_rendered_path`, and since #5243
 *      `apple_live_video_path`) travel alongside the primary + sidecars via
 *      `relocateAsset`'s `appleCompanionAbsPaths` (#2667) — genuinely
 *      generalized onto the shared primitive, since a second real caller
 *      now needs it.
 *   2. A byte-identical, companion-free destination collapses to a
 *      "dedupe" (repoint + delete source, no copy) rather than
 *      auto-suffixing a duplicate. Kept as a caller-side pre-check here
 *      rather than a new `fs/relocate.ts` collision policy: it is
 *      content-identity semantics specific to this one caller (an
 *      unattended geo re-file, never a user-initiated move), not a generic
 *      collision-resolution mode every relocate caller needs — see #2667's
 *      discussion.
 *
 * Reuses `workers/migration/restructure-fs.ts`'s `finalize()` (with an
 * empty `sourcesToDelete` — the primary/sidecars/companion are already gone
 * by the time this runs) for the stale-`.maple`-cache-drop +
 * empty-folder-reclaim housekeeping `moveBackupAsset` also performed, so
 * switching the copy/verify/repoint mechanics onto the generic primitive
 * does not regress that side effect.
 *
 * This used to end with `dedupeLiveFileinfo`, which collapsed the duplicate
 * live entry a concurrent discover sweep could append for the new path
 * mid-move. There is no such call any more and nothing replaced it: on SQLite
 * the UNIQUE index over `(library_id, path, filename)` means the second entry
 * cannot be written in the first place, so the race is prevented rather than
 * repaired. See `db/repos/assets.refile.ts`.
 */
import { isExcludedLocation } from '../fs/mapleignore.ts';
import { refusesMoveUnderMarker } from '../fs/mapleignore-guard.ts';
import type { WithId } from '../db/object-id.ts';
import * as path from 'node:path';
import type { AssetDoc, FileInfo } from '../db/schema.ts';
import { presentAppleCompanions, type AppleCompanionSlot } from '../db/apple-companions.ts';
import { child as childLogger } from '../log.ts';
import { filesIdentical } from '../backup/fs-util.ts';
import { listPairedSidecars, listPairedSidecarsStrict } from '../fs/xmp-conflict.ts';
import {
  hasLegacyBackupEdit,
  removePhotoUnlessOldNameEditStays,
} from '../fs/legacy-backup-sidecar.ts';
import { carryLateSidecars } from '../fs/relocate-late-sidecar.ts';
import { serializeSidecarWrites } from '../fs/sidecar-write-order.ts';
import { xmpSidecarPath } from '../fs/xmp.ts';
import { settleCarriedSidecar, sidecarStemOwnedByAnotherFile } from '../fs/sidecar-ownership.ts';
import * as fs from '../fs/mirrored.ts';
import { relocateAsset } from './relocate-asset.ts';
import { repointAssetLocation } from '../db/repos/assets.relocate.repo.ts';
import { finalize } from '../workers/migration/restructure-fs.ts';

const log = childLogger('library/relocate-geo');

/** Mirrors `moveBackupAsset`'s return contract exactly — the route's JSON
 * response is a public shape web/Apple clients parse. `'noop'` was
 * reachable in `moveBackupAsset` only via an `extraSet` this caller never
 * passed (it deliberately never stamps `backup_layout_version`), so it is
 * not reproduced here. */
export type GeoMoveOutcome = 'moved' | 'skipped';

/** `true` when `dest` reaches the very directory entry `source` names — a
 * symlinked or case-aliased folder, or a symlink file — so the dedupe would
 * delete the only original (#4701). Both paths share a basename, so they are
 * one entry exactly when their parent folders are one folder. A hard link in a
 * genuinely different folder is a second entry: unlinking the source leaves it
 * intact, so it returns `false` and dedupes like any identical occupant. */
async function isSameDirectoryEntry(source: string, dest: string): Promise<boolean> {
  const [sourceFile, destFile, destEntry] = await Promise.all([
    fs.stat(source),
    fs.stat(dest),
    fs.lstat(dest),
  ]);
  if (sourceFile.dev !== destFile.dev || sourceFile.ino !== destFile.ino) return false;
  if (!destEntry.isFile()) return true;
  const [sourceDir, destDir] = await Promise.all([
    fs.stat(path.dirname(source)),
    fs.stat(path.dirname(dest)),
  ]);
  return sourceDir.dev === destDir.dev && sourceDir.ino === destDir.ino;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** A sidecar first written since the dedupe listed none (a first backup send,
 * a web save) follows the photo to the survivor before the source goes (#5069). */
async function carryLateToSurvivor(sourceAbsPath: string, survivor: string): Promise<void> {
  const late = await carryLateSidecars({
    sourceAbsPath,
    finalDest: survivor,
    listed: [],
    movedCompanions: [],
    publications: [],
  });
  for (const moved of late) {
    await settleCarriedSidecar(moved.source, moved.dest, moved.snapshot, moved.keepSource).catch(
      (err: unknown) => {
        log.warn(
          { source: moved.source, err: err instanceof Error ? err.message : err },
          'relocateGeoAsset: late sidecar settle failed — source kept',
        );
      },
    );
  }
}

async function removeSourceAfterRepoint(sourceAbsPath: string, survivor: string): Promise<void> {
  await carryLateToSurvivor(sourceAbsPath, survivor);
  await serializeSidecarWrites(
    [xmpSidecarPath(sourceAbsPath), `${sourceAbsPath}.xmp`],
    async () => {
      if (await sidecarLeftBehind(sourceAbsPath)) {
        log.error(
          { sourceAbsPath },
          'relocateGeoAsset: a late sidecar could not follow — source photo kept',
        );
        return;
      }
      await removePhotoUnlessOldNameEditStays(sourceAbsPath, 'relocateGeoAsset');
    },
  );
}

/** A sidecar still at the source that no sibling there keeps for itself would
 * be left with no photo, so the source photo stays with it. A folder that can't
 * be read throws rather than reading as empty, which keeps the photo too. */
async function sidecarLeftBehind(sourceAbsPath: string): Promise<boolean> {
  if ((await listPairedSidecarsStrict(sourceAbsPath)).length === 0) return false;
  return !(await sidecarStemOwnedByAnotherFile(sourceAbsPath));
}

/** The dedupe short-circuit: the destination already holds byte-identical
 * content and the source carries no companions to preserve, so there is
 * nothing to copy — just repoint the row to the existing occupant and
 * delete the now-redundant source. Mirrors `restructure-fs.ts`'s
 * `planAndPlace` dedupe branch (never touches an Apple companion slot — this
 * branch only runs when the source had no companion to begin with). */
async function dedupeAt(
  doc: WithId<AssetDoc>,
  oldDirAbs: string,
  libRoot: string,
  newDir: string,
  primary: FileInfo,
  sourceAbsPath: string,
): Promise<GeoMoveOutcome> {
  // One call where there used to be a hand-rolled `$set`: the repoint, the
  // cleared missing tag, the embed re-arm and the two path-keyed cache re-arms
  // are all `repointAssetLocation`'s job, and it applies them in one
  // transaction rather than one document update. Its `from` address is the
  // concurrency guard the `matchedCount === 0` check below still reads.
  const repointed = await repointAssetLocation({
    id: doc._id,
    from: {
      libraryId: primary.library_id,
      path: primary.path,
      filename: primary.filename,
    },
    to: {
      libraryId: primary.library_id,
      path: newDir,
      filename: primary.filename,
    },
  });
  if (!repointed) {
    log.warn(
      { _id: String(doc._id) },
      'relocateGeoAsset: dedupe repoint found no matching live entry — skipped',
    );
    return 'skipped';
  }

  log.info(
    {
      _id: String(doc._id),
      survivor: path.join(libRoot, newDir, primary.filename),
    },
    'relocateGeoAsset: byte-identical destination — deduped (repoint + delete source)',
  );
  const survivor = path.join(libRoot, newDir, primary.filename);
  // The row already points at the survivor, so a filesystem error here keeps the
  // source photo and is logged; it must not fail a move that has committed.
  await removeSourceAfterRepoint(sourceAbsPath, survivor).catch((err: unknown) => {
    log.warn(
      { sourceAbsPath, err: err instanceof Error ? err.message : err },
      'relocateGeoAsset: dedupe source cleanup failed — source photo kept',
    );
  });
  await finalize({
    libRoot,
    oldDirAbs,
    mapleId: doc.maple_id,
    filename: primary.filename,
    sourcesToDelete: [],
    carriedSidecars: [],
  });
  return 'moved';
}

/** The asset's recorded Apple companions that are on disk, as absolute paths by slot. */
async function presentCompanionAbsPaths(
  doc: Pick<AssetDoc, AppleCompanionSlot>,
  libRoot: string,
): Promise<Partial<Record<AppleCompanionSlot, string>>> {
  const recorded = await Promise.all(
    Object.entries(presentAppleCompanions(doc)).map(async ([slot, relative]) => {
      const absolute = path.join(libRoot, relative);
      return [slot, absolute, await pathExists(absolute)] as const;
    }),
  );
  return Object.fromEntries(
    recorded.filter(([, , onDisk]) => onDisk).map(([slot, absolute]) => [slot, absolute]),
  );
}

/** Relocate `doc`'s canonical (primary) file into `newDir`, preserving every
 * `moveBackupAsset` behavior the geo-relocate route depends on: the
 * Apple-rendered companion, the byte-identical dedupe short-circuit, and
 * the post-move `.maple` cache/folder housekeeping — but built on the
 * shared `relocateAsset` primitive instead of the migration-only code path.
 *
 * `primary` is the caller's already-resolved active fileinfo entry (the
 * route's own `assetActiveFileInfo`, which — unlike `relocateAsset`'s
 * `activeFileInfo` — does NOT exclude a `missing_since`-tagged entry; a
 * missing-tagged file the client has since restored on disk is still a
 * valid relocation candidate, matching the route's existing "clears
 * missing_since" contract). */
export async function relocateGeoAsset(
  doc: WithId<AssetDoc>,
  libRoot: string,
  newDir: string,
  primary: FileInfo,
): Promise<GeoMoveOutcome> {
  const oldDir = primary.path;
  if (newDir === oldDir) return 'skipped';
  // The `.mapleignore` guards (#5398): by tag, and on disk for both ends.
  if (
    isExcludedLocation(primary) ||
    (await refusesMoveUnderMarker(libRoot, oldDir)) ||
    (await refusesMoveUnderMarker(libRoot, newDir))
  ) {
    return 'skipped';
  }

  const oldDirAbs = path.join(libRoot, oldDir);
  const sourceAbsPath = path.join(libRoot, oldDir, primary.filename);
  const destAbsPath = path.join(libRoot, newDir, primary.filename);

  if ((await pathExists(destAbsPath)) && (await isSameDirectoryEntry(sourceAbsPath, destAbsPath))) {
    log.warn(
      { _id: String(doc._id), sourceAbsPath, destAbsPath },
      'relocateGeoAsset: destination is the source entry itself (symlink or case alias) — skipped',
    );
    return 'skipped';
  }

  const sidecars = await listPairedSidecars(sourceAbsPath);
  const appleCompanionAbsPaths = await presentCompanionAbsPaths(doc, libRoot);
  // An unreadable old-name edit is left out of the lenient listing but is still an edit (#5063).
  const hasCompanions =
    sidecars.length > 0 ||
    Object.keys(appleCompanionAbsPaths).length > 0 ||
    (await hasLegacyBackupEdit(sourceAbsPath));

  if (
    !hasCompanions &&
    (await pathExists(destAbsPath)) &&
    (await filesIdentical(sourceAbsPath, destAbsPath))
  ) {
    return dedupeAt(doc, oldDirAbs, libRoot, newDir, primary, sourceAbsPath);
  }

  const outcome = await relocateAsset({
    id: doc._id,
    mode: 'move',
    collision: 'auto-suffix',
    destinationPath: newDir,
    appleCompanionAbsPaths,
    // #2667 review: `relocateAsset`'s own `activeFileInfo(doc)` resolution
    // EXCLUDES a missing_since-tagged entry — but `primary` here came from
    // the route's `assetActiveFileInfo`, which deliberately does NOT. On a
    // multi-location asset where those two disagree, omitting this override
    // would silently relocate a DIFFERENT (clean) location than the one
    // this function's own dedupe pre-check and companion resolution just
    // computed against `primary`.
    activeFileInfoOverride: primary,
  });

  if (outcome.kind !== 'relocated') {
    // `relocateAsset` only returns `'skipped'` here for a concurrent-mutation
    // abort (mirrors `moveBackupAsset`'s `matchedCount === 0` handling) —
    // every other non-`'relocated'` kind is a genuine failure the route's
    // own try/catch turns into a per-asset error result.
    if (outcome.kind === 'skipped') return 'skipped';
    throw new Error(
      outcome.kind === 'error' || outcome.kind === 'invalid'
        ? outcome.error
        : `relocateGeoAsset: unexpected relocateAsset outcome "${outcome.kind}"`,
    );
  }

  await finalize({
    libRoot,
    oldDirAbs,
    mapleId: doc.maple_id,
    filename: primary.filename,
    sourcesToDelete: [],
    carriedSidecars: [],
  });
  return 'moved';
}
