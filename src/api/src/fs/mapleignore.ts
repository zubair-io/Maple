/**
 * The `.mapleignore` folder marker (#5398): an operator-created file that
 * excludes its directory and the whole subtree from the index.
 *
 * One rule decides what counts as a marker everywhere: an `lstat` of the exact
 * name that finds a regular file. A directory or a symlink of that name is not
 * a marker, and case matching follows the volume — so the sweep, the ingest
 * chokepoint, the reaper and the listings can never disagree about one folder.
 *
 * The verdict is three-valued on purpose. A marker stat that errors (EACCES,
 * EIO, a share timing out) is `unknown`, never `ignored`; each caller resolves
 * `unknown` in its own safe direction, so a transient error can never read as
 * an exclusion.
 */
import * as path from 'node:path';
import * as fs from './mirrored.ts';
import { errnoCode } from './errno-code.ts';

export const MAPLE_IGNORE_MARKER = '.mapleignore';

/** `missing_reason` on a location the marker excluded. Its file is still on
 * disk, so nothing may treat the location as one to act on. */
export const MAPLE_IGNORE_MISSING_REASON = 'mapleignore';

/** True for a location the marker excluded: its original still sits in the
 * ignored folder, so no trash, move or rename may pick it. */
export function isExcludedLocation(entry: { missing_reason?: string | null }): boolean {
  return entry.missing_reason === MAPLE_IGNORE_MISSING_REASON;
}

export type IgnoreVerdict = 'ignored' | 'indexed' | 'unknown';

type MarkerStat = 'present' | 'absent' | 'error';

async function markerIn(dir: string): Promise<MarkerStat> {
  try {
    return (await fs.lstat(path.join(dir, MAPLE_IGNORE_MARKER))).isFile() ? 'present' : 'absent';
  } catch (err) {
    return errnoCode(err) === 'ENOENT' ? 'absent' : 'error';
  }
}

/**
 * Whether the library directory `relDir` (POSIX, relative to `root`, `''` for
 * the root) sits under a marker at the root or any ancestor down to itself. A
 * directory that does not exist yet finds no marker below its last existing
 * ancestor.
 */
export async function ignoreVerdict(root: string, relDir: string): Promise<IgnoreVerdict> {
  const segments = relDir === '' ? [] : relDir.split('/');
  const dirs = [root, ...segments.map((_, i) => path.join(root, ...segments.slice(0, i + 1)))];
  const markers = await Promise.all(dirs.map(markerIn));
  if (markers.includes('present')) return 'ignored';
  return markers.includes('error') ? 'unknown' : 'indexed';
}

/** As {@link ignoreVerdict}, for an absolute directory. A path outside `root`
 * answers `indexed`; callers reject an escaping path through their own
 * containment check. */
export async function ignoreVerdictForDir(root: string, absDir: string): Promise<IgnoreVerdict> {
  const relDir = path.relative(root, absDir);
  if (relDir === '..' || relDir.startsWith(`..${path.sep}`) || path.isAbsolute(relDir)) {
    return 'indexed';
  }
  return ignoreVerdict(root, relDir.split(path.sep).join('/'));
}

export function ignoreVerdictForFile(root: string, absPath: string): Promise<IgnoreVerdict> {
  return ignoreVerdictForDir(root, path.dirname(absPath));
}

/** `dir`'s own marker only, no ancestor walk. */
export async function directoryHasIgnoreMarker(dir: string): Promise<boolean> {
  return (await markerIn(dir)) === 'present';
}

/** For walkers that already hold `dir`'s listing: the listing only nominates
 * a candidate (case-insensitively, since the volume may be), and the shared
 * `lstat` rule decides, so the common no-marker case costs no extra I/O. */
export async function listingHasIgnoreMarker(
  dir: string,
  names: readonly string[],
): Promise<boolean> {
  return (
    names.some((name) => name.toLowerCase() === MAPLE_IGNORE_MARKER) &&
    directoryHasIgnoreMarker(dir)
  );
}

/**
 * The on-disk guard every operation that moves, renames or trashes an
 * original runs right before acting: true unless the file's directory chain
 * verifiably holds no marker. It reads the disk, not the location's tag, so a
 * tag that is stale or wrong can never let an ignored original move.
 */
export async function refusesMoveUnderMarker(
  root: string,
  relDir: string,
  memo?: IgnoreVerdictMemo,
): Promise<boolean> {
  const verdict = await (memo ? memo.verdict(root, relDir) : ignoreVerdict(root, relDir));
  return verdict !== 'indexed';
}

/** Per-pass memo for the reaper, which can ask about thousands of entries
 * sharing a handful of directories. */
export class IgnoreVerdictMemo {
  private readonly verdicts = new Map<string, Promise<IgnoreVerdict>>();

  verdict(root: string, relDir: string): Promise<IgnoreVerdict> {
    const key = `${root}\0${relDir}`;
    const cached = this.verdicts.get(key) ?? ignoreVerdict(root, relDir);
    this.verdicts.set(key, cached);
    return cached;
  }
}
