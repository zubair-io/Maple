/**
 * Sidecar base-swap (#2629) — shared with `moveSidecarsAlongside` in
 * `fs/trash.ts`. Split out of `fs/relocate.ts` (#2704) so
 * `fs/relocate-case-only-rename.ts` can reuse it without creating a
 * circular import between that file and `relocate.ts`.
 */
import * as path from 'node:path';

/** Compute a sidecar's destination path when its RAW moves from
 * `oldAbsPath` to `newAbsPath`, applying the SAME base-swap
 * `moveSidecarsAlongside` (`fs/trash.ts`) uses — e.g.
 * `IMG_1 (conflict from Mac).xmp` follows `IMG_1.ARW` → `IMG_1.1.ARW` to
 * `IMG_1.1 (conflict from Mac).xmp`. Returns `null` (defensive skip) when
 * the sidecar's name doesn't start with the RAW's old base. */
export function sidecarRenameTarget(
  oldAbsPath: string,
  newAbsPath: string,
  sidecarAbsPath: string,
): string | null {
  const oldBase = path.basename(oldAbsPath, path.extname(oldAbsPath));
  const newBase = path.basename(newAbsPath, path.extname(newAbsPath));
  const sidecarName = path.basename(sidecarAbsPath);
  if (!sidecarName.startsWith(oldBase)) return null;
  const renamed = newBase + sidecarName.slice(oldBase.length);
  return path.join(path.dirname(newAbsPath), renamed);
}
