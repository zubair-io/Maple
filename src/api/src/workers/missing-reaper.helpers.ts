/**
 * Stateless helpers for the missing-reaper — filesystem classification, the
 * per-`fileinfo` liveness predicates, the dead-stage re-arm builder, and the
 * pass-summary shape. Extracted from `missing-reaper.ts` to keep that file
 * under the size budget; everything here is pure (no Mongo, no module state).
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { FileInfo } from '../db/schema.ts';

export interface MissingReaperSummary {
  /** Rows with a tagged entry examined this pass. */
  scanned: number;
  /** Records hard-deleted (every location confirmed gone). */
  reaped: number;
  /** Surviving rows reconciled this pass (an entry recovered and/or a gone
   * sibling pruned). */
  recovered: number;
  /** fileinfo entries pruned ($pull) across all surviving rows this pass. */
  prunedEntries: number;
  /** Rows skipped because a library was offline / unregistered / unreadable. */
  skippedMountOffline: number;
  /** Rows whose only gone location had a case/Unicode near-match on disk —
   * left untouched for human inspection, never deleted. */
  skippedNameMismatch: number;
  /** All-gone rows left because no tagged entry has aged past the prune window
   * yet. */
  skippedCooldown: number;
  /** All-gone, aged-out rows left because deletes are paused (recovery still
   * runs while paused — only the irreversible record delete is suspended). */
  skippedPaused: number;
  /** True when the circuit breaker tripped and the pass aborted without
   * executing any record deletes (a systemic mis-detection guard). */
  aborted: boolean;
  /** Rows that raised an unexpected error during the pass. */
  errors: number;
}

/**
 * Stages that read the ORIGINAL file (StageConfig.tagsMissingOnEnoent). When a
 * surviving row keeps a live location, any of these still flagged `dead` are
 * re-queued (version 0, dead cleared) so they reprocess. Kept in sync with the
 * tagsMissingOnEnoent stages.
 */
export const ORIGINAL_FILE_STAGES = ['exif', 'thumb', 'preview'] as const;

/** Circuit breaker: abort a pass without deleting if it would hard-delete more
 * than BREAKER_MIN rows AND more than BREAKER_FRACTION of those scanned. Bounds
 * the blast radius of a systemic mis-detection (e.g. a root that stats present
 * but whose children all ENOENT). */
export const BREAKER_MIN = 25;
export const BREAKER_FRACTION = 0.5;

/** Entries flagged `missing_since` (an ISO string while tagged). These are the
 * locations the reaper reconciles; everything else on the row is left alone. */
export function missingFileInfos(fileinfo: FileInfo[] | undefined): FileInfo[] {
  return (fileinfo ?? []).filter((f) => typeof f.missing_since === 'string');
}

/** True when the asset still has at least one live location (an entry with
 * neither `deleted_at` nor `missing_since`). A row with a live entry can never
 * be reaped — it is visible and processable. */
export function hasLiveEntry(fileinfo: FileInfo[] | undefined): boolean {
  return (fileinfo ?? []).some((f) => !f.deleted_at && !f.missing_since);
}

export function sameEntry(a: FileInfo, b: FileInfo): boolean {
  return a.library_id.equals(b.library_id) && a.path === b.path && a.filename === b.filename;
}

/** Re-arm any dead original-file stage so it reprocesses once the row is no
 * longer parked. Drains the legacy `dead` backlog from before tag-only
 * suppression; new rows never dead-letter on a missing original. */
export function reArmDeadStages(doc: {
  stages?: Record<string, { dead?: boolean }>;
}): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  for (const name of ORIGINAL_FILE_STAGES) {
    if (doc.stages?.[name]?.dead === true) {
      set[`stages.${name}.version`] = 0;
      set[`stages.${name}.attempts`] = 0;
      set[`stages.${name}.last_error`] = null;
      set[`stages.${name}.dead`] = false;
    }
  }
  return set;
}

export type StatKind = 'present' | 'absent' | 'error';

/** Classify a path: present, absent (ENOENT), or an error we must not treat
 * as "deleted" (EACCES, EIO, an unmounted share that errors rather than
 * ENOENTs, …). Errors are conservative — the caller skips, never deletes. */
export async function statKind(p: string): Promise<StatKind> {
  try {
    await fs.stat(p);
    return 'present';
  } catch (err) {
    return (err as { code?: string } | null)?.code === 'ENOENT' ? 'absent' : 'error';
  }
}

/**
 * True when a library root is AVAILABLE as evidence for missing-file
 * decisions: it can be listed and contains at least one entry (#2171).
 *
 * `statKind(root) === 'present'` is NOT enough — an unmounted bind/network
 * mount is typically a present-but-EMPTY directory, under which every child
 * path ENOENTs. A real Maple library root always has content (year folders,
 * `.maple/` cache), so "listable and non-empty" separates the two. Callers
 * must refuse to treat ENOENT-on-child as "file deleted" when this returns
 * false; the deliberate trade-off is that a library whose LAST file was
 * removed can no longer have its rows reconciled automatically — safe by
 * design, an operator can delete records explicitly.
 */
export async function libraryRootAvailable(root: string): Promise<boolean> {
  try {
    const dir = await fs.opendir(root);
    try {
      // O(1): read a single entry instead of listing the whole root.
      return (await dir.read()) !== null;
    } finally {
      try {
        // Bun's Dir.close() returns undefined rather than a Promise, so no
        // `.catch()` chaining — `await undefined` is a no-op there, and the
        // try/catch absorbs Node's ERR_DIR_CLOSED double-close.
        await dir.close();
      } catch {
        /* best-effort close */
      }
    }
  } catch {
    return false;
  }
}

export type NearMatch =
  /** A case/NFC near-match of the basename exists in the parent dir — the file
   * is on disk under a different name (stored-path bug, NOT a deletion). */
  | 'match'
  /** Parent listed cleanly with no near-match — genuinely absent. */
  | 'clear'
  /** Parent couldn't be listed (EACCES/EIO/…) — we can't prove absence, so the
   * caller must NOT delete this pass. */
  | 'unreadable';

/** Classify whether `absPath` (already known ENOENT) has a near-match sibling.
 * Used only to gate the irreversible hard-delete. Only an ENOENT parent counts
 * as genuinely gone; any other readdir error returns `unreadable` so a row is
 * never deleted on the strength of a directory we couldn't read. */
export async function nearMatchOnDisk(absPath: string): Promise<NearMatch> {
  const dir = path.dirname(absPath);
  const target = path.basename(absPath).normalize('NFC').toLowerCase();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    return (err as { code?: string } | null)?.code === 'ENOENT' ? 'clear' : 'unreadable';
  }
  return entries.some((e) => e.normalize('NFC').toLowerCase() === target) ? 'match' : 'clear';
}
