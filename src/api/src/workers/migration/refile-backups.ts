/**
 * Migration: "Refile backups" — a one-time cleanup that re-files already-processed
 * mobile-backup photos into their canonical folder.
 *
 * Replaces three separate migrations whose path logic this unifies:
 *   - restructure-backup-geo         → `<year>/<Country|State>/<Town/City|Place>`
 *   - restructure-backup-screenshots → `<year>/Screenshot`
 *   - restructure-backup-folders     → flatten old `<year>/<loc>/<MM-DD>` day-folders
 *
 * Why it exists: the geo migration gated re-work on a one-way `backup_layout_version`
 * stamp that was written even on a no-op (e.g. when `place` was an unresolved stub
 * at the time it ran). Nothing ever cleared that stamp, so an asset migrated before
 * its geocode resolved was frozen in the wrong folder forever. This migration drops
 * the stamp-trust model: it computes the canonical dir from each asset's CURRENT
 * data and moves only when the actual path differs. The stamp is bumped each
 * generation purely as the worker's done-marker, so the `{ $ne: BACKUP_LAYOUT_VERSION }`
 * selector re-sweeps the whole backlog exactly once per bump and then terminates.
 *
 * The canonical dir mirrors what a fresh ingest (`backup/path-formatter.ts`) would
 * produce, so a migrated file lands byte-for-byte where a re-ingest would put it.
 * The crash-safe move (copy → verify → repoint → delete → reclaim) is the shared
 * `moveBackupAsset`.
 *
 * Spec: docs/superpowers/specs/2026-06-18-refile-backups-migration.md.
 */

import type { Filter, ObjectId } from 'mongodb';
import type { AssetDoc, FileInfo, Place, AssetExif } from '../../db/schema.ts';
import { assetsCollection } from '../../db/client.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import { assetPrimaryFileInfo, liveFileInfoElemMatch } from '../../indexer/images.repo.ts';
import { backupLocationSegments } from '../../backup/location-segments.ts';
import { sanitizeLocationSegments, SCREENSHOT_DIR_SEGMENT } from '../../backup/path-formatter.ts';
import { child as childLogger } from '../../log.ts';
import type { Migration, MigrationBatchResult } from './types.ts';
import { SourceMissingError } from './restructure-fs.ts';
import { moveBackupAsset, type MoveOutcome } from './move-backup-asset.ts';

const log = childLogger('migration:refile');

/** Layout generation stamped on a refiled asset — the worker's done-marker, NOT a
 * correctness oracle. See `AssetDoc.backup_layout_version`.
 *
 * v4 (#1525): the no-location branch now mirrors `formatBackupPath`'s `<year>/<MM>`
 * (it previously left undated/junk-folder files in place), so the bump re-sweeps
 * the library once to normalise e.g. `2026/2595` → `2026/05`. Only mis-filed
 * assets actually move; the rest no-op and re-stamp. */
export const BACKUP_LAYOUT_VERSION = 4;

/** Matches the screenshot destination layout (`<year>/Screenshot`) exactly — the
 * "already filed" gate inside `relocateBackupScreenshot`. */
const SCREENSHOT_DIR_RE = new RegExp(`^\\d{4}/${SCREENSHOT_DIR_SEGMENT}$`);

/** A dated backup directory (`<year>/…`). Every path the backup formatter emits
 * starts with the 4-digit year, so a non-dated path is not a backup folder we file. */
const DATED_BACKUP_DIR_RE = /^\d{4}\//;

/** Year prefix for the canonical path. Prefer the year the file already lives under
 * (the leading path segment) so an asset is never moved across year folders; fall
 * back to the EXIF capture year only when the path lacks a 4-digit lead. */
function yearFor(oldDir: string, capturedYear: number | null | undefined): string | null {
  const seg0 = oldDir.split('/')[0] ?? '';
  if (/^\d{4}$/.test(seg0)) return seg0;
  if (capturedYear != null && Number.isFinite(capturedYear)) {
    return String(Math.trunc(capturedYear)).padStart(4, '0');
  }
  return null;
}

/** Zero-padded `MM` for the no-location `<year>/<MM>` layout, or `null` when the
 * capture month is unknown (then we don't invent a month-folder — see the
 * no-location branch). Exported for the video-exif backfill, which only resets the
 * refile marker when a usable month exists. */
export function monthFor(capturedMonth: number | null | undefined): string | null {
  if (
    capturedMonth != null &&
    Number.isInteger(capturedMonth) &&
    capturedMonth >= 1 &&
    capturedMonth <= 12
  ) {
    return String(capturedMonth).padStart(2, '0');
  }
  return null;
}

/**
 * The canonical directory a backup asset's canonical live entry
 * (`assetPrimaryFileInfo` — the first live `fileinfo`, i.e. neither `deleted_at`
 * nor `missing_since` set per `isLiveFileInfo`, NOT blindly `fileinfo[0]`, which
 * may be a delete-then-readd tombstone) should live in, or
 * `null` when there is no live entry / the year can't be determined (pathological
 * — every backup path starts with `<year>/`). The rule, in precedence order:
 *
 *   1. screenshot (`is_screenshot`)         → `<year>/Screenshot`  (wins over location)
 *   2. resolved location (`place` segments) → `<year>/<seg>/<seg>`
 *   3. no location, capture month known     → `<year>/<MM>`  (mirrors formatBackupPath)
 *   4. no location, no month                → flatten a recognised old day-folder,
 *      else leave the asset where it is (we never invent a month-folder).
 *
 * Pure (no DB / fs) and exhaustively unit-tested. Mirrors `formatBackupPath` so a
 * migrated file matches a fresh ingest of the same asset.
 */
export function computeCanonicalDir(doc: {
  fileinfo?: FileInfo[];
  place?: Place | null;
  is_screenshot?: boolean;
  exif?: {
    captured_year?: AssetExif['captured_year'];
    captured_month?: AssetExif['captured_month'];
  } | null;
}): string | null {
  const primary = doc.fileinfo ? assetPrimaryFileInfo({ fileinfo: doc.fileinfo }) : null;
  const oldDir = primary?.path;
  if (oldDir == null) return null;
  const year = yearFor(oldDir, doc.exif?.captured_year);
  if (!year) return null;

  // A UI capture isn't a "place" photo — screenshot wins over location and date.
  if (doc.is_screenshot) return `${year}/${SCREENSHOT_DIR_SEGMENT}`;

  const segs = sanitizeLocationSegments(backupLocationSegments(doc.place ?? null));
  if (segs.length > 0) return `${year}/${segs.join('/')}`;

  // No usable location → mirror `formatBackupPath`'s `<year>/Misc`
  return `${year}/Misc`;
}

/** Selects backup-origin assets not yet refiled into the current layout. No `place`
 * or `is_screenshot` constraint — `computeCanonicalDir` handles geo, screenshot, and
 * date-fallback uniformly, so this one selector subsumes all three old migrations.
 * The `{ $ne: BACKUP_LAYOUT_VERSION }` gate is the done-marker: a refiled (moved or
 * no-op) asset is stamped with the current generation and drops out, so
 * `countRemaining` reaches 0.
 *
 * Liveness is gated with the shared `liveFileInfoElemMatch()` ("has ≥1 live
 * entry"), NOT `'fileinfo.0.deleted_at': null`. The old form leaked
 * delete-then-readd docs (a soft-deleted tombstone at `fileinfo[0]` + a live
 * entry later) through MongoDB's array null-path matching; the migration then took
 * the tombstone as primary, `moveBackupAsset` skipped it without stamping, and —
 * the fetch being unsorted — those un-stampable docs head-of-line-blocked every
 * batch (#1519). */
function candidateFilter(): Filter<AssetDoc> {
  return {
    'phasset_links.0': { $exists: true },
    ...liveFileInfoElemMatch(),
    backup_layout_version: { $ne: BACKUP_LAYOUT_VERSION },
  } as Filter<AssetDoc>;
}

export const refileBackups: Migration = {
  id: 'refile-backups',
  title: 'Refile backups into canonical folders',
  description:
    'One-time cleanup: re-file every mobile-backup photo into the folder a fresh ' +
    'ingest would use today — year/Country (or State) with a town/city or place ' +
    'subfolder, year/Screenshot for screenshots, year/month otherwise. Moves only ' +
    'mis-filed assets; copy-verify-delete, never overwrites; idempotent.',

  async countRemaining(): Promise<number> {
    const coll = await assetsCollection();
    return coll.countDocuments(candidateFilter());
  },

  async runBatch(batchSize: number): Promise<MigrationBatchResult> {
    const coll = await assetsCollection();
    let libs: ReadonlyMap<string, string>;
    try {
      libs = await loadLibraryRoots();
    } catch {
      libs = new Map();
    }

    const docs = await coll
      .find(candidateFilter(), {
        projection: {
          _id: 1,
          fileinfo: 1,
          maple_id: 1,
          apple_rendered_path: 1,
          place: 1,
          is_screenshot: 1,
          'exif.captured_year': 1,
          'exif.captured_month': 1,
        },
      })
      .limit(batchSize)
      .toArray();

    let processed = 0;
    let errors = 0;
    let skippedNoRoot = 0;
    for (const doc of docs) {
      // The canonical entry is the first LIVE fileinfo, not blindly `fileinfo[0]`:
      // delete-then-readd docs carry a soft-deleted tombstone at index 0 with the
      // live file later in the array (#1519).
      const primary = assetPrimaryFileInfo(doc);
      if (!primary) {
        // No live entry to refile (an all-tombstone doc the selector should not
        // surface). Stamp it done so it drops out instead of head-of-line-blocking
        // the unsorted batch forever.
        await coll.updateOne(
          { _id: doc._id },
          { $set: { backup_layout_version: BACKUP_LAYOUT_VERSION } },
        );
        processed++;
        continue;
      }
      const root = libs.get(primary.library_id.toHexString());
      if (!root) {
        // Library unregistered / offline — skip without erroring; retried once a
        // tick until the mount returns. Never delete on an offline mount. Counted
        // + logged after the loop so a fleet-wide root-resolution stall is visible
        // instead of masquerading as a clean "batch complete".
        skippedNoRoot++;
        continue;
      }

      const newDir = computeCanonicalDir(doc);
      if (newDir == null) {
        // No determinable year (pathological). Stamp so the asset isn't reselected
        // forever; leave the file exactly where it is.
        await coll.updateOne(
          { _id: doc._id },
          { $set: { backup_layout_version: BACKUP_LAYOUT_VERSION } },
        );
        log.warn(
          { _id: String(doc._id), maple_id: doc.maple_id, path: primary?.path },
          'refile: could not determine year — stamped, left in place',
        );
        processed++;
        continue;
      }

      try {
        const result = await moveBackupAsset(coll, doc, root, newDir, {
          backup_layout_version: BACKUP_LAYOUT_VERSION,
        });
        // 'moved' (relocated + stamped) and 'noop' (already in place, stamped) both
        // reduce the remaining count. 'skipped' is a concurrent-change revert —
        // left UNstamped for a later tick to re-attempt.
        if (result === 'moved') {
          log.info(
            { _id: String(doc._id), maple_id: doc.maple_id, from: primary?.path, to: newDir },
            'refile: moved',
          );
        }
        if (result === 'moved' || result === 'noop') processed++;
      } catch (err) {
        if (err instanceof SourceMissingError) {
          // The source original is gone from disk — nothing to move. Stamp it so
          // the asset drops out of the candidate set instead of being re-fetched
          // every tick; an entire batch of missing sources would otherwise
          // head-of-line-block the rest of the library. The missing-reaper owns
          // the row's eventual cleanup.
          await coll.updateOne(
            { _id: doc._id },
            { $set: { backup_layout_version: BACKUP_LAYOUT_VERSION } },
          );
          log.warn(
            { _id: String(doc._id), maple_id: doc.maple_id, from: primary?.path, err: err.message },
            'refile: source missing — stamped, left for the reaper',
          );
          processed++;
          continue;
        }
        errors++;
        log.error(
          {
            _id: String(doc._id),
            maple_id: doc.maple_id,
            from: primary?.path,
            to: newDir,
            err: err instanceof Error ? err.message : err,
          },
          'refile: asset move failed — left in place for retry',
        );
      }
    }
    if (skippedNoRoot > 0) {
      log.warn(
        { skippedNoRoot, batchSize: docs.length, processed },
        'refile: assets skipped — library root unresolved (offline mount?); will retry next tick',
      );
    }
    return { processed, errors };
  },
};

/**
 * On-the-fly relocation for the describe stage. When the qwen2.5-vl verdict flips
 * `is_screenshot` true on a backup-origin asset the ingest filename heuristic missed
 * (e.g. an iOS capture that arrived as `IMG_*.PNG`), file it under `<year>/Screenshot`
 * immediately — so a screenshot never lingers in the wrong folder waiting for an
 * operator to run a cleanup.
 *
 * It does NOT re-read `is_screenshot`: the describe handler calls this BEFORE its own
 * patch (which sets the flag) is persisted, so the flag isn't on disk yet. It trusts
 * the caller's verdict and only checks backup-origin + a dated, not-already-filed
 * folder — hence the dedicated screenshot-dir computation rather than
 * `computeCanonicalDir` (which branches on the persisted flag).
 *
 * Self-contained and idempotent: re-reads the asset fresh, applies the same gate as
 * the migration's screenshot branch, and delegates the crash-safe move to
 * `moveBackupAsset`. Returns the move outcome, or `'not-applicable'` when the asset
 * isn't a backup screenshot that needs moving. The caller invokes it best-effort.
 */
export async function relocateBackupScreenshot(
  assetId: ObjectId,
): Promise<MoveOutcome | 'not-applicable'> {
  const coll = await assetsCollection();
  const doc = await coll.findOne(
    { _id: assetId },
    {
      projection: {
        _id: 1,
        fileinfo: 1,
        maple_id: 1,
        apple_rendered_path: 1,
        phasset_links: 1,
        'exif.captured_year': 1,
      },
    },
  );
  if (!doc) return 'not-applicable';
  // Backup-origin only — the <year>/Screenshot layout is the PhotoKit-backup
  // contract; a folder-scanned library is laid out by the user, untouched.
  if (!doc.phasset_links || doc.phasset_links.length === 0) return 'not-applicable';
  const primary = assetPrimaryFileInfo(doc);
  if (!primary) return 'not-applicable';
  // A dated backup folder, not already filed under <year>/Screenshot.
  if (!DATED_BACKUP_DIR_RE.test(primary.path) || SCREENSHOT_DIR_RE.test(primary.path)) {
    return 'not-applicable';
  }
  const year = yearFor(primary.path, doc.exif?.captured_year);
  if (!year) return 'not-applicable';
  const newDir = `${year}/${SCREENSHOT_DIR_SEGMENT}`;
  if (newDir === primary.path) return 'not-applicable';
  const libs = await loadLibraryRoots();
  const root = libs.get(primary.library_id.toHexString());
  if (!root) return 'not-applicable';
  return moveBackupAsset(coll, doc, root, newDir);
}
