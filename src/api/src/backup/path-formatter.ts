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
 * Spec: docs/superpowers/specs/2026-05-09-photokit-backup-design.md §9.
 */
export function formatBackupPath(args: {
  captureDate: Date;
  location: string | null;
  filename: string;
}): string {
  const y = args.captureDate.getUTCFullYear().toString().padStart(4, "0");
  const m = (args.captureDate.getUTCMonth() + 1).toString().padStart(2, "0");
  const d = args.captureDate.getUTCDate().toString().padStart(2, "0");

  const loc = args.location && args.location.trim().length > 0
    ? args.location.replaceAll("/", "_")
    : null;

  if (loc) return `${y}/${loc}/${m}-${d}/${args.filename}`;
  return `${y}/${m}/${d}/${args.filename}`;
}
