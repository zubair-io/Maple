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
 * does not regress that side effect. `dedupeLiveFileinfo` (also reused from
 * `move-backup-asset.ts`) reconciles a discover-watcher race the same way.
 */
import type { Collection, WithId } from 'mongodb';
import * as path from 'node:path';
import type { AssetDoc, FileInfo } from '../db/schema.ts';
import { child as childLogger } from '../log.ts';
import { filesIdentical } from '../backup/fs-util.ts';
import { listPairedSidecars } from '../fs/xmp-conflict.ts';
import * as fs from '../fs/mirrored.ts';
import { relocateAsset } from './relocate-asset.ts';
import { relocateCacheStageResetSet, liveFileinfoMatchFilter } from '../db/relocate-cache-reset.ts';
import { MEILI_REARM_SET } from '../people/people-search-reindex.ts';
import { finalize } from '../workers/migration/restructure-fs.ts';
import { dedupeLiveFileinfo } from '../workers/migration/move-backup-asset.ts';

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
  c: Collection<AssetDoc>,
  doc: WithId<AssetDoc>,
  oldDirAbs: string,
  libRoot: string,
  newDir: string,
  primary: FileInfo,
  sourceAbsPath: string,
): Promise<GeoMoveOutcome> {
  const set: Record<string, unknown> = {
    'fileinfo.$.path': newDir,
    'fileinfo.$.filename': primary.filename,
    'fileinfo.$.missing_since': null,
    ...MEILI_REARM_SET,
    ...relocateCacheStageResetSet(),
  };
  const res = await c.updateOne(liveFileinfoMatchFilter(doc._id, primary), { $set: set } as never);
  if (res.matchedCount === 0) {
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
  await dedupeLiveFileinfo(c, doc._id);
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
  c: Collection<AssetDoc>,
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
    return dedupeAt(c, doc, oldDirAbs, libRoot, newDir, primary, sourceAbsPath);
  }

  const outcome = await relocateAsset({
    id: doc._id,
    mode: 'move',
    collision: 'auto-suffix',
    destinationPath: newDir,
    renderedCompanionAbsPath: renderedPresent ? renderedAbsPath : null,
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
  await dedupeLiveFileinfo(c, doc._id);
  return 'moved';
}
