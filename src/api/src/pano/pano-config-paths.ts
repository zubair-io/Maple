/**
 * Guard for the executable paths an operator may save in the pano config
 * (#4743). The server runs `maple_cli_path` and loads `ort_dylib_path`, so a
 * path that resolves inside a registered library root would let anyone able to
 * place a file in a library (upload, SMB share) choose what the service user
 * executes. Candidates and roots are compared by real path, resolving through
 * the nearest existing ancestor when the leaf does not exist yet, so neither a
 * symlinked alias nor a not-yet-planted binary sidesteps the check. Paths
 * stored before this guard existed are neutralised when the config is read.
 */

import path from 'node:path';
import { isWithinRoot, resolveRealPath } from '../fs/root.ts';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';
import { child as childLogger } from '../log.ts';
import {
  loadPanoConfig,
  resolvePanoConfig,
  type PanoConfigResolution,
} from './pano-config.repo.ts';

const log = childLogger('pano:config-paths');

type ExecutableField = 'maple_cli_path' | 'ort_dylib_path';
const EXECUTABLE_FIELDS: readonly ExecutableField[] = ['maple_cli_path', 'ort_dylib_path'];

/** Real path of `absPath`, resolving the deepest existing ancestor when the leaf is missing. */
async function canonical(absPath: string): Promise<string> {
  const resolved = path.resolve(absPath);
  const missing: string[] = [];
  let probe = resolved;
  while (true) {
    try {
      return path.join(await resolveRealPath(probe), ...missing.reverse());
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return resolved;
      missing.push(path.basename(probe));
      probe = parent;
    }
  }
}

async function libraryRootContaining(candidate: string): Promise<string | null> {
  const [real, roots] = await Promise.all([
    canonical(candidate),
    Promise.all([...(await loadLibraryRoots()).values()].map(canonical)),
  ]);
  return roots.find((root) => isWithinRoot(root, real)) ?? null;
}

/** First executable path in `patch` that resolves inside a library root, as a rejection message. */
export async function rejectExecutablePathsInsideLibraries(
  patch: Partial<Record<ExecutableField, string | null>>,
): Promise<string | null> {
  for (const field of EXECUTABLE_FIELDS) {
    const value = patch[field];
    if (typeof value !== 'string' || value.trim().length === 0) continue;
    const root = await libraryRootContaining(value.trim());
    if (root !== null) {
      return `${field} must not point inside a library root (${root}); the server executes it`;
    }
  }
  return null;
}

/** The effective pano config with any stored executable path that sits inside a
 * library root treated as unset, so it is never probed or run. */
export async function loadEffectivePanoConfig(): Promise<PanoConfigResolution> {
  const cfg = resolvePanoConfig(await loadPanoConfig());
  for (const field of EXECUTABLE_FIELDS) {
    const value = cfg[field];
    if (value === null) continue;
    const root = await libraryRootContaining(value);
    if (root === null) continue;
    log.warn(
      { field, path: value, root },
      'pano config: ignoring executable inside a library root',
    );
    cfg[field] = null;
    cfg.source[field] = 'unset';
  }
  return cfg;
}
