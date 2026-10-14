/**
 * Shared helper: resolve and authorize a caller-supplied file path against
 * registered library roots.
 *
 * Extracted from `routes/xmp.ts` so `xmp-batch.ts` can reuse it without
 * a circular dependency.
 */

import * as path from 'node:path';
import { realpath } from 'node:fs/promises';
import { parseRootList } from '../fs/root-list.ts';
import { isWithinRoot, resolveRealPath } from '../fs/root.ts';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';
import { safeWriteAllowed } from '../fs/root.ts';
import { listLibraryRoots } from '../db/repos/folders.repo.ts';
import type { SqliteDb } from '../db/repos/db-handle.ts';

/**
 * Resolve and validate a caller-supplied path.
 *
 *   ok:true  → `data` is the lexically-normalized absolute path, confirmed
 *               to be inside a registered library root.
 *   ok:false → `error` describes the failure; `status` is the HTTP status
 *               (400 for malformed, 403 for path outside any root).
 *
 * Uses `path.resolve()` (lexical) rather than `fs.realpath()` so user
 * symlinks are preserved end-to-end. Sufficient to block `..` traversal.
 */
export async function resolveAndAuthorizePath(
  raw: string | undefined,
  dbOverride?: SqliteDb,
): Promise<
  { ok: true; data: string; writeScope: string } | { ok: false; status: number; error: string }
> {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, status: 400, error: 'Missing required path' };
  }
  let decoded = raw;
  try {
    if (/%[0-9A-Fa-f]{2}/.test(raw)) decoded = decodeURIComponent(raw);
  } catch {
    return {
      ok: false,
      status: 400,
      error: 'Path is not a valid URL-encoded string',
    };
  }
  if (!path.isAbsolute(decoded)) {
    return { ok: false, status: 400, error: 'Path must be absolute' };
  }
  if (decoded.indexOf('\x00') !== -1) {
    return { ok: false, status: 400, error: 'Path contains NUL byte' };
  }

  const normalized = path.resolve(decoded);

  const envRoots = parseRootList(process.env.MAPLE_ROOTS).map((root) => path.resolve(root));
  const libRoots = dbOverride
    ? (await listLibraryRoots(dbOverride)).map((root) => root.path)
    : [...(await loadLibraryRoots()).values()];
  const normalizedLibRoots = libRoots.map((root) => path.resolve(root));
  // Normalize each root with path.resolve (strips any trailing separator,
  // cross-platform) so the containment check below is separator-correct.
  const allRoots = [...envRoots, ...normalizedLibRoots];

  if (allRoots.length === 0) {
    return {
      ok: false,
      status: 403,
      error: 'No library roots registered; cannot authorise any path',
    };
  }

  // Keep lexical authorization so callers can continue using their registered
  // symlink path. Canonicalize before selecting the admission scope: a request
  // through a nested alias and the same file through an enclosing MAPLE_ROOTS
  // path must share the broadest physical root.
  const lexicallyMatchingRoots = allRoots.filter((root) => isWithinRoot(root, normalized));
  if (lexicallyMatchingRoots.length === 0) {
    return {
      ok: false,
      status: 403,
      error: 'Path is not inside any registered library root',
    };
  }
  const canonicalPath = await canonicalPathForAdmission(normalized);
  // Canonicalize roots that could contain either spelling. Unrelated roots may
  // be on slow or unavailable network volumes and cannot affect this path's
  // admission scope.
  const relevantRoots = allRoots.filter(
    (root) => isWithinRoot(root, normalized) || isWithinRoot(root, canonicalPath),
  );
  const canonicalRoots = await Promise.all(
    relevantRoots.map((root) => realpath(root).catch(() => path.resolve(root))),
  );
  const canonicalMatchingRoots = canonicalRoots.filter((root) => isWithinRoot(root, canonicalPath));
  const lexicallyMatchingCanonicalRoots = relevantRoots.flatMap((root, index) =>
    lexicallyMatchingRoots.includes(root) ? [canonicalRoots[index]] : [],
  );
  const scopeCandidates =
    canonicalMatchingRoots.length > 0 ? canonicalMatchingRoots : lexicallyMatchingCanonicalRoots;
  const writeScope = scopeCandidates.sort((left, right) => left.length - right.length)[0];
  if (!writeScope) {
    return {
      ok: false,
      status: 403,
      error: 'Path is not inside any registered library root',
    };
  }
  return { ok: true, data: normalized, writeScope };
}

/** Resolve an existing path or preserve its missing tail below a real parent. */
async function canonicalPathForAdmission(filePath: string): Promise<string> {
  let candidate = path.resolve(filePath);
  const missingSegments: string[] = [];
  while (true) {
    try {
      return path.join(await realpath(candidate), ...missingSegments);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      missingSegments.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

export async function safeWriteAllowedForPath(filePath: string, dbOverride?: SqliteDb) {
  if (!dbOverride) return safeWriteAllowed(filePath);
  const roots = [
    ...parseRootList(process.env.MAPLE_ROOTS),
    ...(await listLibraryRoots(dbOverride)).map((root) => root.path),
  ];
  const destination = path.resolve(filePath);
  const parent = await realpath(path.dirname(destination)).catch(() => path.dirname(destination));
  const candidate = path.resolve(parent, path.basename(destination));
  const resolved = await resolveRealPath(candidate).catch(() => candidate);
  const normalizedRoots = await Promise.all(
    roots.map((root) => realpath(root).catch(() => path.resolve(root))),
  );
  return normalizedRoots.some((root) => isWithinRoot(root, resolved))
    ? { ok: true as const, data: resolved }
    : { ok: false as const, error: 'Photo is outside registered libraries' };
}
