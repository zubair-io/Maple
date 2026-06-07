/**
 * Mirror registry — the in-memory map from a library's primary root to its
 * backup/mirror roots, plus the path-resolution that turns an absolute path
 * under a primary root into the matching absolute path(s) under each mirror.
 *
 * This is deliberately a *pure, synchronous* module with no MongoDB or fs
 * dependency: it is the gate the drop-in `fs/mirrored.ts` consults on every
 * mutating call, so it must be allocation-light and side-effect-free. The
 * Mongo-backed loader that populates it from `FolderDoc.mirrors` lives in
 * `fs/mirror-config.ts`; tests drive it directly via `setMirrorRoots`.
 *
 * The registry is intentionally independent of the `root.ts` path jail. Mirror
 * roots are operator-configured in library settings and trusted as write
 * targets on their own; resolution membership here — not the jail — is what
 * decides whether a given path replicates.
 */

import * as path from 'node:path';

/** One concrete replication target derived from a source path. */
export interface MirrorTarget {
  /** The primary library root the source path was matched under. */
  primaryRoot: string;
  /** The mirror root the path replicates to. */
  mirrorRoot: string;
  /** The absolute path under `mirrorRoot` corresponding to the source path. */
  mirrorPath: string;
}

/** Normalized primary root → list of normalized mirror roots. */
let _mirrors: Map<string, string[]> = new Map();

/** Strip a trailing separator and resolve to an absolute, normalized path. */
function normalizeRoot(p: string): string {
  const resolved = path.resolve(p);
  // path.resolve already drops a trailing slash except for the fs root "/".
  return resolved;
}

/**
 * Replace the entire registry. `config` maps a primary library root to its
 * mirror roots; empty mirror lists are dropped so `isMirroringActive` stays
 * cheap and accurate. Called by the config loader at startup and whenever a
 * library's mirror set changes.
 */
export function setMirrorRoots(
  config: ReadonlyMap<string, readonly string[]> | Record<string, readonly string[]>,
): void {
  const entries: Iterable<[string, readonly string[]]> =
    config instanceof Map ? config.entries() : Object.entries(config);
  const next = new Map<string, string[]>();
  for (const [primary, mirrors] of entries) {
    const normMirrors = mirrors.map(normalizeRoot).filter((m) => m.length > 0);
    if (normMirrors.length === 0) continue;
    next.set(normalizeRoot(primary), normMirrors);
  }
  _mirrors = next;
}

/** Drop all mirror configuration (used by tests and on teardown). */
export function clearMirrorRoots(): void {
  _mirrors = new Map();
}

/** Cheap check the hot path uses to skip all resolution when nothing is mirrored. */
export function isMirroringActive(): boolean {
  return _mirrors.size > 0;
}

/** True when `child` is `root` itself or lives beneath it. */
function isUnder(root: string, child: string): boolean {
  if (child === root) return true;
  const withSep = root.endsWith(path.sep) ? root : root + path.sep;
  return child.startsWith(withSep);
}

/**
 * Resolve every mirror path for an absolute source path. Returns `[]` when the
 * path is not under any mirrored primary root (the common case for temp dirs,
 * `/tmp` staging, or libraries with no mirror configured).
 *
 * When primary roots nest, the longest matching root wins so the relative
 * segment is computed against the most specific library.
 */
export function resolveMirrorTargets(absSourcePath: string): MirrorTarget[] {
  if (_mirrors.size === 0) return [];
  const abs = path.resolve(absSourcePath);

  // Longest-prefix match across configured primary roots.
  let bestRoot: string | null = null;
  for (const root of _mirrors.keys()) {
    if (isUnder(root, abs) && (bestRoot === null || root.length > bestRoot.length)) {
      bestRoot = root;
    }
  }
  if (bestRoot === null) return [];

  const rel = path.relative(bestRoot, abs); // "" when abs === bestRoot
  const mirrors = _mirrors.get(bestRoot)!;
  return mirrors.map((mirrorRoot) => ({
    primaryRoot: bestRoot!,
    mirrorRoot,
    mirrorPath: rel === '' ? mirrorRoot : path.join(mirrorRoot, rel),
  }));
}

/** A snapshot of the configured primary→mirror map (for diagnostics/tests). */
export function snapshotMirrorRoots(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [primary, mirrors] of _mirrors) out[primary] = [...mirrors];
  return out;
}
