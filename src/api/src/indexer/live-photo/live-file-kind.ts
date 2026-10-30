import * as path from 'node:path';

/** Which half of an Apple Live Photo a file can be: the still image or the motion clip. */
export type LiveFileKind = 'still' | 'clip';

const STILL_EXTENSIONS = new Set(['.jpg', '.jpeg', '.heic', '.heif']);
const CLIP_EXTENSIONS = new Set(['.mov']);

export function liveFileKind(filename: string): LiveFileKind | null {
  const extension = path.extname(filename).toLowerCase();
  if (STILL_EXTENSIONS.has(extension)) return 'still';
  return CLIP_EXTENSIONS.has(extension) ? 'clip' : null;
}

/** The case-folded name without its extension: the nomination key a still and a clip share. */
export function liveStem(filename: string): string {
  return path.parse(filename).name.toLowerCase();
}
