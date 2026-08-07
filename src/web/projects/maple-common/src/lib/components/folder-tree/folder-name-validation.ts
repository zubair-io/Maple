// folder-name-validation.ts — light client-side UX pre-check for New
// Folder / Rename (#2643).
//
// This is deliberately NOT the authoritative rule set. The shared rule set
// (Windows-reserved device names, trailing dots/spaces, etc.) lives in the
// Rust `raw-core` filename-validation engine; the API validates through it
// on every mkdir/move call. This check only covers the cases cheap enough
// to catch before a round-trip — non-empty, no path separator, not a `.`/
// `..` traversal component — so the dialog can disable its confirm button
// with an inline explanation instead of round-tripping an obviously-bad
// name. Any rejection the server returns beyond this (reserved names,
// trailing dots, a name collision) is surfaced from the HTTP error, not
// pre-empted here.

/** Returns `null` when `raw` passes the light pre-check, or a short
 * user-facing explanation of why it doesn't. */
export function validateFolderNameDraft(raw: string): string | null {
  const name = raw.trim();
  if (name.length === 0) return "Name can't be empty.";
  if (name.includes('/')) return 'Name can’t contain "/".';
  if (name === '.' || name === '..') return `"${name}" isn’t a valid folder name.`;
  return null;
}
