/**
 * External-rename reconciliation (#2655) — the sweeper reconciliation step
 * that keeps a sidecar attached to its RAW when the file is renamed OUTSIDE
 * Maple, in the SAME folder, between two rescans. Without this, the
 * sweeper's per-directory diff (`sweeper.ts`) sees an ordinary
 * removed+created pair: the old location gets `missing_since` (eventually
 * reaped) and the new filename is indexed as a brand-new, unedited asset —
 * silently orphaning the `.xmp` sidecar and every prior edit
 * (`docs/spec/08-io.md` § "Import rules").
 *
 * Match signal is a CHEAP fingerprint — file size + EXIF `DateTimeOriginal`
 * + camera serial — not a full-file checksum (RAWs are large; the sweeper
 * already pays for the EXIF read via `readExif`, so this rides along rather
 * than adding a second full-file pass). A pure rename never touches file
 * bytes, so size stays exact and EXIF is untouched.
 *
 * The false-positive guard is structural, not a bolted-on `if`: candidates
 * on both sides are grouped into buckets keyed by fingerprint
 * (`groupByFingerprint`), and `reconcileRenamesInDirectory` only ever visits
 * a bucket pair through `resolvableBucketPairs` — a helper that yields a
 * pairing *only* when both buckets it draws from have exactly one member.
 * There is no code path that reconciles from an ambiguous bucket; ambiguity
 * is a property of the data structure, not a branch someone could later
 * forget to check. Two distinct photos that happen to share size, capture
 * timestamp, and serial (or lack a serial) are exceedingly unlikely, but a
 * wrong merge would silently attach one photo's edit history to another —
 * so an ambiguous bucket declines outright and falls through to the
 * sweeper's ordinary created/removed handling for every candidate in it.
 */
import { promises as nodeFs } from 'node:fs';
import type { ObjectId } from 'mongodb';
import * as fs from '../../fs/mirrored.ts';
import { xmpSidecarPath } from '../../fs/xmp.ts';
import { readExif } from '../../indexer/exif.ts';
import { assetsCollection } from '../../db/client.ts';
import { recordAndPublishAssetChange } from '../../db/changes.repo.ts';
import { MEILI_REARM_SET } from '../../people/people-search-reindex.ts';
import {
  relocateCacheStageResetSet,
  liveFileinfoMatchFilter,
} from '../../db/relocate-cache-reset.ts';
import { buildFileinfoEntry } from './types.ts';
import { child } from '../../log.ts';
import type { AssetExif, FileInfo } from '../../db/schema.ts';

const log = child('discover:rename-reconcile');

/** An on-disk file, not yet recorded in Mongo, discovered in the same sweep
 * visit as at least one missing candidate — the "new side" of a candidate
 * rename pair. */
export interface NewFileCandidate {
  filename: string;
  absPath: string;
}

/** A previously-recorded `fileinfo` entry confirmed absent from disk this
 * visit — the "missing side" of a candidate rename pair. Carries the
 * doc-level fields the fingerprint and repoint need; the sweeper's `find()`
 * projection supplies these directly, no extra round-trip. */
export interface MissingFileCandidate {
  docId: ObjectId;
  fileinfo: FileInfo;
  filename: string;
  absPath: string;
  size?: number | null;
  exif?: AssetExif | null;
}

export interface ReconcileResult {
  /** Filenames (on the NEW side) the sweeper must NOT emit `created` for. */
  reconciledNewFilenames: Set<string>;
  /** Filenames (on the MISSING side) the sweeper must NOT emit `removed` for. */
  reconciledMissingFilenames: Set<string>;
}

const EMPTY_RESULT: ReconcileResult = {
  reconciledNewFilenames: new Set(),
  reconciledMissingFilenames: new Set(),
};

interface Fingerprint {
  size: number;
  capturedAt: string;
  serial: string | null;
}

/** Deliberately requires a non-null `capturedAt` — "same size, no date" is
 * far too weak a rename signal on its own (two distinct files of the same
 * size are common; two distinct files with the same size AND the same
 * to-the-second EXIF capture timestamp are not). A candidate lacking a
 * capture timestamp simply never enters a fingerprint bucket, so it can
 * never be reconciled — it always falls through to the ordinary
 * created/removed path. */
function fingerprintKey(fp: Fingerprint): string {
  return `${fp.size}|${fp.capturedAt}|${fp.serial ?? ''}`;
}

function missingFingerprint(c: MissingFileCandidate): Fingerprint | null {
  const capturedAt = c.exif?.captured_at ?? null;
  if (capturedAt === null || c.size == null) return null;
  return { size: c.size, capturedAt, serial: c.exif?.camera_serial ?? null };
}

/** Reads just enough of the new file to fingerprint it: a `stat` for size,
 * then — ONLY when that size matches at least one missing candidate's size
 * — a `readExif` pass for the capture timestamp + camera serial (the same
 * header-only read the `exif` stage would perform on this file anyway, not
 * a second full-file pass). Size is the cheap first key of the fingerprint,
 * so a size that matches nothing short-circuits before ever opening the
 * file for EXIF — the common case in any directory with more than a
 * handful of unindexed files, where most sizes won't match any missing
 * candidate at all. Any failure (unreadable/corrupt/mid-copy file,
 * unsupported format) yields `null` — the file simply isn't a
 * reconciliation candidate this visit; the sweeper's normal `created` path
 * (and the exif stage after it) handles it on its own terms. */
async function newFileFingerprint(
  absPath: string,
  candidateSizes: ReadonlySet<number>,
): Promise<Fingerprint | null> {
  let size: number;
  try {
    size = (await nodeFs.stat(absPath)).size;
  } catch {
    return null;
  }
  if (!candidateSizes.has(size)) return null;
  let exif: AssetExif | null;
  try {
    exif = await readExif(absPath);
  } catch {
    return null;
  }
  const capturedAt = exif?.captured_at ?? null;
  if (capturedAt === null) return null;
  return { size, capturedAt, serial: exif?.camera_serial ?? null };
}

function groupByFingerprint<T>(
  items: readonly T[],
  fingerprintOf: (item: T) => Fingerprint | null,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const fp = fingerprintOf(item);
    if (fp === null) continue;
    const key = fingerprintKey(fp);
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

/** The false-positive guard, expressed as a generator rather than a
 * condition to remember at each call site: walks every fingerprint key
 * common to both sides and yields a `(missing, fresh)` pair ONLY when both
 * buckets it draws from hold exactly one candidate. A key with two or more
 * candidates on either side is logged and skipped — every candidate in that
 * bucket falls through to the caller's ordinary created/removed handling. */
function* resolvableBucketPairs(
  missingGroups: ReadonlyMap<string, MissingFileCandidate[]>,
  newGroups: ReadonlyMap<string, NewFileCandidate[]>,
): Generator<{ missing: MissingFileCandidate; fresh: NewFileCandidate }> {
  for (const [key, missingBucket] of missingGroups) {
    const newBucket = newGroups.get(key);
    if (!newBucket) continue;
    if (missingBucket.length === 1 && newBucket.length === 1) {
      yield { missing: missingBucket[0]!, fresh: newBucket[0]! };
      continue;
    }
    log.warn(
      {
        fingerprintKey: key,
        missingCandidates: missingBucket.map((c) => c.filename),
        newCandidates: newBucket.map((c) => c.filename),
      },
      'rename-reconcile: declining — more than one plausible candidate shares this fingerprint',
    );
  }
}

/** Moves the sidecar (if any) from the old RAW's path to the new one.
 * Same-folder only (the sweeper's per-directory diff never sees a
 * cross-folder pair), so a plain atomic `rename` is safe — both paths sit
 * on the same filesystem, no crash-safe copy+verify is needed the way a
 * cross-volume relocate would (`fs/relocate.ts`).
 *
 * Returns `false` only on a genuine move FAILURE (sidecar present but
 * couldn't be relocated). Returns `true` when there was no sidecar to move
 * at all (never edited) or the move succeeded. */
async function moveSidecarIfPresent(oldAbsPath: string, newAbsPath: string): Promise<boolean> {
  const oldSidecar = xmpSidecarPath(oldAbsPath);
  try {
    await fs.stat(oldSidecar);
  } catch {
    return true; // nothing to move
  }
  const newSidecar = xmpSidecarPath(newAbsPath);
  try {
    await fs.rename(oldSidecar, newSidecar);
    return true;
  } catch (err) {
    log.warn(
      { oldSidecar, newSidecar, err: err instanceof Error ? err.message : err },
      'rename-reconcile: sidecar move failed',
    );
    return false;
  }
}

/** Repoints the DB row's matching `fileinfo` entry onto the new path, in
 * place: same `_id`, same `maple_id`, same edits, same stage history except
 * the cache-writing stages (thumb/preview), which reset to v0 so the
 * workers regenerate them at the new location — the established move
 * pattern `library/relocate-asset.ts` uses for an in-app relocate.
 *
 * The OLD entry's `(library_id, path, filename, deleted_at: null)` is part
 * of the top-level QUERY filter, not just the `arrayFilters` — mirroring
 * `library/relocate-asset.ts`'s `repointToNewLocation`. That matters: with
 * the old entry matched only via `arrayFilters`, a concurrent change to
 * that exact fileinfo entry (another repoint, a trash, a dedupe move) makes
 * the array-filtered `$set` clauses silently no-op while `_id` alone still
 * matches — and this update's OTHER top-level field (`indexed_at`, always a
 * fresh timestamp) would still report a real `modifiedCount`, masking the
 * no-op. Folding the old values into the query itself means `matchedCount`
 * only comes back positive when the exact entry we read moments ago is
 * still there to update. */
async function repointFileinfoEntry(
  candidate: MissingFileCandidate,
  newEntry: { path: string; filename: string },
): Promise<boolean> {
  const coll = await assetsCollection();
  const set: Record<string, unknown> = {
    'fileinfo.$[e].path': newEntry.path,
    'fileinfo.$[e].filename': newEntry.filename,
    'fileinfo.$[e].missing_since': null,
    'fileinfo.$[e].missing_reason': null,
    indexed_at: new Date().toISOString(),
    ...MEILI_REARM_SET,
    ...relocateCacheStageResetSet(),
  };
  const res = await coll.updateOne(
    liveFileinfoMatchFilter(candidate.docId, candidate.fileinfo),
    { $set: set } as never,
    {
      arrayFilters: [
        {
          'e.library_id': candidate.fileinfo.library_id,
          'e.path': candidate.fileinfo.path,
          'e.filename': candidate.fileinfo.filename,
        },
      ],
    },
  );
  return res.matchedCount > 0 && res.modifiedCount > 0;
}

/** Reverses `repointFileinfoEntry` exactly: restores the entry (now sitting
 * at `newEntry`) back to `original`'s path/filename/missing markers. Used
 * ONLY when the repoint itself succeeded but the follow-on sidecar move
 * then failed — see `reconcilePair`'s ordering comment for why that
 * specific failure needs an explicit undo rather than being left in place.
 * Best-effort: if even the rollback write fails, the row is left
 * (rare, logged) with a location that has no sidecar of its own on disk —
 * an orphaned-sidecar-shaped failure, not a misattributed-edits one. */
async function rollbackRepoint(
  docId: ObjectId,
  newEntry: { path: string; filename: string },
  original: FileInfo,
): Promise<void> {
  const coll = await assetsCollection();
  try {
    const res = await coll.updateOne(
      {
        _id: docId,
        fileinfo: {
          $elemMatch: {
            library_id: original.library_id,
            path: newEntry.path,
            filename: newEntry.filename,
            deleted_at: null,
          },
        },
      },
      {
        $set: {
          'fileinfo.$[e].path': original.path,
          'fileinfo.$[e].filename': original.filename,
          'fileinfo.$[e].missing_since': original.missing_since ?? null,
          'fileinfo.$[e].missing_reason': original.missing_reason ?? null,
        },
      } as never,
      {
        arrayFilters: [
          {
            'e.library_id': original.library_id,
            'e.path': newEntry.path,
            'e.filename': newEntry.filename,
          },
        ],
      },
    );
    if (res.matchedCount === 0) {
      log.warn(
        { docId: docId.toHexString() },
        'rename-reconcile: rollback found no matching entry — row changed again concurrently',
      );
    }
  } catch (err) {
    log.warn(
      { docId: docId.toHexString(), err: err instanceof Error ? err.message : err },
      'rename-reconcile: rollback after failed sidecar move itself failed — row now points to a location with no sidecar of its own',
    );
  }
}

/** Reconciles one resolved (missing, fresh) pair: repoint the DB row FIRST,
 * then move the sidecar — and roll the repoint back if the sidecar move
 * fails. This ordering is deliberate: the two things that can go wrong are
 * "repoint declines" (someone else already changed this exact fileinfo
 * entry — trivially safe, nothing on disk or in the DB has moved yet) and
 * "sidecar move fails after a successful repoint" (rare FS error — rolled
 * back here so the row and the sidecar's actual location can never
 * disagree). The alternative ordering (move the sidecar first) fails the
 * WRONG way: if the repoint then declined, the sidecar would already sit at
 * the new path while the DB still called the new file "unindexed" — a
 * plain rescan would index it as its own asset and silently inherit a
 * DIFFERENT photo's edit history by path coincidence, the exact
 * misattribution this feature exists to prevent. Repoint-first only ever
 * degrades to a plain orphaned sidecar (the pre-existing, already-tolerated
 * failure mode this feature reduces), never a wrong attachment. */
async function reconcilePair(
  missing: MissingFileCandidate,
  fresh: NewFileCandidate,
  root: string,
  folderId: ObjectId,
): Promise<boolean> {
  const newEntry = buildFileinfoEntry(root, fresh.absPath, folderId);
  if (!newEntry) {
    log.warn(
      { root, absPath: fresh.absPath },
      'rename-reconcile: new path escapes library root — declining',
    );
    return false;
  }

  const repointed = await repointFileinfoEntry(missing, newEntry);
  if (!repointed) {
    log.warn(
      { docId: missing.docId.toHexString() },
      'rename-reconcile: fileinfo entry changed concurrently — declining repoint',
    );
    return false;
  }

  if (!(await moveSidecarIfPresent(missing.absPath, fresh.absPath))) {
    await rollbackRepoint(missing.docId, newEntry, missing.fileinfo);
    log.warn(
      { docId: missing.docId.toHexString() },
      'rename-reconcile: sidecar move failed after repoint — rolled back, declining',
    );
    return false;
  }

  await recordAndPublishAssetChange({
    kind: 'update',
    asset_id: missing.docId,
    folder_id: folderId,
    abs_path: fresh.absPath,
  });
  log.info(
    {
      id: missing.docId.toHexString(),
      from: missing.absPath,
      to: fresh.absPath,
    },
    'rename-reconcile: reconciled external rename',
  );
  return true;
}

/**
 * Attempts to reconcile every plausible external rename in one directory
 * visit. Cheap short-circuit: with no missing candidates, or no unrecorded
 * new files, there is nothing to pair — return immediately without reading
 * a single byte of any new file's EXIF.
 *
 * Called by `sweeper.ts`'s `visitDirectory` BEFORE it emits the ordinary
 * `created`/`removed` events for this visit; every filename returned in the
 * result sets must be excluded from those emissions by the caller.
 */
export async function reconcileRenamesInDirectory(
  newCandidates: readonly NewFileCandidate[],
  missingCandidates: readonly MissingFileCandidate[],
  root: string,
  folderId: ObjectId,
): Promise<ReconcileResult> {
  if (newCandidates.length === 0 || missingCandidates.length === 0) return EMPTY_RESULT;

  const missingGroups = groupByFingerprint(missingCandidates, missingFingerprint);
  if (missingGroups.size === 0) return EMPTY_RESULT;

  // The set of sizes that actually appear in a viable missing-side
  // fingerprint (i.e. the same candidates `missingGroups` was built from) —
  // `newFileFingerprint`'s cheap first filter, computed with zero extra I/O
  // since `missingFingerprint` only reads already-in-memory doc fields.
  const missingSizes = new Set<number>();
  for (const c of missingCandidates) {
    const fp = missingFingerprint(c);
    if (fp) missingSizes.add(fp.size);
  }

  // Sequential, not fan-out: a directory can hold thousands of unindexed
  // files, and each candidate potentially costs a `stat` + a `readExif`
  // pass. This is a background sweep with no latency budget worth an
  // unbounded `Promise.all` — running one file at a time keeps open-FD and
  // memory use O(1) regardless of directory size (`newFileFingerprint`'s
  // size short-circuit above already skips the EXIF read for the common
  // case where nothing in the directory is missing that size).
  const newGroups = new Map<string, NewFileCandidate[]>();
  for (const candidate of newCandidates) {
    const fp = await newFileFingerprint(candidate.absPath, missingSizes);
    if (fp === null) continue;
    const key = fingerprintKey(fp);
    const bucket = newGroups.get(key);
    if (bucket) bucket.push(candidate);
    else newGroups.set(key, [candidate]);
  }

  const reconciledNewFilenames = new Set<string>();
  const reconciledMissingFilenames = new Set<string>();
  for (const { missing, fresh } of resolvableBucketPairs(missingGroups, newGroups)) {
    if (await reconcilePair(missing, fresh, root, folderId)) {
      reconciledMissingFilenames.add(missing.filename);
      reconciledNewFilenames.add(fresh.filename);
    }
  }
  return { reconciledNewFilenames, reconciledMissingFilenames };
}
