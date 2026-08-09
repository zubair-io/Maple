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
import { buildFileinfoEntry } from './types.ts';
import { child } from '../../log.ts';
import type { AssetExif, FileInfo } from '../../db/schema.ts';

const log = child('discover:rename-reconcile');

/** Cache-writing stages reset to v0 after a reconciled rename, mirroring
 * `library/relocate-asset.ts`'s `CACHE_STAGES` — the thumb/preview cache
 * keys are path-derived, so the workers must regenerate them at the new
 * location rather than the (now stale) old one. Never physically relocate
 * the cache files themselves (`docs/caching.md`). */
const CACHE_STAGES = ['thumb', 'preview'] as const;

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

/** Reads just enough of the new file to fingerprint it: a `stat` for size
 * and a `readExif` pass for the capture timestamp + camera serial — the
 * same header-only read the `exif` stage would perform on this file anyway,
 * not a second full-file pass. Any failure (unreadable/corrupt/mid-copy
 * file, unsupported format) yields `null` — the file simply isn't a
 * reconciliation candidate this visit; the sweeper's normal `created` path
 * (and the exif stage after it) handles it on its own terms. */
async function newFileFingerprint(absPath: string): Promise<Fingerprint | null> {
  let size: number;
  try {
    size = (await nodeFs.stat(absPath)).size;
  } catch {
    return null;
  }
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
 * couldn't be relocated) — the caller must decline the whole reconcile
 * rather than repoint the DB out from under a sidecar that stayed behind at
 * the old path, which would reproduce the exact orphaning this feature
 * exists to prevent. Returns `true` when there was no sidecar to move at
 * all (never edited) or the move succeeded. */
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
      'rename-reconcile: sidecar move failed — declining to repoint',
    );
    return false;
  }
}

/** Repoints the DB row's matching `fileinfo` entry onto the new path, in
 * place: same `_id`, same `maple_id`, same edits, same stage history except
 * the cache-writing stages (thumb/preview), which reset to v0 so the
 * workers regenerate them at the new location — the established move
 * pattern `library/relocate-asset.ts` uses for an in-app relocate. */
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
  };
  for (const stage of CACHE_STAGES) {
    set[`stages.${stage}.version`] = 0;
    set[`stages.${stage}.attempts`] = 0;
    set[`stages.${stage}.last_error`] = null;
    set[`stages.${stage}.dead`] = false;
  }
  const res = await coll.updateOne({ _id: candidate.docId }, { $set: set } as never, {
    arrayFilters: [
      {
        'e.library_id': candidate.fileinfo.library_id,
        'e.path': candidate.fileinfo.path,
        'e.filename': candidate.fileinfo.filename,
      },
    ],
  });
  return res.matchedCount > 0;
}

/** Reconciles one resolved (missing, fresh) pair: move the sidecar, then
 * repoint the DB row. Declines (returns `false`, no DB write) if the
 * sidecar move fails — see `moveSidecarIfPresent`. */
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

  if (!(await moveSidecarIfPresent(missing.absPath, fresh.absPath))) return false;

  const repointed = await repointFileinfoEntry(missing, newEntry);
  if (!repointed) {
    log.warn(
      { docId: missing.docId.toHexString() },
      'rename-reconcile: fileinfo entry changed concurrently — declining repoint',
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

  // Only bother reading a new file's EXIF when at least one missing candidate
  // could conceivably pair with it — `missingGroups.size === 0` already
  // short-circuited above, so every remaining new file gets one read.
  const withFingerprints = await Promise.all(
    newCandidates.map(async (candidate) => ({
      candidate,
      fp: await newFileFingerprint(candidate.absPath),
    })),
  );
  const newGroups = new Map<string, NewFileCandidate[]>();
  for (const { candidate, fp } of withFingerprints) {
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
