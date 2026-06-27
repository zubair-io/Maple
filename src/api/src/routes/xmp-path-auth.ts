/**
 * Shared helper: resolve and authorize a caller-supplied file path against
 * registered library roots.
 *
 * Extracted from `routes/xmp.ts` so `xmp-batch.ts` can reuse it without
 * a circular dependency.
 */

import * as path from 'node:path';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';

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
): Promise<{ ok: true; data: string } | { ok: false; status: number; error: string }> {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, status: 400, error: 'Missing required path' };
  }
  let decoded = raw;
  try {
    if (/%[0-9A-Fa-f]{2}/.test(raw)) decoded = decodeURIComponent(raw);
  } catch {
    return { ok: false, status: 400, error: 'Path is not a valid URL-encoded string' };
  }
  if (!path.isAbsolute(decoded)) {
    return { ok: false, status: 400, error: 'Path must be absolute' };
  }
  if (decoded.indexOf('\x00') !== -1) {
    return { ok: false, status: 400, error: 'Path contains NUL byte' };
  }

  const normalized = path.resolve(decoded);

  const envRoots = process.env.MAPLE_ROOTS
    ? process.env.MAPLE_ROOTS.split(':').filter(Boolean)
    : [];
  const libRoots = [...(await loadLibraryRoots()).values()];
  // Normalize each root with path.resolve (strips any trailing separator,
  // cross-platform) so the containment check below is separator-correct.
  const allRoots = [...envRoots, ...libRoots].map((r) => path.resolve(r));

  if (allRoots.length === 0) {
    return {
      ok: false,
      status: 403,
      error: 'No library roots registered; cannot authorise any path',
    };
  }

  for (const root of allRoots) {
    if (normalized === root || normalized.startsWith(root + '/')) {
      return { ok: true, data: normalized };
    }
  }
  return {
    ok: false,
    status: 403,
    error: 'Path is not inside any registered library root',
  };
}
