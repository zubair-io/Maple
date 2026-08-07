/**
 * Split a filename into stem + extension (extension includes the leading
 * dot, e.g. `'.dng'`). A name with no dot, or a dot only at position 0 (a
 * hidden-file-style leading dot with no other dot, e.g. `.gitignore`), has
 * no extension by this rule — the whole string is the stem.
 *
 * Backs the inline-rename field's "extension preserved by default" default
 * selection (design doc: docs/superpowers/specs/2026-08-04-file-management-design.md
 * § "Rename") and its extension-change warning.
 */
export function splitFilenameExt(filename: string): { stem: string; ext: string } {
  const idx = filename.lastIndexOf('.');
  if (idx <= 0) return { stem: filename, ext: '' };
  return { stem: filename.slice(0, idx), ext: filename.slice(idx) };
}
