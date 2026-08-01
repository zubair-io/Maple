/**
 * Filesystem half of the backup folder-layout move (originally #744).
 *
 * Pure FS — no Mongo. Split from the orchestration (the `refile-backups` migration)
 * so the crash-safe ordering and collision branches are unit-testable against a
 * temp dir, and so the DB write can sit BETWEEN the two halves:
 *
 *   1. `planAndPlace()` — copy the file + companions into the new dir and
 *      VERIFY each (full byte comparison). Sources are NOT deleted. Returns the
 *      new rel-paths plus the list of source files to delete once the DB has
 *      been repointed.
 *   2. <caller writes the new fileinfo / apple_rendered_path to Mongo>
 *   3. `finalize()` — delete the sources, drop the stale `.maple` cache entries,
 *      and remove the now-empty old day-folder.
 *
 * Crash between (1) and (2): the new copy is a harmless orphan, the row still
 * points at the (still-present) old file. Crash between (2) and (3): the row
 * points at the good new file; the old source + cache linger as orphans. Either
 * way no photo is lost. Deleting before the DB repoint is the one ordering that
 * could strand a row on a deleted path — so we never do it.
 */

// Mirror-aware drop-in: backup-layout relocations (copy/unlink/rmdir of
// originals + sidecars) replicate to the library's backup root(s).
import * as fs from '../../fs/mirrored.ts';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import { filesIdentical } from '../../backup/fs-util.ts';
import { pickFreePath } from '../../fs/trash.ts';
import { sha256Prefix16 } from '../../fs/xmp.ts';
import { listPairedSidecars } from '../../fs/xmp-conflict.ts';
import { child as childLogger } from '../../log.ts';

const log = childLogger('migration:restructure-fs');

/** Thrown when the source original is gone from disk — the caller skips the
 * asset (nothing to move) rather than counting a hard error. */
export class SourceMissingError extends Error {}

export type PlaceOutcome = 'copied' | 'deduped' | 'renamed';

export interface PlacePlan {
  outcome: PlaceOutcome;
  /** POSIX rel-path (under libRoot) of the primary at its new home. */
  newRelPath: string;
  /** POSIX rel-path of the moved rendered companion, or unchanged/null. */
  newRenderedRel: string | null;
  /** Absolute source paths to unlink once the DB has been repointed. */
  sourcesToDelete: string[];
  /** Absolute paths of the NEW copies this call created (primary + companions).
   * Empty for a dedupe (no copy made). Used to revert cleanly if the DB repoint
   * turns out to be a no-op (concurrent change) — we delete these instead of the
   * source, leaving the row + original untouched. */
  createdPaths: string[];
  /** The old day-folder (absolute), for emptiness cleanup in `finalize`. */
  oldDirAbs: string;
}

function joinRel(libRoot: string, posixRel: string): string {
  return path.join(libRoot, ...posixRel.split('/'));
}

function toPosixRel(libRoot: string, abs: string): string {
  return path.relative(libRoot, abs).split(path.sep).join('/');
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Delete the new copies `planAndPlace` created — used to roll back when the DB
 * repoint turns out to be a no-op (a concurrent change moved the fileinfo entry
 * between our read and write), so the original + row are left untouched and we
 * don't strand an orphan at the new path. Best-effort. */
export async function revertCreated(createdPaths: string[]): Promise<void> {
  for (const p of createdPaths) {
    await fs.unlink(p).catch((err) => {
      log.warn({ p, err: err instanceof Error ? err.message : err }, 'revert unlink failed');
    });
  }
}

/** Copy `src` → `dst` and verify byte-identical. On a verify failure the bad
 * partial copy is removed and the error propagates (source is left intact). */
async function copyVerified(src: string, dst: string): Promise<void> {
  await fs.copyFile(src, dst);
  if (!(await filesIdentical(src, dst))) {
    await fs.unlink(dst).catch(() => {});
    throw new Error(`copy verification failed: ${src} → ${dst}`);
  }
}

/**
 * Copy the primary + companions from the old day-folder into `newDir`,
 * verifying each. Handles collisions at the target:
 *   - byte-identical occupant AND the source has no companions → DEDUPE: don't
 *     copy, just hand back the source for deletion (the row repoints to the
 *     occupant). Edits-safety: a source WITH sidecars/rendered is never
 *     deduped — it falls through to rename so distinct edits can't be dropped.
 *   - otherwise → RENAME: place at the next free `.N` sibling. Never overwrites.
 */
export async function planAndPlace(args: {
  libRoot: string;
  oldDir: string; // POSIX
  filename: string;
  newDir: string; // POSIX
  renderedRelOld: string | null;
}): Promise<PlacePlan> {
  const { libRoot, oldDir, filename, newDir, renderedRelOld } = args;
  const oldAbs = joinRel(libRoot, `${oldDir}/${filename}`);
  if (!(await exists(oldAbs))) {
    throw new SourceMissingError(`source original missing: ${oldAbs}`);
  }
  const oldDirAbs = joinRel(libRoot, oldDir);
  const sidecars = await listPairedSidecars(oldAbs);
  const renderedAbsOld = renderedRelOld ? joinRel(libRoot, renderedRelOld) : null;
  const renderedPresent = renderedAbsOld !== null && (await exists(renderedAbsOld));
  const hasCompanions = sidecars.length > 0 || renderedPresent;

  const newTargetAbs = joinRel(libRoot, `${newDir}/${filename}`);

  // ── Collision handling ────────────────────────────────────────────────────
  let targetAbs = newTargetAbs;
  let outcome: PlaceOutcome = 'copied';
  if (await exists(newTargetAbs)) {
    const identical = await filesIdentical(oldAbs, newTargetAbs);
    if (identical && !hasCompanions) {
      // Pure-original duplicate → dedupe. Repoint to the occupant; the source
      // original is redundant and gets deleted after the DB commit.
      log.info(
        { oldAbs, survivor: newTargetAbs },
        'restructure: byte-identical duplicate — deduping (repoint + delete source)',
      );
      return {
        outcome: 'deduped',
        newRelPath: `${newDir}/${filename}`,
        newRenderedRel: renderedRelOld, // no rendered move on a dedupe of a bare original
        sourcesToDelete: [oldAbs],
        createdPaths: [], // no copy made — nothing to revert
        oldDirAbs,
      };
    }
    // Different bytes, or a duplicate that carries companions we must not drop:
    // claim the next free sibling. Never overwrite the occupant.
    targetAbs = await pickFreePath(newTargetAbs, 'migration:primary');
    outcome = 'renamed';
  }

  // ── Copy + verify primary ───────────────────────────────────────────────
  await fs.mkdir(path.dirname(targetAbs), { recursive: true });
  await copyVerified(oldAbs, targetAbs);

  const oldBase = path.basename(oldAbs, path.extname(oldAbs));
  const newBase = path.basename(targetAbs, path.extname(targetAbs));
  const sourcesToDelete: string[] = [oldAbs];
  const createdPaths: string[] = [targetAbs];

  // ── Copy + verify sidecars (canonical + conflict copies) ─────────────────
  for (const sidecar of sidecars) {
    const name = path.basename(sidecar);
    if (!name.startsWith(oldBase)) continue; // defensive — listPairedSidecars guarantees this
    const renamed = newBase + name.slice(oldBase.length);
    const dst = await pickFreePath(
      path.join(path.dirname(targetAbs), renamed),
      'migration:sidecar',
    );
    await copyVerified(sidecar, dst);
    sourcesToDelete.push(sidecar);
    createdPaths.push(dst);
  }

  // ── Copy + verify the apple_rendered_path companion ──────────────────────
  let newRenderedRel: string | null = renderedRelOld;
  if (renderedPresent && renderedAbsOld) {
    const rName = path.basename(renderedAbsOld);
    const renamed = rName.startsWith(oldBase) ? newBase + rName.slice(oldBase.length) : rName;
    const dst = await pickFreePath(
      path.join(path.dirname(targetAbs), renamed),
      'migration:rendered',
    );
    await copyVerified(renderedAbsOld, dst);
    newRenderedRel = toPosixRel(libRoot, dst);
    sourcesToDelete.push(renderedAbsOld);
    createdPaths.push(dst);
  }

  return {
    outcome,
    newRelPath: toPosixRel(libRoot, targetAbs),
    newRenderedRel,
    sourcesToDelete,
    createdPaths,
    oldDirAbs,
  };
}

/** Drop this asset's stale `.maple` cache entries under the old day-folder so
 * the folder can be reclaimed and the workers regenerate at the new path.
 *
 * Covers BOTH cache-keying schemes so reclamation is robust regardless of which
 * one produced the files:
 *   - path-keyed (current): `thumbs/<sha256Prefix16(filename)>.avif`,
 *     `previews/<basename_no_ext>_<size>.jpg`
 *   - retired content-addressed: `thumbs/<maple_id>.avif`,
 *     `previews/<maple_id>_<size>.jpg`
 * Thumbs also drops the `.jpg` form of each — the thumb stage's v3 format
 * migration means either extension can be sitting at the old path depending
 * on when it was last rendered. Best-effort — a cache that won't unlink is
 * logged, not fatal. */
async function dropOldCache(
  oldDirAbs: string,
  mapleId: string | undefined,
  filename: string,
): Promise<void> {
  const thumbsDir = path.join(oldDirAbs, '.maple', 'thumbs');
  const previewsDir = path.join(oldDirAbs, '.maple', 'previews');

  // Thumbs: maple_id-keyed + legacy basename-hash-keyed, both extensions
  // (AVIF is current; JPEG is the pre-v3 legacy format).
  for (const ext of ['avif', 'jpg']) {
    if (mapleId) await fs.unlink(path.join(thumbsDir, `${mapleId}.${ext}`)).catch(() => {});
    await fs.unlink(path.join(thumbsDir, `${sha256Prefix16(filename)}.${ext}`)).catch(() => {});
  }

  // Previews: variable size keys → enumerate. Match both `<maple_id>_*.jpg`
  // (current) and `<basename_no_ext>_*.jpg` (legacy).
  const baseNoExt = filename.slice(0, filename.length - path.extname(filename).length);
  try {
    for (const name of await fs.readdir(previewsDir)) {
      if (!name.endsWith('.jpg')) continue;
      const isMapleId = mapleId && name.startsWith(`${mapleId}_`);
      const isLegacy = baseNoExt.length > 0 && name.startsWith(`${baseNoExt}_`);
      if (isMapleId || isLegacy) {
        await fs.unlink(path.join(previewsDir, name)).catch(() => {});
      }
    }
  } catch {
    /* no previews dir — nothing to drop */
  }
}

/** Remove the old day-folder iff it is genuinely empty, treating a now-empty
 * `.maple` subtree (whose entries we just cleared) as removable. Guarded to
 * never touch anything at or above the library root. */
async function removeOldDirIfEmpty(oldDirAbs: string, libRoot: string): Promise<void> {
  const rel = path.relative(libRoot, oldDirAbs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return; // never at/above root
  let entries: string[];
  try {
    entries = await fs.readdir(oldDirAbs);
  } catch {
    return; // already gone
  }
  if (entries.length === 0) {
    await fs.rmdir(oldDirAbs).catch(() => {});
    return;
  }
  // The only acceptable leftover is a `.maple` cache subtree with no regular
  // files (every cached artefact for this folder's photos already dropped).
  if (entries.length === 1 && entries[0] === '.maple') {
    const mapleDir = path.join(oldDirAbs, '.maple');
    if (await dirHasNoFiles(mapleDir)) {
      await fs.rm(mapleDir, { recursive: true, force: true }).catch(() => {});
      await fs.rmdir(oldDirAbs).catch(() => {});
    }
  }
}

/** True when a directory tree contains no regular files (only sub-dirs). */
async function dirHasNoFiles(dir: string): Promise<boolean> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return true;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!(await dirHasNoFiles(full))) return false;
    } else {
      return false; // a regular file (or symlink) — not safe to remove
    }
  }
  return true;
}

/**
 * Post-DB-commit cleanup: delete the source files, drop the stale cache, and
 * reclaim the empty old day-folder. Every step is best-effort — a leftover
 * after a crash here is a harmless orphan (the row already points at the good
 * new file), so nothing throws.
 */
export async function finalize(args: {
  libRoot: string;
  oldDirAbs: string;
  mapleId: string | undefined;
  /** Original filename — used to also drop legacy basename-keyed cache files. */
  filename: string;
  sourcesToDelete: string[];
}): Promise<void> {
  for (const src of args.sourcesToDelete) {
    await fs.unlink(src).catch((err) => {
      log.warn({ src, err: err instanceof Error ? err.message : err }, 'source unlink failed');
    });
  }
  await dropOldCache(args.oldDirAbs, args.mapleId, args.filename);
  await removeOldDirIfEmpty(args.oldDirAbs, args.libRoot);
}
