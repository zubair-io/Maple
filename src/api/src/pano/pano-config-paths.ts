/**
 * Guard for the executable paths an operator may save in the pano config
 * (#4743). The server runs `maple_cli_path` and loads `ort_dylib_path`, so a
 * path that resolves inside a registered library root would let anyone able to
 * place a file in a library (upload, SMB share) choose what the service user
 * executes. Both the candidate and every root are compared by real path so a
 * symlinked alias cannot sidestep the check.
 */

import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { isWithinRoot } from '../fs/root.ts';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';

async function canonical(absPath: string): Promise<string> {
  try {
    return await realpath(absPath);
  } catch {
    return path.resolve(absPath);
  }
}

/** The library root that contains `candidate`, or `null` when it sits outside every root. */
export async function libraryRootContaining(candidate: string): Promise<string | null> {
  const [real, roots] = await Promise.all([
    canonical(candidate),
    Promise.all([...(await loadLibraryRoots()).values()].map(canonical)),
  ]);
  return roots.find((root) => isWithinRoot(root, real)) ?? null;
}

/** First executable path in `patch` that resolves inside a library root, as a rejection message. */
export async function rejectExecutablePathsInsideLibraries(patch: {
  maple_cli_path?: string | null;
  ort_dylib_path?: string | null;
}): Promise<string | null> {
  const candidates: [string, string | null | undefined][] = [
    ['maple_cli_path', patch.maple_cli_path],
    ['ort_dylib_path', patch.ort_dylib_path],
  ];
  for (const [field, value] of candidates) {
    if (typeof value !== 'string' || value.trim().length === 0) continue;
    const root = await libraryRootContaining(value.trim());
    if (root !== null) {
      return `${field} must not point inside a library root (${root}); the server executes it`;
    }
  }
  return null;
}
