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
 *   1. The Apple-rendered JPEG companion (`apple_rendered_path`) travels
 *      alongside the primary + sidecars via `relocateAsset`'s
 *      `renderedCompanionAbsPath` (#2667) — genuinely generalized onto the
 *      shared primitive, since a second real caller now needs it.
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
 * repaired. See `db/sqlite/repos/assets.refile.ts`.
 */
import type { WithId } from 'mongodb';
import * as path from 'node:path';
import type { AssetDoc, FileInfo } from '../db/schema.ts';
import { child as childLogger } from '../log.ts';
import { filesIdentical } from '../backup/fs-util.ts';
import { listPairedSidecars } from '../fs/xmp-conflict.ts';
import * as fs from '../fs/mirrored.ts';
import { relocateAsset } from './relocate-asset.ts';
import { repointAssetLocation } from '../db/sqlite/repos/assets.relocate.repo.ts';
import { finalize } from '../workers/migration/restructure-fs.ts';

const log = childLogger('library/relocate-geo');

/** Mirrors `moveBackupAsset`'s return contract exactly — the route's JSON
 * response is a public shape web/Apple clients parse. `'noop'` was
 * reachable in `moveBackupAsset` only via an `extraSet` this caller never
 * passed (it deliberately never stamps `backup_layout_version`), so it is
 * not reproduced here. */
export type GeoMoveOutcome = 'moved' | 'skipped';

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** The dedupe short-circuit: the destination already holds byte-identical
 * content and the source carries no companions to preserve, so there is
 * nothing to copy — just repoint the row to the existing occupant and
 * delete the now-redundant source. Mirrors `restructure-fs.ts`'s
 * `planAndPlace` dedupe branch (never touches `apple_rendered_path` — this
 * branch only runs when the source had no rendered companion to begin
 * with). */
async function dedupeAt(
  doc: WithId<AssetDoc>,
  oldDirAbs: string,
  libRoot: string,
  newDir: string,
  primary: FileInfo,
  sourceAbsPath: string,
): Promise<GeoMoveOutcome> {
  // One call where there used to be a hand-rolled `$set`: the repoint, the
  // cleared missing tag, the meili re-arm and the two path-keyed cache re-arms
  // are all `repointAssetLocation`'s job, and it applies them in one
  // transaction rather than one document update. Its `from` address is the
  // concurrency guard the `matchedCount === 0` check below still reads.
  const repointed = await repointAssetLocation({
    id: doc._id,
    from: { libraryId: primary.library_id, path: primary.path, filename: primary.filename },
    to: { libraryId: primary.library_id, path: newDir, filename: primary.filename },
  });
  if (!repointed) {
    log.warn(
      { _id: String(doc._id) },
      'relocateGeoAsset: dedupe repoint found no matching live entry — skipped',
    );
    return 'skipped';
  }

  log.info(
    { _id: String(doc._id), survivor: path.join(libRoot, newDir, primary.filename) },
    'relocateGeoAsset: byte-identical destination — deduped (repoint + delete source)',
  );
  await fs.unlink(sourceAbsPath).catch((err) => {
    log.warn(
      { sourceAbsPath, err: err instanceof Error ? err.message : err },
      'relocateGeoAsset: dedupe source unlink failed',
    );
  });
  await finalize({
    libRoot,
    oldDirAbs,
    mapleId: doc.maple_id,
    filename: primary.filename,
    sourcesToDelete: [],
  });
  return 'moved';
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

  const oldDirAbs = path.join(libRoot, oldDir);
  const sourceAbsPath = path.join(libRoot, oldDir, primary.filename);
  const destAbsPath = path.join(libRoot, newDir, primary.filename);
  const renderedAbsPath = doc.apple_rendered_path
    ? path.join(libRoot, doc.apple_rendered_path)
    : null;

  const sidecars = await listPairedSidecars(sourceAbsPath);
  const renderedPresent = renderedAbsPath !== null && (await pathExists(renderedAbsPath));
  const hasCompanions = sidecars.length > 0 || renderedPresent;

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
    renderedCompanionAbsPath: renderedPresent ? renderedAbsPath : null,
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
  });
  return 'moved';
}
