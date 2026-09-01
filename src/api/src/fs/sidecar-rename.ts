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
 * the sidecar's name doesn't start with the RAW's old base.
 *
 * The prefix match is case-INSENSITIVE, mirroring `listPairedSidecars`'
 * (`fs/xmp-conflict.ts`) own case-insensitive `'i'`-flagged regex: a
 * sidecar whose STORED casing differs from the RAW's own base (RAW
 * `IMG.CR3` + sidecar `img.xmp`, say) is exactly what `listPairedSidecars`
 * already treats as paired. A case-SENSITIVE `startsWith` here silently
 * dropped that pairing — the primary would rename but the sidecar would be
 * orphaned, never following it (found in review on #2704: most visible via
 * the new case-only-rename path, which renames a RAW specifically FOR a
 * case change, but the bug predates that path). The slice-by-length below
 * still lines up: a case-insensitive prefix match is the same LENGTH as
 * the case-sensitive one would have been. */
export function sidecarRenameTarget(
  oldAbsPath: string,
  newAbsPath: string,
  sidecarAbsPath: string,
): string | null {
  const oldBase = path.basename(oldAbsPath, path.extname(oldAbsPath));
  const newBase = path.basename(newAbsPath, path.extname(newAbsPath));
  const sidecarName = path.basename(sidecarAbsPath);
  const prefix = sidecarName.slice(0, oldBase.length);
  if (prefix.length !== oldBase.length || prefix.toLowerCase() !== oldBase.toLowerCase()) {
    return null;
  }
  const renamed = newBase + sidecarName.slice(oldBase.length);
  return path.join(path.dirname(newAbsPath), renamed);
}
