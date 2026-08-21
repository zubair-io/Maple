/**
 * Pure helpers for the DeDuplicate worker — duplicate-location classification,
 * the keeper-selection ranking, and the pass-summary shape. No Mongo, no fs, no
 * module state (mirrors `missing-reaper.helpers.ts`). Lifted out of `dedupe.ts`
 * to keep that file under the size budget.
 *
 * The keeper ranking encodes the operator's spec for "which copy to move":
 *   1. a copy in a folder whose path contains "unsorted"
 *   2. a copy in a folder named "Misc" (any case)
 *   3. a copy whose filename is a numbered copy — `name.<number>.ext`
 *   4. a copy whose directory path is all numbers
 *   5. otherwise keep the LAST copy in the fileinfo list
 * (1) is the strongest move signal, then (2), (3), (4); (5) is the tiebreaker.
 *
 * This ranking only applies when NO copy is pinned by a `.keep` marker file. A
 * `.keep` file in a folder protects every copy living there: the worker keeps
 * all pinned copies and collapses only the un-pinned ones (see `processAsset`).
 */

import type { FileInfo } from '../db/schema.ts';

export interface DeDuplicateSummary {
  /** Assets with >1 fileinfo entry examined this pass. */
  scanned: number;
  /** Assets that had ≥2 live duplicate locations and were collapsed to one. */
  deduped: number;
  /** Duplicate files relocated into `_duplicates/` across all assets. */
  movedFiles: number;
  /** Assets skipped because a library was offline / unregistered, or a copy
   * couldn't be stat'd (EACCES/EIO) — the full picture couldn't be verified. */
  skippedOffline: number;
  /** Assets skipped because fewer than two copies are actually on disk right
   * now (a stale entry from an unreconciled move) — left for the discover /
   * missing-reaper path. Guards against relocating the last real file. */
  skippedMissingFile: number;
  /** Assets left untouched because EVERY on-disk copy sits in a `.keep`-marked
   * folder, so there is nothing un-pinned to collapse. */
  skippedAllKept: number;
  /** Assets that WOULD have been deduped but were left untouched (`dry_run`). */
  dryRun: number;
  /** Assets that raised an unexpected error during the pass. */
  errors: number;
}

export function emptySummary(): DeDuplicateSummary {
  return {
    scanned: 0,
    deduped: 0,
    movedFiles: 0,
    skippedOffline: 0,
    skippedMissingFile: 0,
    skippedAllKept: 0,
    dryRun: 0,
    errors: 0,
  };
}

/** A `(library_id, path)` directory key. Two entries with the same key live in
 * the same on-disk folder — and therefore share one `maple_id`-keyed thumb /
 * preview cache, so that cache must not be cleaned while either survives. */
export function folderKey(entry: Pick<FileInfo, 'library_id' | 'path'>): string {
  return `${entry.library_id.toHexString()}/${entry.path}`;
}

/** Identity of a fileinfo location within an asset. */
export function sameEntry(a: FileInfo, b: FileInfo): boolean {
  return a.library_id.equals(b.library_id) && a.path === b.path && a.filename === b.filename;
}

/** Rule 1: any directory segment of the POSIX path contains "unsorted"
 * (case-insensitive). A substring match catches `Unsorted`, `_unsorted_`,
 * `to-sort-unsorted`, etc. */
export function isUnsortedPath(p: string): boolean {
  return p.toLowerCase().includes('unsorted');
}

/** Rule 2: some directory segment of the POSIX path IS "misc"
 * (case-insensitive). Segment equality, not a substring match — a
 * `Miscellaneous`-style name is not flagged, only a folder literally named
 * `misc` / `Misc` / `MISC`. */
export function isMiscPath(p: string): boolean {
  return p.split('/').some((seg) => seg.toLowerCase() === 'misc');
}

/** Rule 3: filename is a numbered copy — a `.<digits>.<ext>` tail, e.g.
 * `IMG_001.2.dng`. A plain `IMG_001.dng` does NOT match. */
export function isNumberedCopy(filename: string): boolean {
  return /\.\d+\.[^.]+$/.test(filename);
}

/** Rule 4: the directory path is non-empty and every segment is all-digits,
 * e.g. `2024/01/05` or `12345`. Root (`""`) does not count. */
export function isAllNumericPath(p: string): boolean {
  if (p === '') return false;
  return p.split('/').every((seg) => seg.length > 0 && /^\d+$/.test(seg));
}

/**
 * "Removal score" for one duplicate location — higher means more disposable.
 * Weighted so a single higher-priority match outranks any combination of
 * lower-priority ones (8 > 4 + 2 + 1, 4 > 2 + 1): unsorted (+8) ≫ misc folder
 * (+4) ≫ numbered copy (+2) > all-numeric path (+1).
 */
export function removalScore(entry: Pick<FileInfo, 'path' | 'filename'>): number {
  let score = 0;
  if (isUnsortedPath(entry.path)) score += 8;
  if (isMiscPath(entry.path)) score += 4;
  if (isNumberedCopy(entry.filename)) score += 2;
  if (isAllNumericPath(entry.path)) score += 1;
  return score;
}

/**
 * Choose the single live entry to KEEP from a set of ≥2 byte-identical
 * duplicates. Keeps the LEAST disposable (lowest `removalScore`); on a tie the
 * LATER entry wins, implementing rule 5 "keep the last on list".
 * `liveEntries` must be in original `fileinfo` array order.
 */
export function selectKeeper(liveEntries: FileInfo[]): FileInfo {
  let keeper = liveEntries[0]!;
  let keeperScore = removalScore(keeper);
  for (let i = 1; i < liveEntries.length; i++) {
    const candidate = liveEntries[i]!;
    const score = removalScore(candidate);
    // `<=`, not `<`: on a tie the higher index replaces the keeper, so the LAST
    // minimal-score entry is kept.
    if (score <= keeperScore) {
      keeper = candidate;
      keeperScore = score;
    }
  }
  return keeper;
}

/** Pipeline stages whose output is keyed to the primary location's folder.
 * When the cache anchor moves to the kept copy they must regenerate there. */
export const CACHE_STAGES = ['thumb', 'preview'] as const;

/** `$set` that re-queues the location-keyed cache stages (version → 0) so the
 * kept copy regenerates its thumb + preview at the new primary folder. */
export function reArmCacheStages(): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  for (const name of CACHE_STAGES) {
    set[`stages.${name}.version`] = 0;
    set[`stages.${name}.attempts`] = 0;
    set[`stages.${name}.last_error`] = null;
    set[`stages.${name}.processed_at`] = null;
    set[`stages.${name}.dead`] = false;
  }
  return set;
}
