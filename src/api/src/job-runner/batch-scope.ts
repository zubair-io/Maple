import { resolve, sep } from 'node:path';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';
import { resolveAndAuthorizePath } from '../routes/xmp-path-auth.ts';

/** Canonical registered roots form an atomic Mongo uniqueness fence across clients. */
export async function batchScopes(payload: Record<string, unknown>): Promise<string[]> {
  const roots = [
    ...(await loadLibraryRoots()).values(),
    ...(process.env.MAPLE_ROOTS?.split(':').filter(Boolean) ?? []),
  ].map((root) => resolve(root));
  const targets = payload['targets'];
  if (!Array.isArray(targets) || targets.length === 0)
    throw new Error('Choose photos to synchronize');
  const scopes = new Set<string>();
  for (const target of targets) {
    const path = await resolveAndAuthorizePath(target?.path);
    if (!path.ok) throw new Error(path.error);
    const matches = roots.filter((root) => path.data === root || path.data.startsWith(root + sep));
    if (!matches.length) throw new Error('Photo is outside registered libraries');
    // The broadest matching root makes nested registrations share one fence.
    scopes.add(matches.sort((a, b) => a.length - b.length)[0]);
  }
  return [...scopes].sort();
}
