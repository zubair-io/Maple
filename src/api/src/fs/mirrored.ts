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
 * Bytes written by an FFI worker or a child process never pass through this
 * module at all (the `.maple/` thumbnail + preview tiers). Those callers invoke
 * `replicatePath` explicitly once their artefact is committed.
 *
 * ## Consistency
 *
 * The primary operation runs first and throws exactly as the real fs would —
 * the caller's success contract is unchanged. Mirror replication is then
 * *scheduled* (not awaited) so caller latency never depends on mirror health:
 * a slow or offline backup can neither stall nor fail an edit on the primary.
 * Scheduled tasks are best-effort and never throw; failures are surfaced to a
 * pluggable sink (`onMirrorFailure`). Tests and graceful shutdown await
 * quiescence with `flushPendingMirrorOps`.
 *
 * Durability: in production the sink (`workers/mirror/sink.ts`) enqueues each
 * failed *replication* into the `mirror_queue` collection, and the mirror copy
 * worker retries it with backoff + dead-letter. The mirror-scan detector
 * independently enqueues any drift it finds. So a failed mirror write is
 * retried, not merely logged — the default (no sink installed) just logs.
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
  op: 'replicate' | 'unlink' | 'mkdir' | 'rm' | 'rmdir' | 'utimes';
  /** The mirror-side path the failed op targeted. */
  mirrorPath: string;
  /** The primary-side source path (for `replicate`), else the same as mirrorPath. */
  sourcePath: string;
  error: Error;
}

type MirrorFailureSink = (failure: MirrorFailure) => void;

let _sink: MirrorFailureSink = (f) => {
  log.warn(
    {
      op: f.op,
      mirrorPath: f.mirrorPath,
      sourcePath: f.sourcePath,
      err: f.error.message,
    },
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
  return (
    !!err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === code
  );
}

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

/** Copy a committed primary file onto its mirror path, creating parents. */
async function replicateFile(t: MirrorTarget, sourcePath: string): Promise<void> {
  try {
    await realFs.mkdir(path.dirname(t.mirrorPath), { recursive: true });
    await realFs.copyFile(sourcePath, t.mirrorPath);
    // Preserve the source's mtime so the mirror is a faithful copy. This
    // matters for the mtime-based thumbnail-staleness check (thumb.mtime >=
    // source.mtime) once the mirror serves reads, and for integrity diffs.
    // copyFile stamps the destination with "now"; restore the real times.
    // Best-effort — a copied-but-not-restamped file is still correct bytes.
    try {
      const st = await realFs.stat(sourcePath);
      await realFs.utimes(t.mirrorPath, st.atime, st.mtime);
    } catch {
      /* mtime fidelity only — the bytes are already mirrored */
    }
  } catch (error) {
    report({ op: 'replicate', mirrorPath: t.mirrorPath, sourcePath, error: asError(error) });
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
      error: asError(error),
    });
  }
}

/** Targets for a path, or `[]` when nothing should replicate. */
function targetsFor(p: string): MirrorTarget[] {
  if (!isMirroringActive() || !isReplicablePath(p)) return [];
  return resolveMirrorTargets(p);
}

// ---------------------------------------------------------------------------
// Non-blocking scheduling
// ---------------------------------------------------------------------------
//
// The primary op is awaited; mirror replication is *scheduled* to run after it
// returns, so caller latency never depends on mirror health — a slow or
// offline network mirror can't stall an edit. Each scheduled task is tracked
// so tests and graceful shutdown can await quiescence via
// `flushPendingMirrorOps`. The tasks never reject: every internal fs op
// funnels failures to the sink, so a tracked promise always settles cleanly.

const _pending = new Set<Promise<void>>();

function schedule(work: () => Promise<unknown>): void {
  const p: Promise<void> = work()
    .then(() => undefined)
    .catch((err) => {
      // Defensive — inner ops already catch + report, so this should never
      // fire. Log rather than leak an unhandled rejection if it ever does.
      log.error({ err: err instanceof Error ? err.message : err }, 'mirror task crashed');
    })
    .finally(() => {
      _pending.delete(p);
    });
  _pending.add(p);
}

/**
 * Await all in-flight mirror replication. Call from tests before asserting
 * mirror state, and from graceful shutdown so pending copies aren't cut off.
 */
export function flushPendingMirrorOps(): Promise<void> {
  return Promise.all([..._pending]).then(() => undefined);
}

/** Best-effort mirror `mkdir`; swallows + reports failures. */
async function mirrorMkdir(
  t: MirrorTarget,
  options: Parameters<typeof realFs.mkdir>[1],
  source: string,
): Promise<void> {
  try {
    await realFs.mkdir(t.mirrorPath, options as never);
  } catch (error) {
    report({ op: 'mkdir', mirrorPath: t.mirrorPath, sourcePath: source, error: asError(error) });
  }
}

/** Best-effort mirror `rm`; ENOENT is success. */
async function mirrorRm(
  t: MirrorTarget,
  options: Parameters<typeof realFs.rm>[1],
  source: string,
): Promise<void> {
  try {
    await realFs.rm(t.mirrorPath, options);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return;
    report({ op: 'rm', mirrorPath: t.mirrorPath, sourcePath: source, error: asError(error) });
  }
}

/** Best-effort mirror `rmdir`; ENOENT/ENOTEMPTY are non-fatal for cleanup. */
async function mirrorRmdir(t: MirrorTarget, source: string): Promise<void> {
  try {
    await realFs.rmdir(t.mirrorPath);
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTEMPTY')) return;
    report({ op: 'rmdir', mirrorPath: t.mirrorPath, sourcePath: source, error: asError(error) });
  }
}

/** Best-effort recursive removal of a mirror entry (file or directory) that
 * moved out of, or between, mirrored roots. `force` makes ENOENT a no-op. */
async function removeMirrorEntry(t: MirrorTarget): Promise<void> {
  try {
    await realFs.rm(t.mirrorPath, { recursive: true, force: true });
  } catch (error) {
    report({
      op: 'rmdir',
      mirrorPath: t.mirrorPath,
      sourcePath: t.mirrorPath,
      error: asError(error),
    });
  }
}

/**
 * Mirror a rename/move of a file OR directory. Prefers renaming the existing
 * mirror entry into place — atomic, carries the whole subtree, and never leaves
 * a window where the mirror has no copy — and falls back to rebuilding from the
 * committed primary when the mirror lacks the source. Crucially it does NOT
 * delete the old mirror copy: the caller removes orphaned source entries only
 * when their mirror root has no matching destination, so a failed replication
 * can never leave the mirror missing the file.
 */
async function mirrorRename(
  oldMirrorPath: string | undefined,
  primaryNewPath: string,
  t: MirrorTarget,
  isDir: boolean,
): Promise<void> {
  try {
    await realFs.mkdir(path.dirname(t.mirrorPath), { recursive: true });
    if (oldMirrorPath) {
      try {
        await realFs.rename(oldMirrorPath, t.mirrorPath);
        return;
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error;
        // Mirror lacked the source — rebuild it from primary below.
      }
    }
    if (isDir) {
      await realFs.cp(primaryNewPath, t.mirrorPath, { recursive: true });
    } else {
      // replicateFile copies + preserves mtime and reports its own failures.
      await replicateFile(t, primaryNewPath);
    }
  } catch (error) {
    report({
      op: 'replicate',
      mirrorPath: t.mirrorPath,
      sourcePath: primaryNewPath,
      error: asError(error),
    });
  }
}

// ---------------------------------------------------------------------------
// Mutating fs verbs — mirror-aware overrides
// ---------------------------------------------------------------------------

export async function rename(oldPath: string, newPath: string): Promise<void> {
  await realFs.rename(oldPath, newPath);
  const dst = targetsFor(newPath);
  const src = targetsFor(oldPath);
  if (dst.length === 0 && src.length === 0) return;
  schedule(async () => {
    // Detect file vs directory once from the committed primary so the mirror
    // move copies a single file or a whole subtree as appropriate.
    let isDir = false;
    try {
      isDir = (await realFs.stat(newPath)).isDirectory();
    } catch {
      // newPath already gone (a rapid follow-up op) — nothing to replicate.
    }
    const dstRoots = new Set(dst.map((t) => t.mirrorRoot));
    const oldByRoot = new Map(src.map((t) => [t.mirrorRoot, t.mirrorPath]));
    await Promise.all([
      // Move (or rebuild) each destination mirror entry into place. Never
      // deletes the source copy first, so a failed replication can't lose it.
      ...dst.map((t) => mirrorRename(oldByRoot.get(t.mirrorRoot), newPath, t, isDir)),
      // Source mirror roots with NO matching destination — the entry moved out
      // of the mirrored set (dst empty / non-mirrored target) or between
      // libraries with different mirrors — so remove the now-orphaned copy.
      ...src.filter((t) => !dstRoots.has(t.mirrorRoot)).map((t) => removeMirrorEntry(t)),
    ]);
  });
}

/**
 * Explicitly replicate an already-committed file at `absPath`.
 *
 * The escape hatch for bytes this module cannot intercept: the thumbnail and
 * preview tiers are rendered *out-of-band* — an FFI worker or an imgdecode
 * child process writes straight to the path — so no fs verb here ever sees
 * them. The renderer calls this once, after its validate-then-publish rename
 * has committed the artefact, and the `.maple/` cache lands on the mirror like
 * every other durable write.
 *
 * Same contract as the verbs above: fire-and-forget, never throws, failures go
 * to the sink (and from there to the durable retry queue), and a path with no
 * mirror target costs one registry lookup. Call it only for a *committed*
 * path — never a temp — and only after the write succeeded.
 */
export function replicatePath(absPath: string): void {
  const targets = targetsFor(absPath);
  if (targets.length) schedule(() => Promise.all(targets.map((t) => replicateFile(t, absPath))));
}

export async function copyFile(src: string, dest: string, mode?: number): Promise<void> {
  await realFs.copyFile(src, dest, mode);
  const targets = targetsFor(dest);
  if (targets.length) schedule(() => Promise.all(targets.map((t) => replicateFile(t, dest))));
}

export async function link(existingPath: string, newPath: string): Promise<void> {
  await realFs.link(existingPath, newPath);
  // A hardlink can't span devices/roots — replicate the bytes to the mirror.
  const targets = targetsFor(newPath);
  if (targets.length) schedule(() => Promise.all(targets.map((t) => replicateFile(t, newPath))));
}

export async function unlink(p: string): Promise<void> {
  await realFs.unlink(p);
  const targets = targetsFor(p);
  if (targets.length) schedule(() => Promise.all(targets.map((t) => removeMirror(t))));
}

export async function mkdir(
  p: string,
  options?: Parameters<typeof realFs.mkdir>[1],
): Promise<string | undefined> {
  const result = await realFs.mkdir(p, options as never);
  const targets = targetsFor(p);
  if (targets.length) schedule(() => Promise.all(targets.map((t) => mirrorMkdir(t, options, p))));
  return result as string | undefined;
}

export async function rm(p: string, options?: Parameters<typeof realFs.rm>[1]): Promise<void> {
  await realFs.rm(p, options);
  const targets = targetsFor(p);
  if (targets.length) schedule(() => Promise.all(targets.map((t) => mirrorRm(t, options, p))));
}

export async function rmdir(p: string): Promise<void> {
  await realFs.rmdir(p);
  const targets = targetsFor(p);
  if (targets.length) schedule(() => Promise.all(targets.map((t) => mirrorRmdir(t, p))));
}

/** Best-effort mirror `utimes`; ENOENT (the mirror copy hasn't landed yet) is
 * tolerated — the scan/copy worker reconciles the mtime on the next pass. */
async function mirrorUtimes(
  t: MirrorTarget,
  atime: Parameters<typeof realFs.utimes>[1],
  mtime: Parameters<typeof realFs.utimes>[2],
  source: string,
): Promise<void> {
  try {
    await realFs.utimes(t.mirrorPath, atime, mtime);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return;
    report({ op: 'utimes', mirrorPath: t.mirrorPath, sourcePath: source, error: asError(error) });
  }
}

/** Mirror-aware `utimes`: e.g. the upload route stamps a committed file's mtime
 * after the rename, so the mirror copy must inherit it to stay a faithful
 * shadow (and so drift detection isn't fooled by a "newer" mirror). */
export async function utimes(
  p: string,
  atime: Parameters<typeof realFs.utimes>[1],
  mtime: Parameters<typeof realFs.utimes>[2],
): Promise<void> {
  await realFs.utimes(p, atime, mtime);
  const targets = targetsFor(p);
  if (targets.length)
    schedule(() => Promise.all(targets.map((t) => mirrorUtimes(t, atime, mtime, p))));
}

// ---------------------------------------------------------------------------
// Passthroughs — the rest of the node:fs/promises surface
// ---------------------------------------------------------------------------
//
// Re-export the WHOLE module so this is a true drop-in for `import * as fs from
// 'node:fs/promises'` — any read (stat/readFile/readdir/…) or fs function not
// overridden above forwards to the real implementation, with no need to hand-
// maintain a forwarding list. The mutating verbs declared above
// (rename/copyFile/link/unlink/mkdir/rm/rmdir/utimes) shadow their star-exported
// counterparts with the mirror-aware versions.
//
// Deliberately NOT mirrored, and intentionally left as plain passthroughs:
//   - open / writeFile / appendFile — only ever target the `<final>.tmp.<pid>`
//     temps in this codebase's atomic-write pattern; the committing
//     rename/copyFile/link carries the *result* to the mirror.
//   - cp / chmod — no durable call site through this module today; add a
//     mirror-aware override above if one appears.
export * from 'node:fs/promises';

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
  utimes,
  rm,
  rmdir,
};

export default mirroredFs;
