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
 * All three jail-check the destination through `safeWriteAllowed` first and
 * additionally require the path to RESOLVE to an `.xmp` file (#4749): a
 * `<stem>.xmp` that is a symlink to the original would otherwise be written
 * over or unlinked in its place. Reads apply the same rule via
 * `authorizeSidecarRead`. All three go through the mirror-aware fs drop-in,
 * so a published sidecar replicates to the library's backup and a deleted one
 * is deleted there too.
 */

import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
// Mirror-aware drop-in — see `mirrored.ts`.
import * as fs from './mirrored.ts';
import {
  checkAllowed,
  getRegisteredRoots,
  isWithinRoot,
  resolveRealPath,
  safeWriteAllowed,
} from './root.ts';
import { parseRootList } from './root-list.ts';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';
import type { OpResult } from './root.ts';
import { waitForAbortable } from './sidecar-write-order.ts';

const SIDECAR_EXTENSION = '.xmp';

async function canonicalRoot(root: string): Promise<string> {
  try {
    return await resolveRealPath(root);
  } catch {
    return path.resolve(root);
  }
}

/** Every root a sidecar may resolve into: `MAPLE_ROOTS`, roots registered at
 * runtime, and the database libraries. The fs jail alone allows everything
 * when the first two are empty — the documented default deployment, which
 * never calls `registerRoot` for its libraries (#4819) — so the sidecar jail
 * consults the libraries itself. Empty only when no library exists at all. */
async function sidecarRoots(): Promise<string[]> {
  const libraries = await loadLibraryRoots().then(
    (roots) => [...roots.values()],
    () => [],
  );
  const declared = [...parseRootList(process.env.MAPLE_ROOTS), ...getRegisteredRoots()];
  return Promise.all([...declared, ...libraries].map(canonicalRoot));
}

async function requireSidecarResolution(
  requested: string,
  allowed: OpResult<string>,
): Promise<OpResult<string>> {
  if (!allowed.ok) return allowed;
  const resolved = allowed.data ?? requested;
  if (path.extname(resolved).toLowerCase() !== SIDECAR_EXTENSION) {
    return {
      ok: false,
      error: `Sidecar path "${requested}" resolves to "${resolved}", which is not an .xmp file`,
    };
  }
  const roots = await sidecarRoots();
  return roots.length === 0 || roots.some((root) => isWithinRoot(root, resolved))
    ? { ok: true, data: resolved }
    : {
        ok: false,
        error: `Sidecar path "${requested}" resolves to "${resolved}", outside every library root`,
      };
}

/** Jail check for a sidecar about to be written or deleted; resolves symlinks
 * and refuses any target that is not itself an `.xmp` file inside a library
 * root (#4749). */
export async function authorizeSidecarWrite(destPath: string): Promise<OpResult<string>> {
  return requireSidecarResolution(destPath, await safeWriteAllowed(destPath));
}

/** Jail check for a sidecar about to be read — same rules as writes, so a
 * sidecar symlink cannot disclose an original or an out-of-root file. */
export async function authorizeSidecarRead(sidecar: string): Promise<OpResult<string>> {
  return requireSidecarResolution(sidecar, await checkAllowed(sidecar));
}

/** Read a sidecar without following a symlink in its final component, so a
 * directory entry swapped for a link between authorization and open is refused
 * (`ELOOP`) rather than followed (#4749). Callers pass the authorized path. */
export async function readSidecarNoFollow(sidecar: string): Promise<string> {
  const handle = await fs.open(sidecar, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

export async function authorizeUnlessAborted(destPath: string, signal?: AbortSignal) {
  try {
    return await waitForAbortable(authorizeSidecarWrite(destPath), signal);
  } catch (error) {
    if (!signal?.aborted) throw error;
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Only ENOENT means absence; permission and I/O errors must remain failures. */
export function isMissingSidecar(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

function temporarySidecarPath(destPath: string): string {
  return `${destPath}.tmp.${process.pid}.${randomBytes(8).toString('hex')}`;
}

async function stageSidecarTemp(
  destPath: string,
  tmpPath: string,
  content: string,
  signal?: AbortSignal,
): Promise<void> {
  const staging = (async () => {
    signal?.throwIfAborted();
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    signal?.throwIfAborted();
    const fh = await fs.open(tmpPath, 'w');
    try {
      signal?.throwIfAborted();
      await fh.writeFile(content, 'utf-8');
      signal?.throwIfAborted();
      await fh.datasync();
      signal?.throwIfAborted();
    } finally {
      await fh.close();
    }
  })();

  try {
    await waitForAbortable(staging, signal);
  } catch (error) {
    if (signal?.aborted) {
      void staging.then(
        () => removeTemporarySidecar(tmpPath),
        () => removeTemporarySidecar(tmpPath),
      );
    }
    throw error;
  }
}

async function publishStagedSidecar(
  destPath: string,
  tmpPath: string,
  content: string,
  signal: AbortSignal | undefined,
  publish: (tmpPath: string, destPath: string) => Promise<void>,
): Promise<Date> {
  await stageSidecarTemp(destPath, tmpPath, content, signal);
  signal?.throwIfAborted();
  await publish(tmpPath, destPath);
  const st = await waitForAbortable(fs.stat(destPath), signal);
  return st.mtime;
}

async function removeTemporarySidecar(tmpPath: string): Promise<void> {
  try {
    await fs.unlink(tmpPath);
  } catch {
    /* temp never created, or already gone */
  }
}

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
  signal?: AbortSignal,
): Promise<{ ok: true; mtime: Date } | { ok: false; error: string }> {
  const allowed = await authorizeUnlessAborted(destPath, signal);
  if (!allowed.ok) return { ok: false, error: allowed.error ?? 'Path not allowed' };

  const tmp = temporarySidecarPath(destPath);
  try {
    const mtime = await publishStagedSidecar(destPath, tmp, content, signal, fs.rename);
    return { ok: true, mtime };
  } catch (err) {
    if (signal?.aborted) void removeTemporarySidecar(tmp);
    else await removeTemporarySidecar(tmp);
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
  signal?: AbortSignal,
): Promise<{ ok: true; mtime: Date } | { ok: false; exists: true } | { ok: false; error: string }> {
  const allowed = await authorizeUnlessAborted(destPath, signal);
  if (!allowed.ok) return { ok: false, error: allowed.error ?? 'Path not allowed' };

  const tmp = temporarySidecarPath(destPath);
  try {
    // `link` is the atomic "create only if absent" primitive: it either
    // creates `destPath` pointing at the same inode as `tmp`, or fails with
    // EEXIST without touching whatever is already at `destPath`. There is no
    // window between "check" and "act" for a concurrent writer to land in —
    // unlike `stat` followed by `rename`, which are two separate operations.
    const mtime = await publishStagedSidecar(destPath, tmp, content, signal, fs.link);
    return { ok: true, mtime };
  } catch (err) {
    const alreadyExists = isEexist(err);
    return alreadyExists
      ? { ok: false, exists: true }
      : {
          ok: false,
          error: `${failureLabel}: ${err instanceof Error ? err.message : String(err)}`,
        };
  } finally {
    // The tmp file is redundant once `link` has published its content under
    // `destPath` (they're the same inode) — and it's still just clutter on
    // any failure path. Best-effort: it never existed, or it's already gone.
    if (signal?.aborted) void removeTemporarySidecar(tmp);
    else await removeTemporarySidecar(tmp);
  }
}

function isEexist(err: unknown): boolean {
  return (
    !!err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'EEXIST'
  );
}

/** Delete a sidecar. Idempotent — a file that was already gone is success. */
export async function deleteSidecar(
  destPath: string,
  failureLabel: string,
  signal?: AbortSignal,
): Promise<OpResult> {
  signal?.throwIfAborted();
  const allowed = await authorizeUnlessAborted(destPath, signal);
  if (!allowed.ok) return { ok: false, error: allowed.error };
  signal?.throwIfAborted();
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
