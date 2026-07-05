import * as fs from './mirrored.ts';

/**
 * Get the path to the .hidden marker file for the given asset path.
 * The marker file is a sibling of the original photo.
 */
export function hiddenMarkerPath(absPath: string): string {
  return `${absPath}.hidden`;
}

/**
 * Write the .hidden marker file on disk. Uses the atomic pattern:
 * write to <marker>.tmp.<pid> first, then rename it into place,
 * so it replicates to backup mirrors.
 */
export async function writeHiddenMarker(absPath: string): Promise<void> {
  const marker = hiddenMarkerPath(absPath);
  const tmp = `${marker}.tmp.${process.pid}`;
  try {
    await fs.writeFile(tmp, '');
    await fs.rename(tmp, marker);
  } catch {
    // Best-effort, swallow errors.
  }
}

/**
 * Remove the .hidden marker file if it exists.
 */
export async function removeHiddenMarker(absPath: string): Promise<void> {
  const marker = hiddenMarkerPath(absPath);
  try {
    await fs.unlink(marker);
  } catch {
    // Best-effort, swallow errors.
  }
}

/**
 * Check if the .hidden marker file exists for the given asset.
 */
export async function hasHiddenMarker(absPath: string): Promise<boolean> {
  const marker = hiddenMarkerPath(absPath);
  try {
    await fs.access(marker);
    return true;
  } catch {
    return false;
  }
}
