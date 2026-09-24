import { dirname, join, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { isWithinRoot, safeWriteAllowed } from '../fs/root.ts';
import { parseRootList } from '../fs/root-list.ts';
import { xmpSidecarPath } from '../fs/xmp.ts';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';
import { listLibraryRoots } from '../db/repos/folders.repo.ts';
import type { SqliteDb } from '../db/repos/db-handle.ts';
import { resolveAndAuthorizePath, safeWriteAllowedForPath } from '../routes/xmp-path-auth.ts';
import { parseSyncPayload } from './handlers/batch-sync-payload.ts';

export class BatchScopeError extends Error {
  override name = 'BatchScopeError';
}

async function canonicalRoot(root: string): Promise<string> {
  const marker = await safeWriteAllowed(join(root, '.maple-batch-scope'));
  return marker.ok && marker.data ? dirname(marker.data) : resolve(root);
}

/** Canonical registered roots form an atomic uniqueness fence across clients. */
export async function batchScopes(
  payload: Record<string, unknown>,
  dbOverride?: SqliteDb,
): Promise<string[]> {
  const libraryRoots = dbOverride
    ? (await listLibraryRoots(dbOverride)).map((root) => root.path)
    : [...(await loadLibraryRoots()).values()];
  const roots = dbOverride
    ? await Promise.all(libraryRoots.map((root) => realpath(root).catch(() => resolve(root))))
    : await Promise.all(
        [...libraryRoots, ...parseRootList(process.env.MAPLE_ROOTS)].map(canonicalRoot),
      );
  const targets = (() => {
    try {
      return parseSyncPayload(payload).targets;
    } catch (error) {
      throw new BatchScopeError(error instanceof Error ? error.message : String(error));
    }
  })();
  const scopes = new Set<string>();
  const sidecars = new Set<string>();
  for (const target of targets) {
    const path = await resolveAndAuthorizePath(target.path, dbOverride);
    if (!path.ok) throw new BatchScopeError(path.error);
    const sidecar = await safeWriteAllowedForPath(xmpSidecarPath(path.data), dbOverride);
    if (!sidecar.ok)
      throw new BatchScopeError(sidecar.error ?? 'Photo is outside registered libraries');
    if (!sidecar.data) throw new BatchScopeError('Photo is outside registered libraries');
    const sidecarPath = sidecar.data;
    if (sidecars.has(sidecarPath))
      throw new BatchScopeError('Photos in this batch share a sidecar');
    sidecars.add(sidecarPath);
    const matches = roots.filter((root) => isWithinRoot(root, sidecarPath));
    if (!matches.length) throw new BatchScopeError('Photo is outside registered libraries');
    // The broadest matching root makes nested registrations share one fence.
    scopes.add(matches.sort((a, b) => a.length - b.length)[0]);
  }
  return [...scopes].sort();
}
