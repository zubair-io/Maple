/**
 * Mirror scrub — the deletion side of mirror reconcile.
 *
 * `mirror-scan` answers "what is missing/stale on the mirror?" and copies the
 * primary onto it. It only ever ADDS; it never removes. So a primary file that
 * was moved or deleted leaves its old mirror copy behind as an *orphan* — most
 * visibly after the backup-folder migrations, which relocate originals on the
 * primary while the mirror side of the move was historically lost (the worker
 * tier had no mirror registry loaded — see `worker-main.ts`).
 *
 * This module finds those orphans and deletes them. It is consumed two ways:
 *   - `GET /api/mirror/orphans` calls `runMirrorScrubOnce({ apply:false })` for a
 *     read-only dry-run report.
 *   - the `scrub-mirror-orphans` migration calls `findMirrorOrphans` (discovery)
 *     + `deleteOrphanRefs` (batched deletion) so the cleanup is operator-toggled
 *     and progress-tracked in /settings/workers like the other migrations.
 *
 * Definition of an orphan: a file present under a mirror root whose corresponding
 * path under the PRIMARY root does not exist. There is no DB lookup — a
 * relocation overwrote the old `fileinfo.path`, so the structural
 * mirror-vs-primary diff is the only reliable "this should no longer be here".
 *
 * Safety — this DELETES on the mirror, so it errs hard toward keeping files:
 *   - `apply` defaults to false: a dry run reports orphans and deletes nothing.
 *   - A primary root that is offline/unreadable SKIPS its whole mirror, both at
 *     discovery and again immediately before each delete. Without the primary
 *     present every mirror file would look orphaned — this guard is load-bearing.
 *   - Only a clean ENOENT on the primary marks a file orphaned; any other stat
 *     error skips the file (a transient I/O error must never trigger a delete).
 *   - Temp files (`<x>.tmp.<pid>`) are ignored.
 *   - Uses the REAL fs (never the mirror-aware shim) — we operate ON the mirror;
 *     re-mirroring would recurse.
 *
 * Pure + unit-testable on temp dirs: pass an explicit primary→mirrors `rootMap`;
 * production passes the live `snapshotMirrorRoots()`.
 */

import type { Dirent } from 'node:fs';
import { readdir, stat, unlink, rmdir } from 'node:fs/promises';
import * as path from 'node:path';
import { snapshotMirrorRoots } from '../../fs/mirror-registry.ts';
import { child as childLogger } from '../../log.ts';

const log = childLogger('mirror-scrub');

const DEFAULT_MAX_DELETE = 100_000; // runaway guard
const SAMPLE_CAP = 50; // example orphan paths returned for the dry-run report

/** A mirror file with no primary counterpart, with everything needed to
 * re-verify and delete it safely (and to prune its mirror root afterwards). */
export interface OrphanRef {
  mirrorRoot: string;
  mirrorPath: string;
  primaryRoot: string;
  primaryPath: string;
}

/** Result of a discovery walk across every configured mirror. */
export interface OrphanScan {
  orphans: OrphanRef[];
  /** Mirror roots inspected (primary online AND mirror present). */
  mirrorsScanned: number;
  /** Files walked on the mirror side. */
  filesChecked: number;
  /** Mirror roots skipped because their primary was offline/unreadable. */
  skippedOfflinePrimary: number;
  /** Mirror roots skipped because the mirror itself was offline. */
  skippedOfflineMirror: number;
  /** Per-file stat errors that were swallowed (never treated as orphans). */
  errors: number;
}

export interface MirrorScrubOptions {
  /** Actually delete orphans. Default false ⇒ dry run (report only). */
  apply?: boolean;
  /** Hard cap on deletions in one pass. */
  maxDelete?: number;
  /** primary root → mirror roots. Defaults to the live registry snapshot. */
  rootMap?: Record<string, string[]>;
}

export interface MirrorScrubSummary {
  mirrorsScanned: number;
  filesChecked: number;
  orphans: number;
  /** Orphans actually unlinked (always 0 on a dry run). */
  deleted: number;
  dirsPruned: number;
  skippedOfflinePrimary: number;
  skippedOfflineMirror: number;
  errors: number;
  /** Up to {@link SAMPLE_CAP} example orphan mirror paths, for the report. */
  samples: string[];
}

function isTemp(p: string): boolean {
  return path.basename(p).includes('.tmp.');
}

/** stat → 'present' | 'absent' (clean ENOENT) | 'error' (anything else). */
async function presence(p: string): Promise<'present' | 'absent' | 'error'> {
  try {
    await stat(p);
    return 'present';
  } catch (err) {
    if ((err as { code?: string } | null)?.code === 'ENOENT') return 'absent';
    return 'error';
  }
}

/** Recursively yield absolute regular-file paths under `dir`. Symlinks and other
 * special entries are ignored — we never created them and must not delete them. */
async function* walkFiles(dir: string): AsyncGenerator<string> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walkFiles(full);
    } else if (e.isFile()) {
      yield full;
    }
  }
}

/** Remove now-empty directories under (never including) `root`, bottom-up.
 * Returns how many directories were removed. */
async function pruneEmptyDirs(root: string): Promise<number> {
  let pruned = 0;
  // Returns true when `dir` is empty after recursing into (and possibly
  // removing) its sub-directories.
  const recurse = async (dir: string): Promise<boolean> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    let remaining = entries.length;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const child = path.join(dir, e.name);
      if (await recurse(child)) {
        try {
          await rmdir(child);
          pruned++;
          remaining--;
        } catch {
          /* not empty / race — leave it */
        }
      }
    }
    return remaining === 0;
  };
  await recurse(root);
  return pruned;
}

/**
 * Walk every configured mirror and return the files with no primary counterpart.
 * Pure discovery — deletes nothing. A mirror whose primary root is offline is
 * skipped wholesale (never reported as orphaned).
 */
export async function findMirrorOrphans(
  rootMap: Record<string, string[]> = snapshotMirrorRoots(),
): Promise<OrphanScan> {
  const scan: OrphanScan = {
    orphans: [],
    mirrorsScanned: 0,
    filesChecked: 0,
    skippedOfflinePrimary: 0,
    skippedOfflineMirror: 0,
    errors: 0,
  };

  for (const [primaryRoot, mirrorRoots] of Object.entries(rootMap)) {
    // CRITICAL guard: never diff against a primary that isn't fully present.
    // An unmounted primary would make every mirror file look orphaned.
    if ((await presence(primaryRoot)) !== 'present') {
      scan.skippedOfflinePrimary += mirrorRoots.length;
      log.warn({ primaryRoot }, 'scrub: primary root offline/unreadable — skipping its mirror(s)');
      continue;
    }

    for (const mirrorRoot of mirrorRoots) {
      if ((await presence(mirrorRoot)) !== 'present') {
        scan.skippedOfflineMirror++;
        continue;
      }
      scan.mirrorsScanned++;

      for await (const mirrorPath of walkFiles(mirrorRoot)) {
        if (isTemp(mirrorPath)) continue;
        scan.filesChecked++;
        const rel = path.relative(mirrorRoot, mirrorPath);
        const primaryPath = path.join(primaryRoot, rel);
        const state = await presence(primaryPath);
        if (state === 'error') {
          scan.errors++; // ambiguous — never an orphan
          continue;
        }
        if (state === 'present') continue; // has a primary ⇒ not an orphan
        scan.orphans.push({ mirrorRoot, mirrorPath, primaryRoot, primaryPath });
      }
    }
  }

  return scan;
}

/**
 * Delete the given orphan refs, re-verifying each immediately before unlinking
 * (the primary root must still be online and the primary file still absent), then
 * prune any directories emptied on the affected mirror roots. Re-verification
 * makes this safe to run on a list discovered earlier (the migration batches over
 * a snapshot): a file that reappeared on the primary, or a primary that went
 * offline since discovery, is left untouched.
 */
export async function deleteOrphanRefs(
  refs: OrphanRef[],
  opts: { maxDelete?: number } = {},
): Promise<{ deleted: number; errors: number; dirsPruned: number; notOrphan: number }> {
  const maxDelete = opts.maxDelete ?? DEFAULT_MAX_DELETE;
  let deleted = 0;
  let errors = 0;
  let notOrphan = 0;
  const touchedRoots = new Set<string>();

  for (const r of refs) {
    if (deleted >= maxDelete) break;
    if ((await presence(r.primaryRoot)) !== 'present') continue; // primary offline now — leave it
    const prim = await presence(r.primaryPath);
    if (prim === 'present') {
      notOrphan++; // reappeared on the primary since discovery — not an orphan
      continue;
    }
    if (prim === 'error') {
      errors++;
      continue;
    }
    // primary absent ⇒ still an orphan
    try {
      await unlink(r.mirrorPath);
      deleted++;
      touchedRoots.add(r.mirrorRoot);
    } catch (err) {
      if ((err as { code?: string } | null)?.code === 'ENOENT') {
        deleted++; // already gone from the mirror — treat as resolved
        touchedRoots.add(r.mirrorRoot);
      } else {
        errors++;
        log.warn(
          { mirrorPath: r.mirrorPath, err: err instanceof Error ? err.message : err },
          'scrub: orphan unlink failed',
        );
      }
    }
  }

  let dirsPruned = 0;
  for (const root of touchedRoots) dirsPruned += await pruneEmptyDirs(root);
  return { deleted, errors, dirsPruned, notOrphan };
}

/**
 * One scrub pass over every configured mirror. Dry run by default — pass
 * `apply: true` to delete the orphans it finds. Backs `GET /api/mirror/orphans`.
 */
export async function runMirrorScrubOnce(
  opts: MirrorScrubOptions = {},
): Promise<MirrorScrubSummary> {
  const apply = opts.apply ?? false;
  const rootMap = opts.rootMap ?? snapshotMirrorRoots();
  const scan = await findMirrorOrphans(rootMap);

  const summary: MirrorScrubSummary = {
    mirrorsScanned: scan.mirrorsScanned,
    filesChecked: scan.filesChecked,
    orphans: scan.orphans.length,
    deleted: 0,
    dirsPruned: 0,
    skippedOfflinePrimary: scan.skippedOfflinePrimary,
    skippedOfflineMirror: scan.skippedOfflineMirror,
    errors: scan.errors,
    samples: scan.orphans.slice(0, SAMPLE_CAP).map((o) => o.mirrorPath),
  };

  if (apply && scan.orphans.length > 0) {
    const res = await deleteOrphanRefs(scan.orphans, { maxDelete: opts.maxDelete });
    summary.deleted = res.deleted;
    summary.dirsPruned = res.dirsPruned;
    summary.errors += res.errors;
  }

  if (summary.mirrorsScanned > 0 || summary.skippedOfflinePrimary > 0) {
    const { samples: _samples, ...rest } = summary;
    log.info({ ...rest, apply }, 'mirror-scrub pass complete');
  }
  return summary;
}
