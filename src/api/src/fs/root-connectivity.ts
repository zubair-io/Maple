// Per-library-root connectivity for the folders listing (#2892).
//
// "Connected" answers one question for the UI: can this registered root be
// browsed right now? The web sidebar hides disconnected roots; the
// Settings → Sources page shows them with their status so the operator can
// re-mount the share / re-plug the drive.
//
// Policy (deliberately reuses the missing-reaper's evidence rules — see
// `libraryRootAvailable` in workers/missing-reaper.helpers.ts):
//   - path does not stat as a directory       → disconnected
//   - library has indexed files (file_count>0)
//     but the root lists as empty/unlistable  → disconnected (the classic
//     unmounted-SMB signature: the mount point stats fine but is empty)
//   - brand-new library with nothing indexed  → connected while the path
//     stats, even if empty — a just-registered empty folder must not vanish
//     from the sidebar the moment it is added
//
// Every check is capped by a hard timeout: stat/opendir on a dead network
// mount can hang for tens of seconds, and `GET /api/folders` is on the
// sidebar's boot path. A timed-out check reports disconnected (a root that
// slow is not usable) and results are cached briefly so File Provider
// revalidation polls don't re-stat every root.

import { libraryRootAvailable, statKind } from '../workers/missing-reaper.helpers.ts';

const CHECK_TIMEOUT_MS = 1_500;
const CACHE_TTL_MS = 30_000;

const cache = new Map<string, { connected: boolean; at: number }>();

/** Test hook: drop all cached results so a re-check hits the filesystem. */
export function resetConnectivityCacheForTests(): void {
  cache.clear();
}

async function withTimeout(check: Promise<boolean>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), CHECK_TIMEOUT_MS);
  });
  try {
    // The losing fs promise is left to settle in the background; there is no
    // portable way to cancel a hung stat on a dead mount.
    return await Promise.race([check.catch(() => false), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function checkRoot(path: string, fileCount: number): Promise<boolean> {
  if ((await statKind(path)) !== 'present') return false;
  return fileCount > 0 ? libraryRootAvailable(path) : true;
}

/**
 * Connectivity for one registered root. `fileCount` is the library's
 * indexed `file_count` (drives the empty-root policy above). `fresh: true`
 * skips the cached result (still repopulates it) — used by the Settings →
 * Sources "Check again" action, where serving a ≤30s-old answer would make
 * the button a no-op.
 */
export async function rootConnected(
  path: string,
  fileCount: number,
  opts: { fresh?: boolean } = {},
): Promise<boolean> {
  const cached = cache.get(path);
  const now = Date.now();
  if (!opts.fresh && cached && now - cached.at < CACHE_TTL_MS) return cached.connected;

  const connected = await withTimeout(checkRoot(path, fileCount));
  cache.set(path, { connected, at: now });
  return connected;
}

/**
 * Connectivity for a set of roots, checked in parallel (each individually
 * cached + timeout-capped). Returns `path → connected`.
 */
export async function rootsConnected(
  roots: readonly { path: string; fileCount: number }[],
  opts: { fresh?: boolean } = {},
): Promise<Map<string, boolean>> {
  const entries = await Promise.all(
    roots.map(async (r) => [r.path, await rootConnected(r.path, r.fileCount, opts)] as const),
  );
  return new Map(entries);
}
