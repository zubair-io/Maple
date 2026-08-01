/**
 * The two filesystem primitives every XMP sidecar write goes through.
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
 * Both jail-check the destination through `safeWriteAllowed` first, and both go
 * through the mirror-aware fs drop-in, so a published sidecar replicates to the
 * library's backup and a deleted one is deleted there too.
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
