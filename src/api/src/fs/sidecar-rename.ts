/**
 * Sidecar base-swap (#2629) — shared with `moveSidecarsAlongside` in
 * `fs/trash.ts`. Split out of `fs/relocate.ts` (#2704) so
 * `fs/relocate-case-only-rename.ts` can reuse it without creating a
 * circular import between that file and `relocate.ts`.
 */
import * as path from 'node:path';
import { isVideoFilename } from '../indexer/media-types';
import { isLegacyBackupSidecarOf, legacyBackupSidecar } from './legacy-backup-sidecar.ts';

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
  // A pre-#5021 `IMG.HEIC.xmp` follows the new full name, not a stem swap (#5063).
  if (isLegacyBackupSidecarOf(oldAbsPath, sidecarAbsPath)) return legacyBackupSidecar(newAbsPath);
  const oldBase = path.basename(
    oldAbsPath,
    isVideoFilename(oldAbsPath) ? '' : path.extname(oldAbsPath),
  );
  const newBase = path.basename(
    newAbsPath,
    isVideoFilename(newAbsPath) ? '' : path.extname(newAbsPath),
  );
  return swapBase(newAbsPath, sidecarAbsPath, oldBase, newBase);
}

/** Derived previews keep the historical stem-based naming convention, including videos. */
export function companionRenameTarget(oldPath: string, newPath: string, companion: string): string {
  return (
    swapBase(newPath, companion, path.parse(oldPath).name, path.parse(newPath).name) ??
    path.join(path.dirname(newPath), path.basename(companion))
  );
}

function swapBase(
  newAbsPath: string,
  sidecarAbsPath: string,
  oldBase: string,
  newBase: string,
): string | null {
  const sidecarName = path.basename(sidecarAbsPath);
  const prefixLen = matchingBaseLength(sidecarName, oldBase);
  if (prefixLen === null) return null;
  const renamed = newBase + sidecarName.slice(prefixLen);
  return path.join(path.dirname(newAbsPath), renamed);
}

function matchingBaseLength(sidecarName: string, oldBase: string): number | null {
  const prefix = sidecarName.slice(0, oldBase.length);
  if (
    prefix.length === oldBase.length &&
    prefix.toLowerCase() === oldBase.toLowerCase() &&
    !/^\p{M}/u.test(sidecarName.slice(oldBase.length))
  ) {
    return oldBase.length;
  }
  const target = oldBase.normalize('NFC').toLowerCase();
  for (let len = 1; len <= sidecarName.length; len++) {
    if (/^\p{M}/u.test(sidecarName.slice(len))) continue;
    if (sidecarName.slice(0, len).normalize('NFC').toLowerCase() === target) return len;
  }
  return null;
}
