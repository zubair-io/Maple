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
import type { Collection, Filter, WithId } from 'mongodb';
import type { AssetDoc, FileInfo, Place } from '../../db/schema.ts';
import { assetsCollection } from '../../db/client.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import { assetPrimaryFileInfo } from '../../indexer/images.repo.ts';
import { sanitizeLocationSegments, SCREENSHOT_DIR_SEGMENT } from '../../backup/path-formatter.ts';
import { backupLocationSegments } from '../../backup/location-segments.ts';
import { parseFilenameCapturedAt } from '../../backup/filename-date.ts';
import { libraryRootAvailable } from '../missing-reaper.helpers.ts';
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
 * `<year>/<single-location-segment>/<MM>-<DD>`. See
 * `LEGACY_DAYDIR_NO_LOCATION_RE` for its no-location sibling.
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
 * The asset's true capture year: EXIF `captured_year` when present and
 * finite, else the year parsed from an Android-convention filename. A
 * non-finite (NaN/Infinity) EXIF value falls through to the filename instead
 * of propagating into a bogus directory name; a fractional value truncates —
 * mirrors the same guard `refile-backups`'s `yearFor` applies. Returns null
 * when neither source resolves — the caller must skip (and flag for manual
 * review) rather than guess.
 */
export function resolveLegacyCapturedYear(
  doc: { exif?: { captured_year?: number | null } | null },
  filename: string,
): number | null {
  const exifYear = doc.exif?.captured_year;
  if (exifYear != null && Number.isFinite(exifYear)) return Math.trunc(exifYear);
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

/** `loadLibraryRoots()`, but never throws — an unloadable registry degrades
 * to "no roots known" so the caller can skip-and-retry per asset instead of
 * failing the whole batch. */
async function loadLibraryRootsOrEmpty(): Promise<ReadonlyMap<string, string>> {
  try {
    return await loadLibraryRoots();
  } catch {
    return new Map();
  }
}

const CANDIDATE_PROJECTION = {
  _id: 1,
  fileinfo: 1,
  maple_id: 1,
  apple_rendered_path: 1,
  place: 1,
  is_screenshot: 1,
  'exif.captured_year': 1,
} as const;

async function fetchLegacyDaydirCandidates(
  coll: Collection<AssetDoc>,
  batchSize: number,
): Promise<WithId<AssetDoc>[]> {
  return coll
    .find(legacyDaydirCandidateFilter(), { projection: CANDIDATE_PROJECTION })
    .limit(batchSize)
    .toArray();
}

type CandidateOutcome = 'processed' | 'skipped-no-root' | 'retry-later' | 'error';

/** Stamp `legacy_daydir_version` on `doc` without relocating it — the
 * done-marker for a candidate this migration has fully evaluated but has
 * nothing to move (not a real candidate, or unresolvable). */
async function stampDone(coll: Collection<AssetDoc>, id: WithId<AssetDoc>['_id']): Promise<void> {
  await coll.updateOne({ _id: id }, { $set: { legacy_daydir_version: LEGACY_DAYDIR_VERSION } });
}

/** `SourceMissingError` from `moveBackupAsset` — distinguish "root offline"
 * (#2171: an unmounted mount ENOENTs on every child path indistinguishably
 * from a genuinely deleted file) from "file genuinely gone" before deciding
 * whether to stamp the asset done. */
async function handleSourceMissing(
  coll: Collection<AssetDoc>,
  doc: WithId<AssetDoc>,
  primary: FileInfo,
  root: string,
  err: SourceMissingError,
): Promise<CandidateOutcome> {
  if (!(await libraryRootAvailable(root))) {
    // Root itself unreachable — not proof this specific file is gone. Leave
    // UNstamped so a later tick, once the mount returns, re-verifies instead
    // of permanently giving up on a false "file deleted" read.
    log.warn(
      { _id: String(doc._id), maple_id: doc.maple_id, from: primary.path, root },
      'refile-legacy-daydir: library root unavailable — left in place for retry',
    );
    return 'skipped-no-root';
  }
  await stampDone(coll, doc._id);
  log.warn(
    { _id: String(doc._id), maple_id: doc.maple_id, from: primary.path, err: err.message },
    'refile-legacy-daydir: source missing — stamped, left for the reaper',
  );
  return 'processed';
}

/** Attempt the actual relocation for an already-resolved candidate
 * (`primary`/`newDir` both known-good). */
async function attemptLegacyDaydirMove(
  coll: Collection<AssetDoc>,
  doc: WithId<AssetDoc>,
  primary: FileInfo,
  root: string,
  newDir: string,
): Promise<CandidateOutcome> {
  try {
    // moveBackupAsset re-derives its own "active" entry internally (first
    // non-deleted, deliberately ignoring missing_since — it may be
    // resurrecting a missing-tagged entry) rather than trusting the caller's
    // pick. Handing it the unnarrowed doc would let that internal selection
    // diverge from `primary` whenever an earlier fileinfo entry is
    // missing-tagged but not deleted: it would then try to move THAT stale
    // entry, hit SourceMissingError, and stamp the asset done without ever
    // touching the live day-dir entry we validated. Narrowing `fileinfo` to
    // just `primary` makes moveBackupAsset's internal pick unambiguous.
    const result = await moveBackupAsset(coll, { ...doc, fileinfo: [primary] }, root, newDir, {
      legacy_daydir_version: LEGACY_DAYDIR_VERSION,
    });
    if (result === 'moved') {
      log.info(
        { _id: String(doc._id), maple_id: doc.maple_id, from: primary.path, to: newDir },
        'refile-legacy-daydir: moved',
      );
    }
    // 'moved' and 'noop' both stamp + reduce the remaining count. 'skipped'
    // = a concurrent change reverted the attempt — left UNstamped so the
    // next tick re-attempts from the current state.
    return result === 'moved' || result === 'noop' ? 'processed' : 'retry-later';
  } catch (err) {
    if (err instanceof SourceMissingError)
      return handleSourceMissing(coll, doc, primary, root, err);
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
    return 'error';
  }
}

/** Evaluate and (if resolvable) relocate one candidate. Pure orchestration —
 * all the actual filesystem/DB work is `moveBackupAsset`. */
async function processLegacyDaydirCandidate(
  coll: Collection<AssetDoc>,
  libs: ReadonlyMap<string, string>,
  doc: WithId<AssetDoc>,
): Promise<CandidateOutcome> {
  const primary = assetPrimaryFileInfo(doc);
  if (!primary || !isLegacyDaydirPath(primary.path)) {
    // The loose Mongo prefilter matched, but the precise structural gate
    // didn't (or there's no live entry at all) — not a real candidate.
    // Stamp it done so it doesn't keep re-matching the query forever.
    await stampDone(coll, doc._id);
    return 'processed';
  }

  const newDir = computeCorrectedDir(doc, primary.filename);
  if (newDir == null) {
    await stampDone(coll, doc._id);
    log.warn(
      { _id: String(doc._id), maple_id: doc.maple_id, path: primary.path },
      'refile-legacy-daydir: no EXIF and no parseable filename date — stamped, left in place',
    );
    return 'processed';
  }

  const root = libs.get(primary.library_id.toHexString());
  if (!root) {
    // Library unregistered / offline — skip without erroring or stamping;
    // retried next tick once the mount returns. Never delete on an offline
    // mount.
    return 'skipped-no-root';
  }

  return attemptLegacyDaydirMove(coll, doc, primary, root, newDir);
}

export const refileLegacyDaydir: Migration = {
  id: 'refile-legacy-daydir',
  title: 'Refile legacy backup day-dir folders',
  description:
    'One-time cleanup: relocate assets still filed under the old backup ' +
    'day-dir layout (<year>/<location>/<MM>-<DD>, or <year>/<MM>/<DD> with ' +
    'no location) into the year their EXIF — or, when EXIF is missing, ' +
    'their Android IMG_YYYYMMDD_HHMMSS filename — says they actually belong ' +
    'in. Reaches assets refile-backups cannot (no phasset_links) or will ' +
    'not correct (never crosses year folders). Assets with neither EXIF ' +
    'nor a parseable filename date are stamped and left in place for ' +
    'manual review.',

  async countRemaining(): Promise<number> {
    const coll = await assetsCollection();
    return coll.countDocuments(legacyDaydirCandidateFilter());
  },

  async runBatch(batchSize: number): Promise<MigrationBatchResult> {
    const coll = await assetsCollection();
    const libs = await loadLibraryRootsOrEmpty();
    const docs = await fetchLegacyDaydirCandidates(coll, batchSize);

    let processed = 0;
    let errors = 0;
    let skippedNoRoot = 0;
    for (const doc of docs) {
      const outcome = await processLegacyDaydirCandidate(coll, libs, doc);
      if (outcome === 'processed') processed++;
      else if (outcome === 'error') errors++;
      else if (outcome === 'skipped-no-root') skippedNoRoot++;
      // 'retry-later': a concurrent change reverted the attempt — left as-is.
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
