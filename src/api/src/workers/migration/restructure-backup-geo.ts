/**
 * Migration: "Restructure backups by location".
 *
 * Re-files already-backed-up photos into the geographic layout introduced in
 * docs/superpowers/specs/2026-06-05-backup-geo-layout.md:
 *
 *   USA:        <year>/<State>/<Town/City || Place Name>/<file>
 *   elsewhere:  <year>/<Country>/<Town/City || Place Name>/<file>
 *   no place:   <year>/<MM>/<file>   (unchanged fallback)
 *
 * Scope: backup-origin assets (`phasset_links`) whose canonical entry
 * (`fileinfo[0]`) is live, that HAVE been reverse-geocoded (`place` is set —
 * resolved or an unresolvable stub), and that have not yet been stamped into
 * this layout (`backup_layout_version !== 2`). Screenshots (`is_screenshot`) are
 * excluded — they are filed under `<year>/Screenshot` by the dedicated
 * `restructure-backup-screenshots` migration, not by location. Assets with GPS
 * that the geocode
 * worker hasn't reached yet (`place == null`) are intentionally NOT candidates:
 * their final folder isn't known, so they're left until geocoding fills `place`
 * and a later run picks them up. No-GPS assets are already in the (unchanged)
 * date-only fallback and so need no work — they're excluded by the `place`
 * requirement too.
 *
 * The new directory is derived from the asset's stored `place` via the SAME
 * `backupLocationSegments` + `sanitizeLocationSegments` the ingest formatter
 * uses, so a migrated file lands byte-for-byte where a fresh ingest of the same
 * place would write it. The crash-safe move itself (copy → verify → repoint →
 * delete → reclaim) is the shared `moveBackupAsset`; the repoint also stamps
 * `backup_layout_version: 2` so the asset is never reselected. Idempotent: an
 * asset already in the right place is stamped without a file move.
 */

import type { FileInfo, Place, AssetExif } from '../../db/schema.ts';
import { assetsCollection } from '../../db/client.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import { backupLocationSegments } from '../../backup/location-segments.ts';
import { sanitizeLocationSegments } from '../../backup/path-formatter.ts';
import { child as childLogger } from '../../log.ts';
import type { Migration, MigrationBatchResult } from './types.ts';
import { SourceMissingError } from './restructure-fs.ts';
import { moveBackupAsset } from './move-backup-asset.ts';

const log = childLogger('migration:geo');

/** Layout generation stamped on a migrated asset. See `AssetDoc.backup_layout_version`. */
export const BACKUP_GEO_LAYOUT_VERSION = 2;

/** Selects geocoded backup-origin assets not yet in the geo layout. Screenshots
 * are deliberately excluded (`is_screenshot: { $ne: true }`): they belong in the
 * `<year>/Screenshot` folder, owned by `restructure-backup-screenshots`, so the
 * two migrations never fight over a GPS-bearing screenshot. */
function candidateFilter() {
  return {
    'phasset_links.0': { $exists: true },
    'fileinfo.0.deleted_at': null,
    is_screenshot: { $ne: true },
    place: { $type: 'object' },
    backup_layout_version: { $ne: BACKUP_GEO_LAYOUT_VERSION },
  } as const;
}

/** Year prefix for the new path. Prefer the year the file already lives under
 * (the leading path segment) so an asset is never moved across year folders;
 * fall back to the EXIF capture year only when the path lacks a 4-digit lead. */
function yearFor(oldDir: string, capturedYear: number | null | undefined): string | null {
  const seg0 = oldDir.split('/')[0] ?? '';
  if (/^\d{4}$/.test(seg0)) return seg0;
  if (capturedYear != null && Number.isFinite(capturedYear)) {
    return String(Math.trunc(capturedYear)).padStart(4, '0');
  }
  return null;
}

/**
 * Target directory for a candidate, or `null` when the year can't be determined
 * (pathological — every backup path starts with `<year>/`). Returns the asset's
 * CURRENT dir when the place is an unresolved stub (no usable segments): such an
 * asset already sits in the date-only fallback, so leaving it there is correct
 * and the move collapses to a no-op stamp. Exported for unit testing.
 */
export function computeGeoDir(doc: {
  fileinfo?: FileInfo[];
  place?: Place | null;
  exif?: { captured_year?: AssetExif['captured_year'] } | null;
}): string | null {
  const oldDir = doc.fileinfo?.[0]?.path;
  if (oldDir == null) return null;
  const year = yearFor(oldDir, doc.exif?.captured_year);
  if (!year) return null;
  const segs = sanitizeLocationSegments(backupLocationSegments(doc.place ?? null));
  if (segs.length === 0) return oldDir; // stub place → already in fallback; leave in place
  return `${year}/${segs.join('/')}`;
}

export const restructureBackupGeo: Migration = {
  id: 'restructure-backup-geo',
  title: 'Restructure backups by location',
  description:
    'Re-file backed-up photos into year/State (USA) or year/Country folders ' +
    'with a town/city (or place name) subfolder, derived from each photo’s ' +
    'GPS location. Photos without a location stay in the year/month fallback. ' +
    'Copy-verify-delete, never overwrites; idempotent.',

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
          'exif.captured_year': 1,
        },
      })
      .limit(batchSize)
      .toArray();

    let processed = 0;
    let errors = 0;
    for (const doc of docs) {
      const primary = (doc.fileinfo as FileInfo[] | undefined)?.[0];
      const root = primary ? libs.get(primary.library_id.toHexString()) : undefined;
      if (!root) {
        // Library unregistered / offline — skip without erroring; retried once a
        // tick until the mount returns. Never delete on an offline mount.
        continue;
      }

      const newDir = computeGeoDir(doc);
      if (newDir == null) {
        // No determinable year (pathological). Stamp so the asset isn't
        // reselected forever; leave the file exactly where it is.
        await coll.updateOne(
          { _id: doc._id },
          { $set: { backup_layout_version: BACKUP_GEO_LAYOUT_VERSION } },
        );
        log.warn(
          { _id: String(doc._id), path: primary?.path },
          'geo: could not determine year — stamped, left in place',
        );
        processed++;
        continue;
      }

      try {
        const result = await moveBackupAsset(coll, doc, root, newDir, {
          backup_layout_version: BACKUP_GEO_LAYOUT_VERSION,
        });
        // 'moved' (relocated + stamped) and 'noop' (already in place, stamped)
        // both reduce the remaining count. 'skipped' is a concurrent-change
        // revert — left UNstamped for a later tick to re-attempt.
        if (result === 'moved' || result === 'noop') processed++;
      } catch (err) {
        if (err instanceof SourceMissingError) {
          log.warn({ _id: String(doc._id), err: err.message }, 'geo: source missing — skipped');
          continue;
        }
        errors++;
        log.error(
          { _id: String(doc._id), err: err instanceof Error ? err.message : err },
          'geo: asset move failed — left in place for retry',
        );
      }
    }
    return { processed, errors };
  },
};
