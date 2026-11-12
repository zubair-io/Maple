// Names for a RAW+JPEG stack's two files (#5050). A pair is one tile but two
// file operations; these keep the two files on one stem. Pure functions.

function splitExt(filename: string): { stem: string; ext: string } {
  const dot = filename.lastIndexOf('.');
  return dot > 0
    ? { stem: filename.slice(0, dot), ext: filename.slice(dot) }
    : { stem: filename, ext: '' };
}

/** The companion's name after its RAW is renamed: the RAW's new stem, the companion's own extension. */
export function companionFilenameFor(companionName: string, rawNewFilename: string): string {
  return `${splitExt(rawNewFilename).stem}${splitExt(companionName).ext}`;
}

/** Highest `.N` suffix tried, matching the server's `pickFreePath`. */
const MAX_SUFFIX = 1000;

/**
 * Keep Both for a pair: the first `<stem>.N` (the server's suffix shape) that
 * is free for the RAW, the JPEG and the `<stem>.N.xmp` sidecar they share, so
 * neither file is planned before both have a name. `occupied` holds the
 * destination folder's names in lower case; the comparison is case-insensitive
 * because the library may sit on a case-insensitive volume. Returns the RAW's
 * filename, or `null` when every suffix is taken; the JPEG follows with
 * `companionFilenameFor`.
 */
export function freePairFilename(
  occupied: ReadonlySet<string>,
  rawFilename: string,
  companionName: string,
): string | null {
  const { stem, ext } = splitExt(rawFilename);
  const companionExt = splitExt(companionName).ext;
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const candidate = `${stem}.${n}`;
    const names = [`${candidate}${ext}`, `${candidate}${companionExt}`, `${candidate}.xmp`];
    if (names.every((name) => !occupied.has(name.toLowerCase()))) return names[0]!;
  }
  return null;
}
