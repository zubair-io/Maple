/**
 * Mirror scrub — the deletion complement of the mirror-scan detector.
 *
 * `mirror-scan` answers "what is missing/stale on the mirror?" and copies the
 * primary onto it. It only ever ADDS; it never removes. So a primary file that
 * was moved or deleted leaves its old mirror copy behind as an *orphan* — most
 * visibly after the backup-folder migrations, which relocate originals on the
 * primary while the mirror side of the move was historically lost (the worker
 * tier had no mirror registry loaded — see `worker-main.ts`). This scrub finds
 * those orphans and, when explicitly asked, deletes them.
 *
 * Definition of an orphan: a file present under a mirror root whose corresponding
 * path under the PRIMARY root does not exist. There is no DB lookup — the
 * migration overwrote the old `fileinfo.path`, so the structural mirror-vs-primary
 * diff is the only reliable signal for "this should no longer be here".
 *
 * Safety — this DELETES on the mirror, so it errs hard toward keeping files:
 *   - `apply` defaults to false: a dry run reports orphans and deletes nothing.
 *     The dry-run report IS how an operator learns what would be removed.
 *   - A primary root that is offline/unreadable this pass SKIPS its whole mirror.
 *     Without the primary present every mirror file would look orphaned — this is
 *     the inverse of the scan's offline-MIRROR guard, and it is load-bearing.
 *   - Only a clean ENOENT on the primary marks a file orphaned; any other stat
 *     error skips the file (a transient I/O error must never trigger a delete).
 *   - Temp files (`<x>.tmp.<pid>`) are ignored.
 *   - Uses the REAL fs (never the mirror-aware shim) — we operate ON the mirror;
 *     re-mirroring would recurse.
 *
 * Like scan/replicate this is pure + unit-testable on temp dirs: pass an explicit
 * primary→mirrors `rootMap`; the route passes the live `snapshotMirrorRoots()`.
 */

import type { Dirent } from 'node:fs';
import { readdir, stat, unlink, rmdir } from 'node:fs/promises';
import * as path from 'node:path';
import { snapshotMirrorRoots } from '../../fs/mirror-registry.ts';
import { child as childLogger } from '../../log.ts';

const log = childLogger('mirror-scrub');

const DEFAULT_MAX_DELETE = 100_000; // runaway guard
const SAMPLE_CAP = 50; // example orphan paths returned for the dry-run report

export interface MirrorScrubOptions {
  /** Actually delete orphans. Default false ⇒ dry run (report only). */
  apply?: boolean;
  /** Hard cap on deletions in one pass. */
  maxDelete?: number;
  /** primary root → mirror roots. Defaults to the live registry snapshot. */
  rootMap?: Record<string, string[]>;
}

export interface MirrorScrubSummary {
  /** Mirror roots inspected (primary online AND mirror present). */
  mirrorsScanned: number;
  /** Files walked on the mirror side. */
  filesChecked: number;
  /** Mirror files with no primary counterpart. */
  orphans: number;
  /** Orphans actually unlinked (always 0 on a dry run). */
  deleted: number;
  /** Empty directories pruned after deletion. */
  dirsPruned: number;
  /** Mirror roots skipped because their primary was offline/unreadable. */
  skippedOfflinePrimary: number;
  /** Mirror roots skipped because the mirror itself was offline. */
  skippedOfflineMirror: number;
  /** Per-file stat/unlink errors that were swallowed (never deleted on these). */
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
 * One scrub pass over every configured mirror. Dry run by default — pass
 * `apply: true` to delete the orphans it finds.
 */
export async function runMirrorScrubOnce(
  opts: MirrorScrubOptions = {},
): Promise<MirrorScrubSummary> {
  const apply = opts.apply ?? false;
  const maxDelete = opts.maxDelete ?? DEFAULT_MAX_DELETE;
  const rootMap = opts.rootMap ?? snapshotMirrorRoots();
  const summary: MirrorScrubSummary = {
    mirrorsScanned: 0,
    filesChecked: 0,
    orphans: 0,
    deleted: 0,
    dirsPruned: 0,
    skippedOfflinePrimary: 0,
    skippedOfflineMirror: 0,
    errors: 0,
    samples: [],
  };

  for (const [primaryRoot, mirrorRoots] of Object.entries(rootMap)) {
    // CRITICAL guard: never scrub against a primary that isn't fully present.
    // An unmounted primary would make every mirror file look orphaned and wipe
    // the backup. Anything but a confirmed 'present' aborts this primary.
    if ((await presence(primaryRoot)) !== 'present') {
      summary.skippedOfflinePrimary += mirrorRoots.length;
      log.warn({ primaryRoot }, 'scrub: primary root offline/unreadable — skipping its mirror(s)');
      continue;
    }

    for (const mirrorRoot of mirrorRoots) {
      if ((await presence(mirrorRoot)) !== 'present') {
        summary.skippedOfflineMirror++;
        continue;
      }
      summary.mirrorsScanned++;
      let deletedHere = false;

      for await (const mirrorFile of walkFiles(mirrorRoot)) {
        if (isTemp(mirrorFile)) continue;
        summary.filesChecked++;
        const rel = path.relative(mirrorRoot, mirrorFile);
        const state = await presence(path.join(primaryRoot, rel));
        if (state === 'error') {
          summary.errors++; // ambiguous — leave the mirror file alone
          continue;
        }
        if (state === 'present') continue; // has a primary ⇒ not an orphan
        // state === 'absent' ⇒ orphan
        summary.orphans++;
        if (summary.samples.length < SAMPLE_CAP) summary.samples.push(mirrorFile);
        if (apply && summary.deleted < maxDelete) {
          try {
            await unlink(mirrorFile);
            summary.deleted++;
            deletedHere = true;
          } catch (err) {
            summary.errors++;
            log.warn(
              { mirrorFile, err: err instanceof Error ? err.message : err },
              'scrub: orphan unlink failed',
            );
          }
        }
      }

      if (apply && deletedHere) {
        summary.dirsPruned += await pruneEmptyDirs(mirrorRoot);
      }
    }
  }

  if (summary.mirrorsScanned > 0 || summary.skippedOfflinePrimary > 0) {
    const { samples: _samples, ...rest } = summary;
    log.info({ ...rest, apply }, 'mirror-scrub pass complete');
  }
  return summary;
}
