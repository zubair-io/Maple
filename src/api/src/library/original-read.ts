import * as path from 'node:path';
import { stat } from '../fs/mirrored.ts';
import { getLibraryBySlug } from '../indexer/libraries.cache.ts';
import { resolveMirrorTargets } from '../fs/mirror-registry.ts';
import {
  markMirrorUnhealthy,
  resolveOriginalReadSource,
  type OriginalReadSource,
} from '../fs/mirror-read.ts';
import {
  realpathJailCheck,
  resolveAddress,
  validateRelPathShape,
  type ResolvedAddress,
} from './address.ts';

/** The ordinary resolver requires an existing primary root. Originals alone
 * may fail over when that registered root is unavailable; all other address
 * callers keep their current jail. The selected replica is jailed below. */
async function resolveOriginalAddress(slug: string, relPath: string): Promise<ResolvedAddress> {
  try {
    return await resolveAddress(slug, relPath);
  } catch (error) {
    // Only an unavailable filesystem root may take the fallback. Invalid
    // slugs, traversal and escaping symlinks retain the ordinary rejection.
    if (!(error as NodeJS.ErrnoException)?.code) throw error;
    const library = await getLibraryBySlug(slug);
    if (!library) throw error;
    const rootStat = await stat(library.root).catch(() => null);
    if (rootStat?.isDirectory()) throw error;
    const shape = validateRelPathShape(relPath);
    if (!shape.ok) throw Object.assign(new Error(shape.error), { status: shape.status });
    return {
      libraryId: library.libraryId,
      libraryRoot: library.root,
      absPath: path.join(library.root, relPath),
    };
  }
}

/** Select an authoritative original replica, then jail and resolve the path
 * actually opened. A mirror's pathname is derived from the registered root,
 * but its on-disk symlinks must still remain within that mirror's own root. */
export async function resolveOriginalAddressRead(
  slug: string,
  relPath: string,
): Promise<{ absPath: string; source: OriginalReadSource | null }> {
  const address = await resolveOriginalAddress(slug, relPath);
  const candidates = resolveMirrorTargets(address.absPath).length + 1;
  for (let attempt = 0; attempt < candidates; attempt++) {
    const source = await resolveOriginalReadSource(address.absPath);
    if (!source) return { absPath: address.absPath, source: null };
    const readRoot =
      source.origin === 'primary'
        ? address.libraryRoot
        : resolveMirrorTargets(address.absPath).find((target) => target.mirrorPath === source.path)
            ?.mirrorRoot;
    if (!readRoot) continue;
    const relative = path.relative(readRoot, source.path).split(path.sep).join('/');
    const checked = await realpathJailCheck(readRoot, relative);
    if (checked.ok) return { absPath: address.absPath, source: { ...source, path: checked.real } };
    if (source.origin === 'mirror') {
      // Mirrors are an optimization: an invalid replica must not block the
      // healthy primary. Bench it through the existing health policy and retry.
      markMirrorUnhealthy(readRoot);
      continue;
    }
    throw Object.assign(new Error(checked.error), { status: checked.status });
  }
  return { absPath: address.absPath, source: null };
}
