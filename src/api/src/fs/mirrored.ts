/**
 * Mirror-aware drop-in for `node:fs/promises`.
 *
 * Swap a module's filesystem import from
 *
 *     import * as fs from 'node:fs/promises';   // or: import fs from 'node:fs/promises';
 *
 * to
 *
 *     import * as fs from './mirrored.ts';       // or: import fs from '<...>/fs/mirrored.ts';
 *
 * and every durable write/move/delete the module performs under a library
 * root is replicated to that library's configured mirror root(s). The exported
 * functions keep the exact signatures of the originals, so the swap is a
 * one-line change at each call site — no logic edits.
 *
 * ## What replicates
 *
 * Only *durable content under a mirrored library root* replicates. Resolution
 * is delegated to `mirror-registry.ts`; a path that resolves to no mirror
 * target (temp dirs, `/tmp` chunk staging, unmirrored libraries) passes
 * straight through to the real fs with zero overhead.
 *
 * Temp files are skipped explicitly (`isReplicablePath`): the codebase's atomic
 * pattern is "write `<final>.tmp.<pid>` then rename into place", and the raw
 * `writeFile`/`appendFile`/`open` calls only ever target those temps. We never
 * replicate the temp churn — we replicate the *result* of the publishing
 * `rename`/`copyFile`/`link`, so the mirror only ever sees committed files.
 *
 * ## Consistency
 *
 * The primary operation runs first and throws exactly as the real fs would —
 * the caller's success contract is unchanged. Mirror replication then runs
 * best-effort and never throws back into the caller: a slow or offline backup
 * must not fail or stall an edit on the primary. Replication failures are
 * surfaced to a pluggable sink (`onMirrorFailure`) which the async reconcile
 * worker hooks to repair drift; by default they are logged.
 */

import * as realFs from 'node:fs/promises';
import * as path from 'node:path';
import { child as childLogger } from '../log.ts';
import { resolveMirrorTargets, isMirroringActive, type MirrorTarget } from './mirror-registry.ts';

const log = childLogger('fs/mirror');

// ---------------------------------------------------------------------------
// Failure sink (hook point for the async reconcile worker)
// ---------------------------------------------------------------------------

/** A replication step that did not complete; the reconcile worker repairs these. */
export interface MirrorFailure {
  op: 'replicate' | 'unlink' | 'mkdir' | 'rm' | 'rmdir';
  /** The mirror-side path the failed op targeted. */
  mirrorPath: string;
  /** The primary-side source path (for `replicate`), else the same as mirrorPath. */
  sourcePath: string;
  error: Error;
}

type MirrorFailureSink = (failure: MirrorFailure) => void;

let _sink: MirrorFailureSink = (f) => {
  log.warn(
    { op: f.op, mirrorPath: f.mirrorPath, sourcePath: f.sourcePath, err: f.error.message },
    'mirror replication step failed — primary unaffected; drift will be repaired on reconcile',
  );
};

/** Install a failure sink (e.g. the durable reconcile queue). Returns the prior one. */
export function onMirrorFailure(sink: MirrorFailureSink): MirrorFailureSink {
  const prev = _sink;
  _sink = sink;
  return prev;
}

function report(failure: MirrorFailure): void {
  try {
    _sink(failure);
  } catch (err) {
    // The sink itself must never break replication accounting.
    log.error({ err: err instanceof Error ? err.message : err }, 'mirror failure sink threw');
  }
}

// ---------------------------------------------------------------------------
// Replication helpers
// ---------------------------------------------------------------------------

/** True for paths we replicate — durable files, never the `<x>.tmp.<pid>` temps. */
function isReplicablePath(p: string): boolean {
  return !path.basename(p).includes('.tmp.');
}

function isErrno(err: unknown, code: string): boolean {
  return !!err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === code;
}

/** Copy a committed primary file onto its mirror path, creating parents. */
async function replicateFile(t: MirrorTarget, sourcePath: string): Promise<void> {
  try {
    await realFs.mkdir(path.dirname(t.mirrorPath), { recursive: true });
    await realFs.copyFile(sourcePath, t.mirrorPath);
  } catch (error) {
    report({
      op: 'replicate',
      mirrorPath: t.mirrorPath,
      sourcePath,
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }
}

/** Remove a mirror path; ENOENT is success (idempotent delete). */
async function removeMirror(t: MirrorTarget): Promise<void> {
  try {
    await realFs.unlink(t.mirrorPath);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return;
    report({
      op: 'unlink',
      mirrorPath: t.mirrorPath,
      sourcePath: t.mirrorPath,
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }
}

/** Targets for a path, or `[]` when nothing should replicate. */
function targetsFor(p: string): MirrorTarget[] {
  if (!isMirroringActive() || !isReplicablePath(p)) return [];
  return resolveMirrorTargets(p);
}

// ---------------------------------------------------------------------------
// Mutating fs verbs — mirror-aware overrides
// ---------------------------------------------------------------------------

export async function rename(oldPath: string, newPath: string): Promise<void> {
  await realFs.rename(oldPath, newPath);
  // Replicate the committed destination, then drop any stale source copy on
  // the mirror (a same-library move) so the mirror tree converges to primary.
  for (const t of targetsFor(newPath)) await replicateFile(t, newPath);
  for (const t of targetsFor(oldPath)) await removeMirror(t);
}

export async function copyFile(src: string, dest: string, mode?: number): Promise<void> {
  await realFs.copyFile(src, dest, mode);
  for (const t of targetsFor(dest)) await replicateFile(t, dest);
}

export async function link(existingPath: string, newPath: string): Promise<void> {
  await realFs.link(existingPath, newPath);
  // A hardlink can't span devices/roots — replicate the bytes to the mirror.
  for (const t of targetsFor(newPath)) await replicateFile(t, newPath);
}

export async function unlink(p: string): Promise<void> {
  await realFs.unlink(p);
  for (const t of targetsFor(p)) await removeMirror(t);
}

export async function mkdir(
  p: string,
  options?: Parameters<typeof realFs.mkdir>[1],
): Promise<string | undefined> {
  const result = await realFs.mkdir(p, options as never);
  for (const t of targetsFor(p)) {
    try {
      await realFs.mkdir(t.mirrorPath, options as never);
    } catch (error) {
      report({
        op: 'mkdir',
        mirrorPath: t.mirrorPath,
        sourcePath: p,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  return result as string | undefined;
}

export async function rm(p: string, options?: Parameters<typeof realFs.rm>[1]): Promise<void> {
  await realFs.rm(p, options);
  for (const t of targetsFor(p)) {
    try {
      await realFs.rm(t.mirrorPath, options);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) continue;
      report({
        op: 'rm',
        mirrorPath: t.mirrorPath,
        sourcePath: p,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
}

export async function rmdir(p: string): Promise<void> {
  await realFs.rmdir(p);
  for (const t of targetsFor(p)) {
    try {
      await realFs.rmdir(t.mirrorPath);
    } catch (error) {
      // ENOENT (already gone) and ENOTEMPTY (mirror still has siblings the
      // primary doesn't) are both non-fatal for a best-effort cleanup.
      if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTEMPTY')) continue;
      report({
        op: 'rmdir',
        mirrorPath: t.mirrorPath,
        sourcePath: p,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Read-only / non-replicating passthroughs
// ---------------------------------------------------------------------------
//
// Re-exported verbatim so a call site can swap its entire `fs/promises` import
// to this module. `open`/`writeFile`/`appendFile` only ever target temp files
// in this codebase's atomic-write pattern, so they intentionally do NOT
// replicate — the committing rename/copyFile/link above carries the result to
// the mirror. Add to this list when a new call site needs another fs function.

export const stat = realFs.stat;
export const lstat = realFs.lstat;
export const readFile = realFs.readFile;
export const readdir = realFs.readdir;
export const open = realFs.open;
export const writeFile = realFs.writeFile;
export const appendFile = realFs.appendFile;
export const access = realFs.access;
export const realpath = realFs.realpath;
export const readlink = realFs.readlink;
export const opendir = realFs.opendir;
export const cp = realFs.cp;
export const chmod = realFs.chmod;
export const utimes = realFs.utimes;

/**
 * Default export mirroring `import fs from 'node:fs/promises'`: every real
 * member, with the mutating verbs overridden by the mirror-aware versions.
 */
const mirroredFs = {
  ...realFs,
  rename,
  copyFile,
  link,
  unlink,
  mkdir,
  rm,
  rmdir,
};

export default mirroredFs;
