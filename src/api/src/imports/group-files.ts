/**
 * Pairing of an import's flat file list into primaries (image/movie) and the
 * sidecars that follow each one.
 */

import path from 'node:path';
import { canonicalBaseFromSidecarFilename } from '../fs/browse.ts';
import type { ImportFileEntry } from '../db/schema.ts';

interface FileGroups {
  /** Indices of primary entries (image/movie), in files[] order. */
  primaries: number[];
  /** primary index → its sidecar entry indices. */
  sidecars: Map<number, number[]>;
}

/**
 * Group a flat files[] by primary: each primary (image/movie) maps to its
 * sidecars, paired on destination directory + the key its sidecar resolves to
 * (image stem for `IMG_1.xmp`, full video filename for `clip.mov.xmp`). Pure —
 * unit tested directly.
 */
export function groupFiles(files: ImportFileEntry[]): FileGroups {
  const primaries: number[] = [];
  const primaryByKey = new Map<string, number>();
  const sidecars = new Map<number, number[]>();

  // Register every primary and the key its sidecar resolves to. Videos use the
  // full-name sidecar convention (`clip.mov.xmp`), so they key on the full
  // filename, not the stem — a Live Photo's motion clip can never collide with
  // its same-stem still (M5 — #1635). Single pass: distinct keys, no contest.
  files.forEach((f, i) => {
    if (f.kind === 'sidecar') return;
    primaries.push(i);
    sidecars.set(i, []);
    const dir = path.posix.dirname(f.dest);
    const name = path.posix.basename(f.dest);
    const base = f.kind === 'movie' ? name : path.posix.basename(name, path.posix.extname(name));
    primaryByKey.set(`${dir}\0${base}`, i);
  });

  files.forEach((f, i) => {
    if (f.kind !== 'sidecar') return;
    const dir = path.posix.dirname(f.dest);
    const base = canonicalBaseFromSidecarFilename(path.posix.basename(f.dest));
    const parent = base ? primaryByKey.get(`${dir}\0${base}`) : undefined;
    // buildImportFiles only emits sidecars attached to a primary, so this is
    // defensive — an unattachable sidecar is dropped rather than copied.
    if (parent !== undefined) sidecars.get(parent)!.push(i);
  });

  return { primaries, sidecars };
}
