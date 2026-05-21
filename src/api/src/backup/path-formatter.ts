/**
 * Compute the destination path for a backed-up asset, relative to the
 * library root. Mirrors src/apple/Packages/MapleBackup/Sources/MapleBackup/PathFormatter.swift
 * (Phase 2 Task 2.10 adds a parity test that runs identical JSON cases
 * through both implementations and asserts byte-identical output).
 *
 * Layout:
 *   With location:    <year>/<location>/<MM>-<DD>/<filename>
 *   Without location: <year>/<MM>/<DD>/<filename>
 *
 * `/` in the location is replaced with `_` to keep the result a single
 * directory level. An empty / whitespace-only location is treated as null.
 *
 * Spec: .archived-plans/specs/2026-05-09-photokit-backup-design.md §9.
 */

/** Reject filenames that could escape the library root. Allow only a basename
 * with no path separators, no `..` segments, and no leading dot. */
export function isSafeFilename(name: string): boolean {
  if (!name || name.length === 0 || name.length > 255) return false;
  if (name.includes("/") || name.includes("\\")) return false;
  if (name === "." || name === "..") return false;
  if (name.startsWith(".")) return false;
  return true;
}

export function formatBackupPath(args: {
  captureDate: Date;
  location: string | null;
  filename: string;
}): string {
  if (!isSafeFilename(args.filename)) {
    throw new Error(`unsafe filename: ${args.filename}`);
  }

  const y = args.captureDate.getUTCFullYear().toString().padStart(4, "0");
  const m = (args.captureDate.getUTCMonth() + 1).toString().padStart(2, "0");
  const d = args.captureDate.getUTCDate().toString().padStart(2, "0");

  let loc: string | null = null;
  if (args.location && args.location.trim().length > 0) {
    const replaced = args.location.replaceAll("/", "_");
    // If the sanitised location starts with `.` or equals `..`, treat as null.
    if (!replaced.startsWith(".") && replaced !== "..") {
      loc = replaced;
    }
  }

  if (loc) return `${y}/${loc}/${m}-${d}/${args.filename}`;
  return `${y}/${m}/${d}/${args.filename}`;
}
