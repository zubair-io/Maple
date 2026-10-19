/**
 * Filesystem path restriction — chroot-like safety layer.
 *
 * The server only reads/writes under the registered folder roots.
 * Any attempt to escape via ".." or symlinks outside the root is rejected.
 *
 * MAPLE_ROOTS env entries (platform PATH-separated absolute paths) extend the
 * runtime-registered and SQLite library roots.
 */

import { lstat, readFile, readlink, realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { loadJailLibraryRoots } from '../indexer/libraries.cache.ts';
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
 * Additional in-memory roots registered via `registerRoot()`. Library roots
 * from the shared `folders` table come from `loadJailLibraryRoots()`, whose
 * cache is invalidated across the API and worker processes.
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

const PRIMARY_PROBE_TIMEOUT_MS = 3_000;
type PrimaryProbe = {
  source: ReadonlyMap<string, string>;
  raw: Promise<string>;
  successor?: Promise<string | null>;
};
const primaryProbes = new Map<string, PrimaryProbe>();

/** An OS realpath cannot be cancelled. A later request gets one shared serial
 * revalidation; if its deadline expires, no queued I/O starts afterwards. */
function canonicalPrimary(
  root: string,
  source: ReadonlyMap<string, string>,
): Promise<string | null> {
  const pending = primaryProbes.get(root);
  if (pending) {
    if (pending.source !== source) return Promise.resolve(null);
    if (pending.successor) return pending.successor;
    let expired = false;
    const next = pending.raw.then(
      () => {
        if (expired) return null;
        if (primaryProbes.get(root) === pending) primaryProbes.delete(root);
        return canonicalPrimary(root, source);
      },
      () => {
        if (expired) return null;
        if (primaryProbes.get(root) === pending) primaryProbes.delete(root);
        return canonicalPrimary(root, source);
      },
    );
    return (pending.successor = boundedPrimary(next, () => (expired = true)));
  }
  const raw = resolveRealPathThroughAncestors(root).then((canonical) =>
    canonical === path.resolve(root) ? canonical : resolveRealPathThroughAncestors(root),
  );
  const probe: PrimaryProbe = { source, raw };
  primaryProbes.set(root, probe);
  void raw.then(
    () => {
      if (primaryProbes.get(root) === probe) primaryProbes.delete(root);
    },
    () => {
      if (primaryProbes.get(root) === probe) primaryProbes.delete(root);
    },
  );
  return boundedPrimary(raw);
}

function boundedPrimary(raw: Promise<string | null>, onTimeout = () => {}): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      onTimeout();
      resolve(null);
    }, PRIMARY_PROBE_TIMEOUT_MS);
  });
  return Promise.race([raw.catch(() => null), deadline]).finally(() => clearTimeout(timer));
}

async function allowedByPrimary(
  candidate: string,
  requested: string,
  source: ReadonlyMap<string, string>,
): Promise<boolean> {
  const roots = [...source.values()];
  const lexical = roots.filter((root) => isWithinRoot(root, requested));
  const selected = lexical.length ? lexical : roots;
  if (selected.length === 0) return false;
  return Promise.any(
    selected.map(async (root) => {
      const canonical = await canonicalPrimary(root, source);
      if (canonical && isWithinRoot(canonical, candidate)) return true;
      throw new Error('Outside primary root');
    }),
  ).catch(() => false);
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

const SEGMENT_SEPARATOR = path.sep === '\\' ? /[\\/]+/ : /\/+/;

function pathSegments(p: string): string[] {
  return p.slice(path.parse(p).root.length).split(SEGMENT_SEPARATOR).filter(Boolean);
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
 * Where a write to a not-yet-existing `filePath` would land. Symlinks are
 * followed one component at a time the way the kernel does, so a dangling
 * link and a link target's `..` (applied only after the prefix before it
 * resolves) cannot leave a lexical in-library answer for a write that lands
 * outside it.
 */
async function resolveLandingPath(filePath: string): Promise<string> {
  const resolved = path.resolve(filePath);
  const pending = pathSegments(resolved).reverse();
  let current = path.parse(resolved).root;
  let hops = 0;
  while (pending.length > 0) {
    const segment = pending.pop()!;
    if (segment === '.') continue;
    if (segment === '..') {
      current = path.dirname(current);
      continue;
    }
    const next = path.join(current, segment);
    const stats = await lstat(next).catch(() => null);
    if (!stats?.isSymbolicLink()) {
      current = next;
      continue;
    }
    hops += 1;
    if (hops > MAX_SYMLINK_HOPS) throw new Error(`Too many symbolic links in "${resolved}"`);
    const target = await readlink(next);
    if (path.isAbsolute(target)) current = path.parse(path.resolve(target)).root;
    pending.push(...pathSegments(target).reverse());
  }
  return current;
}

/** The path to operate on (a missing leaf, or a link itself, keeps its own
 *  name) and where a write through it lands; null when it cannot resolve. */
async function resolvePathAndLanding(
  filePath: string,
): Promise<{ real: string; landing: string } | null> {
  const existing = await resolveRealPath(filePath).catch(() => null);
  if (existing !== null) return { real: existing, landing: existing };
  const [real, landing] = await Promise.all([
    resolveRealPathThroughAncestors(filePath),
    resolveLandingPath(filePath).catch(() => null),
  ]);
  return landing === null ? null : { real, landing };
}

/**
 * Check whether `filePath` is under one of the registered roots (or any
 * MAPLE_ROOTS env entries). Returns the real (resolved) path on success.
 * Fails closed when no roots are known.
 */
export async function checkAllowed(filePath: string): Promise<OpResult<string>> {
  const resolution = await resolvePathAndLanding(filePath);
  if (resolution === null) return { ok: false, error: `Cannot resolve "${filePath}".` };
  const { real, landing } = resolution;
  const envRoots = await normalizedEnvRoots();
  const libraryRoots = await loadJailLibraryRoots().catch(() => new Map<string, string>());
  const requested = path.resolve(filePath);
  const explicitRoots = [...envRoots, ..._registeredRoots];
  const allowedRoots = [
    ...explicitRoots,
    ...[...libraryRoots.values()].map((root) => path.resolve(root)),
  ];
  const candidates = [...new Set([real, landing])];
  const results = await Promise.all(
    candidates.map(async (candidate) => {
      if (explicitRoots.some((root) => isWithinRoot(root, candidate))) return true;
      return allowedByPrimary(candidate, requested, libraryRoots);
    }),
  );
  if ((await loadJailLibraryRoots().catch(() => null)) !== libraryRoots)
    return { ok: false, error: 'Library roots changed during authorization' };
  const outside = candidates.find((_, index) => !results[index]);
  if (outside === undefined) return { ok: true, data: real };
  return {
    ok: false,
    error:
      `Path "${outside}" is outside all registered roots. ` +
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
