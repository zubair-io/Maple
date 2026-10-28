/**
 * Where a stitched panorama lands in the library (#5488).
 *
 * The result sits in a `Panoramas/` folder beside the first source frame, the
 * same place the Apple apps write an on-device stitch. Its name is derived from
 * the frames, their file stamps and the options that shape the output, so asking again for the
 * same panorama finds the file the earlier run wrote instead of adding a second
 * copy, and a different selection or option never overwrites it. Overwriting
 * in place is never an option: new bytes are a new content identity, and the
 * old row would keep the path.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

export interface PanoOutputLocation {
  absPath: string;
  /** Library-relative POSIX folder; '' is the library root. */
  relDir: string;
  filename: string;
}

export interface PanoOutputIdentity {
  assetIds: readonly string[];
  /** Size and mtime of each source file, so a replaced original never reuses a stale result. */
  inputStamps: readonly string[];
  retention: string;
  localAlign: string;
  strategy: string | null;
  matcher: string;
}

function identityKey(identity: PanoOutputIdentity): string {
  const canonical = JSON.stringify([
    [...identity.assetIds].sort(),
    [...identity.inputStamps].sort(),
    identity.retention,
    identity.localAlign,
    identity.strategy,
    identity.matcher,
  ]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 8);
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** `sortedInputPaths` as `resolveInputPaths` returns them; the first names the result. */
export function panoOutputLocation(
  libraryRoot: string,
  sortedInputPaths: readonly string[],
  identity: PanoOutputIdentity,
): PanoOutputLocation {
  const first = sortedInputPaths[0];
  if (first === undefined) throw new Error('pano: no input paths to place the result beside');
  const sourceDir = path.dirname(first);
  const dir = path.join(isInside(libraryRoot, sourceDir) ? sourceDir : libraryRoot, 'Panoramas');
  const stem = path.basename(first, path.extname(first));
  const filename = `${stem}-pano-${identityKey(identity)}.png`;
  const relDir = path.relative(libraryRoot, dir).split(path.sep).join('/');
  return { absPath: path.join(dir, filename), relDir, filename };
}
