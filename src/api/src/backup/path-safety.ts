/**
 * Path-safety helpers for client-controlled backup write paths (#854).
 *
 * PhotoKit-backup handlers assemble on-disk paths from header values the
 * device controls. `isSafeRelPath` (in the route files) guards the primary
 * rel-path, but individual filename parts (extension / suffix) and the final
 * assembled path need their own guards so a `..` can't escape the library root.
 */
import path from 'node:path';

/**
 * A single filename component — an extension or suffix such as `jpg`, `.JPEG`,
 * `mov`, or `rendered`. Blocks the path-dangerous shapes (separators and `..`
 * traversal) and control characters, while allowing the dots/dashes real
 * extensions carry. Use on `X-Maple-Suffix-Override` / `X-Maple-Filename-Ext`
 * before splicing them into a write path. (The `containedJoin` backstop is the
 * guarantee; this just rejects obviously-bad input early with a clear error.)
 */
export function isSafeFilenamePart(s: string): boolean {
  if (s.length === 0 || s.length > 32) return false;
  if (s.includes('..')) return false;
  return /^[A-Za-z0-9._-]+$/.test(s);
}

/**
 * Resolve `relPath` against `root` and return the absolute path ONLY if it
 * stays inside `root`; otherwise `null`. Canonicalises first, so `..` segments
 * and absolute paths can't escape. This is the containment backstop on every
 * backup write — it catches path-construction bugs even if an upstream guard
 * is missed.
 */
export function containedJoin(root: string, relPath: string): string | null {
  const normRoot = path.resolve(root);
  const finalPath = path.resolve(normRoot, relPath);
  if (finalPath === normRoot || finalPath.startsWith(normRoot + path.sep)) {
    return finalPath;
  }
  return null;
}
