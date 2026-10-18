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
import { activeMirrorRoots } from './mirror-registry.ts';
import {
  isMirrorHealthy,
  markMirrorUnhealthy,
  MirrorIoTimeoutError,
  withTimeout as withMirrorTimeout,
} from './mirror-read.ts';

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
let mirrorRootsCache:
  | { source: readonly string[]; roots: readonly (readonly [string, string])[] }
  | undefined;

async function normalizedMirrorRoots(source: readonly string[]): Promise<string[]> {
  if (mirrorRootsCache?.source === source)
    return mirrorRootsCache.roots
      .filter(([configured]) => isMirrorHealthy(configured))
      .map(([, canonical]) => canonical);
  const resolved = await Promise.all(
    source.map(async (configured): Promise<readonly [string, string] | null> => {
      if (!isMirrorHealthy(configured)) return null;
      try {
        return [configured, await withMirrorTimeout(resolveRealPathThroughAncestors(configured))];
      } catch {
        markMirrorUnhealthy(configured);
        return null;
      }
    }),
  );
  const roots = resolved.filter((root): root is readonly [string, string] => root !== null);
  if (roots.length === source.length) mirrorRootsCache = { source, roots };
  return roots.map(([, canonical]) => canonical);
}

async function normalizedLibraryRoots(requested: string, real: string): Promise<string[]> {
  const libraries = await loadLibraryRoots();
  const configured = [...libraries.values()].map((root) => path.resolve(root));
  if (configured.some((root) => isWithinRoot(root, real))) return configured;
  const lexical = configured.filter((root) => isWithinRoot(root, requested));
  const probes = lexical.length ? lexical : configured;
  const matchingRoot = Promise.any(
    probes.map(async (root) => {
      const resolution = resolveRealPathThroughAncestors(root);
      const canonical = await resolution;
      if (!isWithinRoot(canonical, real)) throw new Error('Library root does not contain path');
      return canonical;
    }),
  ).catch(() => null);
  // Unknown paths must fail closed in finite time if an unrelated mount wedges.
  // Lexical library candidates remain unbounded, as primary I/O can be slow.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const match = lexical.length
    ? await matchingRoot
    : await Promise.race([
        matchingRoot,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), 3_000);
        }),
      ]).finally(() => clearTimeout(timer));
  return match ? [...configured, match] : configured;
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

async function resolveForJail(
  filePath: string,
  mirrors: readonly string[],
): Promise<string | null> {
  const requested = path.resolve(filePath);
  const cached = mirrorRootsCache?.source === mirrors ? mirrorRootsCache.roots : [];
  const candidates = mirrors.filter(
    (root) =>
      isWithinRoot(root, requested) ||
      cached.some(([configured, canonical]) =>
        configured === root ? isWithinRoot(canonical, requested) : false,
      ),
  );
  try {
    const resolution = resolveRealPath(filePath);
    return await (candidates.length ? withMirrorTimeout(resolution) : resolution);
  } catch (error) {
    if (error instanceof MirrorIoTimeoutError) {
      for (const mirror of candidates) markMirrorUnhealthy(mirror);
      return null;
    }
    // A new XMP leaf may not exist yet. Canonicalize its existing ancestor
    // so a directory symlink cannot escape the jail (#4748).
    return resolveRealPathThroughAncestors(filePath);
  }
}

async function mirrorAllowed(
  filePath: string,
  real: string,
  mirrorRoots: readonly string[],
): Promise<boolean> {
  if (!mirrorRoots.some((root) => isWithinRoot(root, path.resolve(filePath)))) return false;
  return (await normalizedMirrorRoots(mirrorRoots)).some((root) => isWithinRoot(root, real));
}

/**
 * Check whether `filePath` is under a registered library, enabled mirror,
 * runtime root, or MAPLE_ROOTS entry. Returns the resolved path on success.
 */
export async function checkAllowed(filePath: string): Promise<OpResult<string>> {
  const real = await resolveForJail(filePath, activeMirrorRoots());
  if (real === null) return { ok: false, error: 'Path resolution timed out' };
  const envRoots = await normalizedEnvRoots();
  const declared = [...envRoots, ..._registeredRoots];
  if (declared.some((root) => isWithinRoot(root, real))) return { ok: true, data: real };
  const mirrorRoots = activeMirrorRoots();
  if (await mirrorAllowed(filePath, real, mirrorRoots)) return { ok: true, data: real };
  let libraries: string[];
  try {
    libraries = await normalizedLibraryRoots(path.resolve(filePath), real);
  } catch (error) {
    if (declared.length === 0) {
      return {
        ok: false,
        error: `Cannot load registered library roots: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    libraries = [];
  }
  if (libraries.some((root) => isWithinRoot(root, real))) return { ok: true, data: real };
  const mirrors = await normalizedMirrorRoots(mirrorRoots);
  const allowedRoots = [...declared, ...libraries, ...mirrors];

  if (declared.length === 0 && libraries.length === 0 && mirrorRoots.length === 0) {
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
