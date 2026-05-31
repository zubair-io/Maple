/**
 * Pure destination-layout helpers for the Imports feature (ticket #742).
 *
 * Layout:  <YEAR>/<MM-or-label>/<filename>
 *
 *   - YEAR / MM come from a file's mtime, in **UTC** (parity with
 *     `backup/path-formatter.ts`, which also buckets on UTC wall-clock).
 *   - The middle segment defaults to the two-digit month but is a
 *     user-editable, path-safe free-text label.
 *
 * No Mongo, no filesystem — these are the safety + assembly primitives the
 * scan/copy/worker layers and the create route all funnel through, so the
 * traversal guard can't be bypassed by one caller forgetting it.
 *
 * Deliberately NOT routed through `formatBackupPath`: that formatter emits a
 * `<MM>-<DD>` (or `.../MM-DD`) day segment we don't want here.
 */

import { isSafeFilename } from '../backup/path-formatter.ts';

export interface Bucket {
  /** 4-digit UTC year, zero-padded. */
  year: string;
  /** 2-digit UTC month, zero-padded. Also the default bucket label. */
  mm: string;
}

/** Derive the `{ year, mm }` bucket for a file from its mtime (epoch ms, UTC). */
export function bucketForMtime(mtimeMs: number): Bucket {
  const d = new Date(mtimeMs);
  const year = d.getUTCFullYear().toString().padStart(4, '0');
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  return { year, mm };
}

/**
 * Validate a user-supplied bucket label as a single safe directory segment.
 *
 * A label becomes a directory name on disk, so it is a path-traversal vector.
 * This is the server-side guard the create route reuses — never trust a
 * client-validated label.
 *
 * Allowed: ordinary free text including internal spaces and unicode
 * (e.g. `Vacation 2024`, `March — Iceland`).
 * Rejected: empty / whitespace-only, > 255 chars, path separators, `.`/`..`,
 * a leading dot, and any ASCII control character (NUL, tab, newline, …).
 */
export function isSafeLabel(label: string): boolean {
  if (!label || label.length === 0 || label.length > 255) return false;
  if (label.trim().length === 0) return false;
  if (label.includes('/') || label.includes('\\')) return false;
  if (label === '.' || label === '..') return false;
  if (label.startsWith('.')) return false;
  // Reject C0 control chars (0x00–0x1F) and DEL (0x7F).
  for (let i = 0; i < label.length; i++) {
    const code = label.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

/**
 * Assemble the library-root-relative destination path
 * `<year>/<label>/<filename>` (POSIX separators).
 *
 * Throws if the label or filename is unsafe — every caller building a
 * destination goes through here, so an unsafe segment can never reach the
 * filesystem.
 */
export function destRelPath(args: { year: string; label: string; filename: string }): string {
  if (!isSafeLabel(args.label)) {
    throw new Error(`unsafe import bucket label: ${JSON.stringify(args.label)}`);
  }
  if (!isSafeFilename(args.filename)) {
    throw new Error(`unsafe filename: ${JSON.stringify(args.filename)}`);
  }
  return `${args.year}/${args.label}/${args.filename}`;
}
