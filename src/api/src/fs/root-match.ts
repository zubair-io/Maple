/**
 * Library-root containment — the single rule for "is this absolute path
 * inside that registered root, and if so, where?" (#3094).
 *
 * Two ways a hand-rolled prefix check gets this wrong, both of which have
 * shipped in this codebase:
 *
 *   1. No separator boundary. `abs.startsWith(root)` matches `…/lib` against
 *      `…/lib2/IMG.CR2`, so a file in one library resolves to a sibling
 *      library that merely shares a name prefix — the caller then reads the
 *      wrong `folder_id` and the wrong asset id.
 *   2. A hardcoded `'/'` boundary. On a Windows-hosted server absolute paths
 *      arrive backslashed, so `root + '/'` never matches and every call fails
 *      the containment check instead (that was #2741's trash bug).
 *
 * `path.relative` avoids both: it is separator-correct on each platform and
 * normalises mixed separators on Windows, and an escaping result is
 * unambiguous (`..` or an absolute path). It is the rule `fs/root.ts`'s jail
 * already applies; these helpers make it reusable rather than re-derived.
 *
 * Pure — no I/O, no symlink resolution. Callers that need symlink-safety
 * resolve the real path first (see `checkAllowed` in `fs/root.ts`).
 */

import * as path from 'node:path';

/**
 * `abs`'s location relative to `root` in POSIX form (`'a/b/x.dng'`), or
 * `null` when `abs` is not inside `root`.
 *
 * Returns `''` when `abs` IS the root. That is containment, not an asset —
 * callers that only accept files must reject the empty string explicitly.
 */
export function relativeUnderRoot(root: string, abs: string): string | null {
  const rel = path.relative(root, abs);
  const escapes = rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  return escapes ? null : rel.split(path.sep).join('/');
}

/**
 * The most specific (deepest) registered root containing `abs`, paired with
 * the caller's key for it.
 *
 * Registration only rejects an exact duplicate path (`POST /api/folders`), so
 * one library can legally sit inside another (`/srv/photos` and
 * `/srv/photos/2024`). A first-match scan would attribute a file to whichever
 * root the caller happened to list first — for Mongo-backed roots that is
 * natural document order, i.e. registration order. Deepest-wins makes the
 * answer independent of that ordering.
 */
export function mostSpecificRoot<T>(
  abs: string,
  roots: Iterable<readonly [T, string]>,
): { key: T; root: string; relPath: string } | null {
  const matches = [...roots]
    .map(([key, root]) => ({ key, root, relPath: relativeUnderRoot(root, abs) }))
    .filter((m): m is { key: T; root: string; relPath: string } => m.relPath !== null);
  if (matches.length === 0) return null;
  // When two roots both contain `abs`, one is nested inside the other, so the
  // deeper root's relative path is a strict suffix of the shallower one's —
  // shortest relPath is therefore exactly "deepest root".
  return matches.reduce((best, m) => (m.relPath.length < best.relPath.length ? m : best));
}
