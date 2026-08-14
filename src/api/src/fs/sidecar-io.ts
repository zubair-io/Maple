/**
 * The filesystem primitives every XMP sidecar write goes through.
 *
 * There are five sidecar mutations in the codebase — canonical write,
 * precondition write, conflict-copy write, canonical delete, conflict-copy
 * delete — and all five want the same two behaviours:
 *
 *   - **Publish atomically.** POSIX `rename` is atomic, so the bytes go to a
 *     private `<dest>.tmp.<pid>.<rand>` first and are fsynced before the rename.
 *     A crash mid-write leaves the temp, never a half-written sidecar. The temp
 *     is removed on any failure. This is the non-destructive contract at its
 *     narrowest point: the sidecar IS the user's edits.
 *   - **Delete idempotently.** ENOENT is success — the desired state (no file)
 *     is what the caller asked for.
 *
 * A sixth mutation — the create-only precondition write (#2532, #2784) —
 * needs a third behaviour:
 *
 *   - **Publish only-if-absent, atomically.** `rename` always replaces
 *     whatever is at the destination, so it cannot express "fail if
 *     something is already there" — a caller that wants that has to
 *     `stat` first and `rename` second, which is a check-then-act race
 *     between two concurrent writers. POSIX `link` has no such window: it
 *     fails with `EEXIST` if the destination exists, and creating it is a
 *     single filesystem operation, so two concurrent create-only writers
 *     for the same path can never both "win".
 *
 * All three jail-check the destination through `safeWriteAllowed` first, and
 * all three go through the mirror-aware fs drop-in, so a published sidecar
 * replicates to the library's backup and a deleted one is deleted there too.
 */

import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
// Mirror-aware drop-in — see `mirrored.ts`.
import * as fs from './mirrored.ts';
import { safeWriteAllowed } from './root.ts';
import type { OpResult } from './root.ts';

/**
 * Atomically publish `content` at `destPath`, returning the published file's
 * mtime — callers hand that back to clients as the precondition token for the
 * next write. `failureLabel` prefixes the error so each call site keeps its own
 * message (a jail rejection is still returned bare, as before).
 */
export async function writeSidecarAtomic(
  destPath: string,
  content: string,
  failureLabel: string,
): Promise<{ ok: true; mtime: Date } | { ok: false; error: string }> {
  const allowed = await safeWriteAllowed(destPath);
  if (!allowed.ok) return { ok: false, error: allowed.error ?? 'Path not allowed' };

  const tmp = `${destPath}.tmp.${process.pid}.${randomBytes(8).toString('hex')}`;
  try {
    // Ensure the directory exists (it should, but be defensive).
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    const fh = await fs.open(tmp, 'w');
    try {
      await fh.writeFile(content, 'utf-8');
      await fh.datasync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, destPath);
    const st = await fs.stat(destPath);
    return { ok: true, mtime: st.mtime };
  } catch (err) {
    try {
      await fs.unlink(tmp);
    } catch {
      /* temp never created, or already gone */
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `${failureLabel}: ${msg}` };
  }
}

/**
 * Atomically publish `content` at `destPath` only if nothing is there yet.
 * Unlike `writeSidecarAtomic`, this can't be raced: the destination is
 * created with `link`, which the kernel resolves as a single all-or-nothing
 * operation (either the link is created, or it fails with `EEXIST` because
 * something else won the race) — there is no separate check step for another
 * writer to land in between. `failureLabel` prefixes any non-`EEXIST` error.
 */
export async function writeSidecarCreateOnly(
  destPath: string,
  content: string,
  failureLabel: string,
): Promise<{ ok: true; mtime: Date } | { ok: false; exists: true } | { ok: false; error: string }> {
  const allowed = await safeWriteAllowed(destPath);
  if (!allowed.ok) return { ok: false, error: allowed.error ?? 'Path not allowed' };

  const tmp = `${destPath}.tmp.${process.pid}.${randomBytes(8).toString('hex')}`;
  try {
    // Ensure the directory exists (it should, but be defensive).
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    const fh = await fs.open(tmp, 'w');
    try {
      await fh.writeFile(content, 'utf-8');
      await fh.datasync();
    } finally {
      await fh.close();
    }
    // `link` is the atomic "create only if absent" primitive: it either
    // creates `destPath` pointing at the same inode as `tmp`, or fails with
    // EEXIST without touching whatever is already at `destPath`. There is no
    // window between "check" and "act" for a concurrent writer to land in —
    // unlike `stat` followed by `rename`, which are two separate operations.
    await fs.link(tmp, destPath);
    const st = await fs.stat(destPath);
    return { ok: true, mtime: st.mtime };
  } catch (err) {
    const alreadyExists = isEexist(err);
    return alreadyExists
      ? { ok: false, exists: true }
      : { ok: false, error: `${failureLabel}: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    // The tmp file is redundant once `link` has published its content under
    // `destPath` (they're the same inode) — and it's still just clutter on
    // any failure path. Best-effort: it never existed, or it's already gone.
    try {
      await fs.unlink(tmp);
    } catch {
      /* temp never created, or already gone */
    }
  }
}

function isEexist(err: unknown): boolean {
  return (
    !!err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'EEXIST'
  );
}

/** Delete a sidecar. Idempotent — a file that was already gone is success. */
export async function deleteSidecar(destPath: string, failureLabel: string): Promise<OpResult> {
  const allowed = await safeWriteAllowed(destPath);
  if (!allowed.ok) return { ok: false, error: allowed.error };
  try {
    await fs.unlink(destPath);
    return { ok: true };
  } catch (err: unknown) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: string }).code === 'ENOENT'
    ) {
      return { ok: true };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `${failureLabel}: ${msg}` };
  }
}
