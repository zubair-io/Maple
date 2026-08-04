/**
 * Migration: relocate assets stuck in either shape of the OLD 3-segment
 * backup day-dir layout (`<year>/<location>/<MM>-<DD>` with a location, or
 * `<year>/<MM>/<DD>` without one — see `restructure-path.ts`) that
 * `refile-backups` cannot reach or cannot correct:
 *
 *   - `refile-backups`'s candidate filter requires `phasset_links.0` to
 *     exist; some legacy day-dir assets lost/never had that field and are
 *     invisible to it.
 *   - Even when reached, `refile-backups`'s `yearFor` deliberately keeps
 *     whatever year the asset's existing path segment claims ("never move an
 *     asset across year folders") — so a day-dir asset whose leading year
 *     segment is simply WRONG never gets corrected, only flattened.
 *
 * This migration targets exactly that: an asset whose live path is still in
 * one of the old day-dir shapes, has no EXIF capture year, but whose Android
 * default-camera filename (`IMG_YYYYMMDD_HHMMSS`) still encodes the true
 * capture date. The corrected year comes from EXIF when present, else the
 * parsed filename date — see `computeCorrectedDir`. Either shape corrects to
 * the SAME current-layout target (`<year>/<location>` or `<year>/Misc` —
 * `computeCorrectedDir` never looks at which old shape it came from, only at
 * the asset's current place/screenshot/year). The actual relocation
 * reuses the same crash-safe, mirror-aware move as `refile-backups`
 * (`moveBackupAsset` — every filesystem op fans out to the library's
 * configured backup mirror via `fs/mirrored.ts`, see that module's docstring).
 *
 * An asset with neither EXIF nor a parseable filename date is permanently
 * unresolvable by this logic. Rather than leaving it to be re-selected by
 * `countRemaining()` forever, `runBatch` stamps it with
 * `legacy_daydir_version` (same done-marker pattern as
 * `backup_layout_version` in `refile-backups`) so it drops out of the
 * candidate set — logged as a warning for manual review, left in place.
 *
 * Candidate scoping is pushed into the Mongo query itself
 * (`legacyDaydirCandidateFilter`) so a run over a ~90k-asset library only
 * ever fetches the handful of still-mis-filed rows, not the whole collection.
 */
import type { Filter } from 'mongodb';
import type { AssetDoc, Place } from '../../db/schema.ts';
import { assetsCollection } from '../../db/client.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import { assetPrimaryFileInfo } from '../../indexer/images.repo.ts';
import { sanitizeLocationSegments, SCREENSHOT_DIR_SEGMENT } from '../../backup/path-formatter.ts';
import { backupLocationSegments } from '../../backup/location-segments.ts';
import { parseFilenameCapturedAt } from '../../backup/filename-date.ts';
import { child as childLogger } from '../../log.ts';
import type { Migration, MigrationBatchResult } from './types.ts';
import { SourceMissingError } from './restructure-fs.ts';
import { moveBackupAsset } from './move-backup-asset.ts';

const log = childLogger('migration:refile-legacy-daydir');

/** Done-marker generation — see `AssetDoc.legacy_daydir_version`. Bump to
 * re-sweep the backlog (e.g. after fixing a bug in `computeCorrectedDir`). */
export const LEGACY_DAYDIR_VERSION = 1;

/**
 * Precise structural gate for the OLD "with location" backup day-dir layout:
 * `<year>/<single-location-segment>/<MM>-<DD>` — the OLD "with location" day-dir
 * shape. See `LEGACY_DAYDIR_NO_LOCATION_RE` for its no-location sibling.
 */
export const LEGACY_DAYDIR_WITH_LOCATION_RE = /^\d{4}\/[^/]+\/\d{2}-\d{2}$/;

/**
 * Precise structural gate for the OLD "no location" backup day-dir layout:
 * `<year>/<MM>/<DD>` (two plain 2-digit segments, no dash) — the sibling
 * `restructure-path.ts` documents alongside the with-location shape. Its
 * current (post-cleanup) equivalent is the flattened `<year>/<MM>` — 2
 * segments, so it never collides with this 3-segment pattern.
 */
export const LEGACY_DAYDIR_NO_LOCATION_RE = /^\d{4}\/\d{2}\/\d{2}$/;

/** True when `dir` is either shape of the old 3-segment backup day-dir
 * layout. Both patterns are precise (anchored, full-path) — used directly as
 * the Mongo prefilter too, so the query itself only ever returns a genuine
 * match, never a loose "ends with 2 digits" superset that would sweep in
 * unrelated current-layout paths. */
export function isLegacyDaydirPath(dir: string): boolean {
  return LEGACY_DAYDIR_WITH_LOCATION_RE.test(dir) || LEGACY_DAYDIR_NO_LOCATION_RE.test(dir);
}

/** Mongo filter scoping a find() to assets with a live fileinfo entry still
 * in either old day-dir layout AND not yet stamped done. Pushes the
 * candidate scoping into the query so a run over the full library only
 * fetches the mis-filed, unresolved rows — never a full collection scan in
 * app code. */
export function legacyDaydirCandidateFilter(): Filter<AssetDoc> {
  return {
    fileinfo: {
      $elemMatch: {
        path: { $in: [LEGACY_DAYDIR_WITH_LOCATION_RE, LEGACY_DAYDIR_NO_LOCATION_RE] },
        deleted_at: { $in: [null] },
        missing_since: { $in: [null] },
      },
    },
    legacy_daydir_version: { $ne: LEGACY_DAYDIR_VERSION },
  } as Filter<AssetDoc>;
}

/**
 * The asset's true capture year: EXIF `captured_year` when present, else the
 * year parsed from an Android-convention filename. Returns null when neither
 * source resolves — the caller must skip (and flag for manual review) rather
 * than guess.
 */
export function resolveLegacyCapturedYear(
  doc: { exif?: { captured_year?: number | null } | null },
  filename: string,
): number | null {
  if (doc.exif?.captured_year != null) return doc.exif.captured_year;
  const parsed = parseFilenameCapturedAt(filename);
  return parsed ? parsed.getUTCFullYear() : null;
}

/**
 * The corrected canonical directory for a legacy day-dir asset. Mirrors
 * `refile-backups`'s `computeCanonicalDir` screenshot/location/misc branches,
 * but the year comes from `resolveLegacyCapturedYear` (EXIF, else the parsed
 * filename date) rather than the asset's existing (possibly wrong) path —
 * this function never looks at the old path at all. Returns null when the
 * year can't be determined.
 */
export function computeCorrectedDir(
  doc: {
    place?: Place | null;
    is_screenshot?: boolean;
    exif?: { captured_year?: number | null } | null;
  },
  filename: string,
): string | null {
  const year = resolveLegacyCapturedYear(doc, filename);
  if (year == null) return null;
  const y = String(year).padStart(4, '0');

  if (doc.is_screenshot) return `${y}/${SCREENSHOT_DIR_SEGMENT}`;

  const segs = sanitizeLocationSegments(backupLocationSegments(doc.place ?? null));
  if (segs.length > 0) return `${y}/${segs.join('/')}`;
  return `${y}/Misc`;
}

export const refileLegacyDaydir: Migration = {
  id: 'refile-legacy-daydir',
  title: 'Refile legacy backup day-dir folders',
  description:
    'One-time cleanup: relocate assets still filed under the old backup ' +
    '<year>/<location>/<MM>-<DD> day-dir layout into the year their EXIF — ' +
    'or, when EXIF is missing, their Android IMG_YYYYMMDD_HHMMSS filename — ' +
    'says they actually belong in. Reaches assets refile-backups cannot ' +
    '(no phasset_links) or will not correct (never crosses year folders). ' +
    'Assets with neither EXIF nor a parseable filename date are stamped and ' +
    'left in place for manual review.',

  async countRemaining(): Promise<number> {
    const coll = await assetsCollection();
    return coll.countDocuments(legacyDaydirCandidateFilter());
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
      .find(legacyDaydirCandidateFilter(), {
        projection: {
          _id: 1,
          fileinfo: 1,
          maple_id: 1,
          apple_rendered_path: 1,
          place: 1,
          is_screenshot: 1,
          'exif.captured_year': 1,
        },
      })
      .limit(batchSize)
      .toArray();

    let processed = 0;
    let errors = 0;
    let skippedNoRoot = 0;
    for (const doc of docs) {
      const primary = assetPrimaryFileInfo(doc);
      if (!primary || !isLegacyDaydirPath(primary.path)) {
        // The loose Mongo prefilter matched, but the precise structural gate
        // didn't (or there's no live entry at all) — not a real candidate.
        // Stamp it done so it doesn't keep re-matching the query forever.
        await coll.updateOne(
          { _id: doc._id },
          { $set: { legacy_daydir_version: LEGACY_DAYDIR_VERSION } },
        );
        processed++;
        continue;
      }

      const newDir = computeCorrectedDir(doc, primary.filename);
      if (newDir == null) {
        await coll.updateOne(
          { _id: doc._id },
          { $set: { legacy_daydir_version: LEGACY_DAYDIR_VERSION } },
        );
        log.warn(
          { _id: String(doc._id), maple_id: doc.maple_id, path: primary.path },
          'refile-legacy-daydir: no EXIF and no parseable filename date — stamped, left in place',
        );
        processed++;
        continue;
      }

      const root = libs.get(primary.library_id.toHexString());
      if (!root) {
        // Library unregistered / offline — skip without erroring or stamping;
        // retried next tick once the mount returns. Never delete on an
        // offline mount.
        skippedNoRoot++;
        continue;
      }

      try {
        const result = await moveBackupAsset(coll, doc, root, newDir, {
          legacy_daydir_version: LEGACY_DAYDIR_VERSION,
        });
        if (result === 'moved') {
          log.info(
            { _id: String(doc._id), maple_id: doc.maple_id, from: primary.path, to: newDir },
            'refile-legacy-daydir: moved',
          );
        }
        // 'moved' and 'noop' both stamp + reduce the remaining count.
        // 'skipped' = a concurrent change reverted the attempt — left
        // UNstamped so the next tick re-attempts from the current state.
        if (result === 'moved' || result === 'noop') processed++;
      } catch (err) {
        if (err instanceof SourceMissingError) {
          // Source original is gone from disk. Stamp so this doesn't
          // head-of-line-block the batch forever; the missing-reaper owns
          // the row's eventual cleanup.
          await coll.updateOne(
            { _id: doc._id },
            { $set: { legacy_daydir_version: LEGACY_DAYDIR_VERSION } },
          );
          log.warn(
            { _id: String(doc._id), maple_id: doc.maple_id, from: primary.path, err: err.message },
            'refile-legacy-daydir: source missing — stamped, left for the reaper',
          );
          processed++;
          continue;
        }
        errors++;
        log.error(
          {
            _id: String(doc._id),
            maple_id: doc.maple_id,
            from: primary.path,
            to: newDir,
            err: err instanceof Error ? err.message : err,
          },
          'refile-legacy-daydir: move failed — left in place for retry',
        );
      }
    }
    if (skippedNoRoot > 0) {
      log.warn(
        { skippedNoRoot, batchSize: docs.length, processed },
        'refile-legacy-daydir: assets skipped — library root unresolved (offline mount?); will retry next tick',
      );
    }
    return { processed, errors };
  },
};
