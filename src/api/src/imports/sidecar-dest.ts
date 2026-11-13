/**
 * Where a sidecar lands once its image or movie has: beside it, under the name
 * it resolved to. If an on-disk collision renamed `IMG.dng` to `IMG-1.dng`, the
 * sidecar must become `IMG-1.xmp` or the edits detach from their image.
 */

import path from 'node:path';

/** POSIX stem (basename without extension) of a rel path. */
function stemOf(destRel: string): string {
  const base = path.posix.basename(destRel);
  return base.slice(0, base.length - path.posix.extname(base).length);
}

/**
 * Rewrite a sidecar's destination so its stem follows the image's RESOLVED
 * stem after a collision rename. The sidecar filename is
 * `<origStem><suffix>.xmp` (suffix is the optional ` (conflict from …)` part);
 * only the leading stem is swapped, preserving the conflict-copy suffix.
 *
 *   remapSidecarDest('2024/03/IMG.xmp', 'IMG', 'IMG-1')
 *     → '2024/03/IMG-1.xmp'
 *   remapSidecarDest('2024/03/IMG (conflict from Mac).xmp', 'IMG', 'IMG-1')
 *     → '2024/03/IMG-1 (conflict from Mac).xmp'
 */
function remapSidecarDest(sidecarDestRel: string, origStem: string, newStem: string): string {
  const dir = path.posix.dirname(sidecarDestRel);
  const filename = path.posix.basename(sidecarDestRel);
  // The sidecar's canonical base equals origStem (it was paired on that), so
  // the filename starts with origStem. Swap just that prefix.
  const rest = filename.startsWith(origStem) ? filename.slice(origStem.length) : filename;
  return dir === '.' ? `${newStem}${rest}` : `${dir}/${newStem}${rest}`;
}

function besideLanded(sidecarDest: string, primaryDest: string, landedDest: string): string {
  const planned = stemOf(primaryDest);
  const landed = stemOf(landedDest);
  return planned === landed ? sidecarDest : remapSidecarDest(sidecarDest, planned, landed);
}

export interface SidecarDest {
  index: number;
  destRel: string;
}

export function sidecarDestsBeside(
  files: readonly { dest: string }[],
  primaryIndex: number,
  sidecarIndexes: readonly number[],
  landedDest: string,
): SidecarDest[] {
  return sidecarIndexes.map((index) => ({
    index,
    destRel: besideLanded(files[index].dest, files[primaryIndex].dest, landedDest),
  }));
}

/** The sidecars whose row still names the destination planned before the primary was renamed. */
export function renamedSidecars(
  files: readonly { dest: string }[],
  dests: readonly SidecarDest[],
): SidecarDest[] {
  return dests.filter((sidecar) => sidecar.destRel !== files[sidecar.index].dest);
}
