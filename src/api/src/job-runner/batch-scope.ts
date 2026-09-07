import { resolve, sep } from 'node:path';
import { safeWriteAllowed } from '../fs/root.ts';
import { xmpSidecarPath } from '../fs/xmp.ts';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';
import { resolveAndAuthorizePath } from '../routes/xmp-path-auth.ts';
import { parseSyncPayload } from './handlers/batch-sync-payload.ts';

export class BatchScopeError extends Error {
  override name = 'BatchScopeError';
}

/** Canonical registered roots form an atomic Mongo uniqueness fence across clients. */
export async function batchScopes(payload: Record<string, unknown>): Promise<string[]> {
  const roots = [
    ...(await loadLibraryRoots()).values(),
    ...(process.env.MAPLE_ROOTS?.split(':').filter(Boolean) ?? []),
  ].map((root) => resolve(root));
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
    const path = await resolveAndAuthorizePath(target.path);
    if (!path.ok) throw new BatchScopeError(path.error);
    const sidecar = await safeWriteAllowed(xmpSidecarPath(path.data));
    if (!sidecar.ok || !sidecar.data)
      throw new BatchScopeError(sidecar.error ?? 'Photo is outside registered libraries');
    if (sidecars.has(sidecar.data))
      throw new BatchScopeError('Photos in this batch share a sidecar');
    sidecars.add(sidecar.data);
    const matches = roots.filter((root) => path.data === root || path.data.startsWith(root + sep));
    if (!matches.length) throw new BatchScopeError('Photo is outside registered libraries');
    // The broadest matching root makes nested registrations share one fence.
    scopes.add(matches.sort((a, b) => a.length - b.length)[0]);
  }
  return [...scopes].sort();
}
