/**
 * Filesystem path restriction — chroot-like safety layer.
 *
 * The server only reads/writes under the registered folder roots.
 * Any attempt to escape via ".." or symlinks outside the root is rejected.
 *
 * MAPLE_ROOTS (platform PATH-separated absolute paths), DB libraries, enabled
 * local mirrors, and roots registered at runtime form the allowed set.
 */

import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { parseRootList } from './root-list.ts';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';
import { snapshotMirrorRoots } from './mirror-registry.ts';

export interface OpResult<T = undefined> {
  ok: boolean;
  data?: T;
  error?: string;
}

/** Containment for normalized absolute paths, including volume roots. */
export function isWithinRoot(root: string, filePath: string): boolean {
  const relative = path.relative(root, filePath);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/**
 * Additional runtime roots used by recovery flows. DB libraries are loaded
 * through the invalidated library cache below.
 */
const _registeredRoots = new Set<string>();
let envRootsCache:
  | {
      value: string | undefined;
      roots: Promise<string[]>;
    }
  | undefined;
const libraryRootsCache = new WeakMap<ReadonlyMap<string, string>, Promise<string[]>>();

async function normalizedLibraryRoots(): Promise<string[]> {
  const libraries = await loadLibraryRoots();
  const cached = libraryRootsCache.get(libraries);
  if (cached) return cached;
  const roots = Promise.all([...libraries.values()].map(resolveRealPathThroughAncestors));
  libraryRootsCache.set(libraries, roots);
  return roots;
}

async function normalizedEnvRoots(): Promise<string[]> {
  const value = process.env.MAPLE_ROOTS;
  if (envRootsCache && envRootsCache.value === value) return envRootsCache.roots;
  const roots = Promise.all(
    parseRootList(value).map(async (root) => {
      try {
        return await realpath(root);
      } catch {
        return path.resolve(root);
      }
    }),
  );
  // Publish the value and its in-flight normalization atomically. Concurrent
  // authorization checks must await the same promise; exposing an interim
  // empty array would turn a configured-root policy into allow-all.
  envRootsCache = { value, roots };
  return roots;
}

/** Register a root so that file access under it is permitted.
 *  Resolves symlinks so that macOS /var → /private/var is handled correctly. */
export function registerRoot(absPath: string): void {
  const normalized = path.resolve(absPath);
  // Eagerly resolve the real path synchronously; fall back to as-given.
  let real = normalized;
  try {
    real = require('fs').realpathSync(normalized);
  } catch {}
  _registeredRoots.add(real);
  // Also add the original (pre-symlink) path in case realpath fails later.
  if (real !== normalized) _registeredRoots.add(normalized);
}

/** Unregister a root. */
export function unregisterRoot(absPath: string): void {
  const normalized = path.resolve(absPath);
  _registeredRoots.delete(normalized);
  try {
    _registeredRoots.delete(require('fs').realpathSync(normalized));
  } catch {}
}

/** Return a snapshot of registered roots. */
export function getRegisteredRoots(): string[] {
  return [..._registeredRoots];
}

const UNLINKED_INODE_SUFFIX = ' (deleted)';

/**
 * Bun's Linux `realpath` opens the file and reads `/proc/self/fd/N`. When an
 * atomic save renames over the file in between, the kernel names the opened,
 * now-unlinked inode `<real path> (deleted)` — which forked the per-sidecar
 * write barrier for one file (#4051).
 */
export async function resolveRealPath(filePath: string): Promise<string> {
  const real = await realpath(filePath);
  if (!real.endsWith(UNLINKED_INODE_SUFFIX)) return real;
  const [resolved, requested] = await Promise.all([
    lstat(real).catch(() => null),
    stat(filePath).catch(() => null),
  ]);
  const sameFile =
    resolved !== null &&
    requested !== null &&
    resolved.dev === requested.dev &&
    resolved.ino === requested.ino;
  return sameFile ? real : real.slice(0, -UNLINKED_INODE_SUFFIX.length);
}

/** Real path of `filePath`, resolving through the deepest existing ancestor when
 * the leaf (or more) does not exist yet, so a not-yet-written file under a
 * symlinked directory still canonicalises to where it will really land. */
export async function resolveRealPathThroughAncestors(filePath: string): Promise<string> {
  const resolved = path.resolve(filePath);
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

/**
 * Check whether `filePath` is under a registered library, enabled mirror,
 * runtime root, or MAPLE_ROOTS entry. Returns the resolved path on success.
 */
export async function checkAllowed(filePath: string): Promise<OpResult<string>> {
  let real: string;
  try {
    // Resolve symlinks to prevent directory traversal.
    real = await resolveRealPath(filePath);
  } catch {
    // Not written yet (a new XMP, a folder about to be created). A text-only
    // resolve would miss a directory symlink higher up and authorize a write
    // that lands outside the root (#4748), so canonicalise the deepest
    // ancestor that does exist and append the missing tail to it.
    real = await resolveRealPathThroughAncestors(filePath);
  }

  const envRoots = await normalizedEnvRoots();
  const declared = [...envRoots, ..._registeredRoots];
  let libraries: string[];
  try {
    libraries = await normalizedLibraryRoots();
  } catch (error) {
    if (declared.length === 0) {
      return {
        ok: false,
        error: `Cannot load registered library roots: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    libraries = [];
  }
  const mirrorRoots = Object.values(snapshotMirrorRoots()).flat();
  const mirrors = await Promise.all(mirrorRoots.map(resolveRealPathThroughAncestors));
  const allowedRoots = [...declared, ...libraries, ...mirrors];

  if (allowedRoots.length === 0) {
    // A successfully loaded, empty library still permits first-run setup.
    return { ok: true, data: real };
  }

  for (const root of allowedRoots) {
    if (isWithinRoot(root, real)) {
      return { ok: true, data: real };
    }
  }

  return {
    ok: false,
    error:
      `Path "${real}" is outside all registered roots. ` +
      `Registered: [${allowedRoots.join(', ')}]`,
  };
}

/**
 * Validate that a prospective root directory:
 *   1. Is an absolute path.
 *   2. Exists and is a directory.
 *   3. Is readable.
 */
export async function validateRoot(dirPath: string): Promise<OpResult> {
  if (!path.isAbsolute(dirPath)) {
    return { ok: false, error: 'Path must be absolute.' };
  }
  try {
    const s = await stat(dirPath);
    if (!s.isDirectory()) {
      return { ok: false, error: `"${dirPath}" is not a directory.` };
    }
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Cannot access "${dirPath}": ${msg}` };
  }
}

/**
 * Safe file read: checks allowed roots then streams the content.
 */
export async function safeReadFile(filePath: string): Promise<OpResult<Buffer>> {
  const check = await checkAllowed(filePath);
  if (!check.ok) return { ok: false, error: check.error };

  try {
    const data = await readFile(check.data!);
    return { ok: true, data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Cannot read "${filePath}": ${msg}` };
  }
}

/**
 * Safe file write: checks allowed roots first.
 * Returns the resolved absolute path on success.
 */
export async function safeWriteAllowed(filePath: string): Promise<OpResult<string>> {
  const name = path.basename(filePath);
  if (name === '.' || name === '..') {
    return {
      ok: false,
      error: 'Write destination must name a file, not a dot component.',
    };
  }
  // For writes, the file may not exist yet; check parent dir.
  const parent = path.dirname(filePath);
  const check = await checkAllowed(parent);
  if (check.ok) {
    // Retain the canonical parent for new sidecars beneath configured aliases,
    // and authorize the complete destination in case the sidecar is a symlink.
    return checkAllowed(path.join(check.data!, name));
  } else {
    // Also try the file path itself (in case dirname escapes).
    const check2 = await checkAllowed(filePath);
    if (!check2.ok) return { ok: false, error: check.error };
    return { ok: true, data: check2.data };
  }
}
