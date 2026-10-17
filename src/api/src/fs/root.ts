/**
 * Filesystem path restriction — chroot-like safety layer.
 *
 * The server only reads/writes under the registered folder roots.
 * Any attempt to escape via ".." or symlinks outside the root is rejected.
 *
 * Additionally, if MAPLE_ROOTS env is set (platform PATH-separated absolute paths),
 * all file access is restricted to those roots. If unset, the restriction is
 * per-folder (registered roots from the DB are the boundary).
 */

import { lstat, readFile, readlink, realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { loadSharedLibraryRoots } from '../indexer/libraries.cache.ts';
import { parseRootList } from './root-list.ts';

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
 * Additional in-memory roots registered via `registerRoot()`.
 * Shared library roots from the `folders` table are loaded dynamically via
 * `loadSharedLibraryRoots()` so additions and removals are visible across
 * the API and worker processes.
 */
const _registeredRoots = new Set<string>();
let envRootsCache:
  | {
      value: string | undefined;
      roots: Promise<string[]>;
    }
  | undefined;

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

const libraryRootRealpathCache = new Map<string, Promise<string>>();

function cachedLibraryRootRealpath(resolved: string): Promise<string> {
  const existing = libraryRootRealpathCache.get(resolved);
  if (existing) return existing;
  const pending = realpath(resolved).catch(() => {
    libraryRootRealpathCache.delete(resolved);
    return resolved;
  });
  libraryRootRealpathCache.set(resolved, pending);
  return pending;
}

async function normalizedLibraryRoots(): Promise<string[]> {
  const rawRoots = await loadSharedLibraryRoots();
  if (rawRoots.length === 0) return [];
  const normalized = new Set<string>();
  await Promise.all(
    rawRoots.map(async (root) => {
      const resolved = path.resolve(root);
      const real = await cachedLibraryRootRealpath(resolved);
      normalized.add(real);
      if (real !== resolved) normalized.add(resolved);
    }),
  );
  return [...normalized];
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
const MAX_SYMLINK_HOPS = 40;

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

/**
 * Resolve `filePath` including missing tails and dangling symlinks so a broken
 * symlink inside a library cannot fall back to its lexical in-library path.
 */
async function resolveTargetPath(filePath: string, hops = 0): Promise<string> {
  let candidate = path.resolve(filePath);
  try {
    return await resolveRealPath(candidate);
  } catch {
    if (hops >= MAX_SYMLINK_HOPS) return candidate;
  }
  const missingSegments: string[] = [];
  while (true) {
    try {
      const st = await lstat(candidate);
      if (st.isSymbolicLink()) {
        const target = await readlink(candidate);
        const next = path.resolve(path.dirname(candidate), target, ...missingSegments);
        return resolveTargetPath(next, hops + 1);
      }
      return path.join(await resolveRealPath(candidate), ...missingSegments);
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) return path.resolve(filePath);
      missingSegments.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

function isPathAndTargetWithinRoots(
  real: string,
  targetReal: string,
  roots: Iterable<string>,
): boolean {
  if (real === targetReal) {
    for (const root of roots) {
      if (isWithinRoot(root, real)) return true;
    }
    return false;
  }
  let realAllowed = false;
  let targetAllowed = false;
  for (const root of roots) {
    if (!realAllowed && isWithinRoot(root, real)) realAllowed = true;
    if (!targetAllowed && isWithinRoot(root, targetReal)) targetAllowed = true;
    if (realAllowed && targetAllowed) return true;
  }
  return false;
}

/**
 * Check whether `filePath` is under one of the registered roots (or any
 * MAPLE_ROOTS env entries). Returns the real (resolved) path on success.
 * Fails closed when no roots are known.
 */
async function checkAllowed(filePath: string): Promise<OpResult<string>> {
  let real: string;
  let targetReal: string;
  try {
    real = await resolveRealPath(filePath);
    targetReal = real;
  } catch {
    real = path.resolve(filePath);
    targetReal = await resolveTargetPath(real);
  }

  const envRoots = await normalizedEnvRoots();
  if (
    isPathAndTargetWithinRoots(real, targetReal, envRoots) ||
    isPathAndTargetWithinRoots(real, targetReal, _registeredRoots)
  ) {
    return { ok: true, data: real };
  }

  const libraryRoots = await normalizedLibraryRoots();
  const allowedRoots = [...new Set([...envRoots, ...libraryRoots, ..._registeredRoots])];
  if (isPathAndTargetWithinRoots(real, targetReal, allowedRoots)) {
    return { ok: true, data: real };
  }

  return {
    ok: false,
    error:
      `Path "${targetReal}" is outside all registered roots. ` +
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
    return { ok: false, error: 'Write destination must name a file, not a dot component.' };
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
