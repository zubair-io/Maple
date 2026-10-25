/**
 * The `.mapleignore` folder marker (#5398): an operator-created file whose
 * presence in a library directory excludes that directory and its whole
 * subtree from the index.
 *
 * This module is the shared "is this directory ignored?" vocabulary — the
 * discover sweep, the `handleEvent` chokepoint, the missing-reaper, the upload
 * route and the library folder listing all ask it. It stays free of database
 * imports for the same reason `workers/missing-reaper.helpers.ts` does.
 *
 * The verdict is three-valued on purpose. Only a marker that stats present is
 * evidence of "ignored"; a stat error (EACCES, EIO, a share timing out) is
 * `unknown`, and each caller resolves `unknown` in its own safe direction —
 * the reaper keeps the row, the ingest chokepoint skips the event until the
 * next sweep. A transient error can therefore never read as "ignored".
 */
import * as path from 'node:path';
import * as fs from './mirrored.ts';
import { errnoCode } from './errno-code.ts';

/** Exact name of the folder-level ignore marker. */
export const MAPLE_IGNORE_MARKER = '.mapleignore';

export type IgnoreVerdict = 'ignored' | 'indexed' | 'unknown';

type MarkerStat = 'present' | 'absent' | 'error';

async function markerIn(dir: string): Promise<MarkerStat> {
  try {
    await fs.stat(path.join(dir, MAPLE_IGNORE_MARKER));
    return 'present';
  } catch (err) {
    return errnoCode(err) === 'ENOENT' ? 'absent' : 'error';
  }
}

/**
 * Whether the library directory `relDir` (POSIX, relative to `root`, `''` for
 * the root itself) sits under a `.mapleignore` marker — checked at the root and
 * at every ancestor down to `relDir` itself. A directory that does not exist
 * yet (an upload about to create it) simply finds no marker below the last
 * existing ancestor.
 */
export async function ignoreVerdict(root: string, relDir: string): Promise<IgnoreVerdict> {
  const segments = relDir === '' ? [] : relDir.split('/');
  const dirs = [root, ...segments.map((_, i) => path.join(root, ...segments.slice(0, i + 1)))];
  let uncertain = false;
  for (const dir of dirs) {
    const marker = await markerIn(dir);
    if (marker === 'present') return 'ignored';
    if (marker === 'error') uncertain = true;
  }
  return uncertain ? 'unknown' : 'indexed';
}

/** As {@link ignoreVerdict}, for an absolute directory under `root`. A path
 * outside `root` has no marker chain to consult and answers `indexed`; callers
 * reject an escaping path through their own containment check. */
export async function ignoreVerdictForDir(root: string, absDir: string): Promise<IgnoreVerdict> {
  const relDir = path.relative(root, absDir);
  if (relDir === '..' || relDir.startsWith(`..${path.sep}`) || path.isAbsolute(relDir)) {
    return 'indexed';
  }
  return ignoreVerdict(root, relDir.split(path.sep).join('/'));
}

/** As {@link ignoreVerdictForDir}, for the directory holding `absPath`. */
export function ignoreVerdictForFile(root: string, absPath: string): Promise<IgnoreVerdict> {
  return ignoreVerdictForDir(root, path.dirname(absPath));
}

/** True when `dir`'s own marker stats present (no ancestor walk). */
export async function directoryHasIgnoreMarker(dir: string): Promise<boolean> {
  return (await markerIn(dir)) === 'present';
}

/**
 * Per-pass memo for callers that ask about many files sharing directories
 * (the reaper examines up to thousands of tagged entries a pass).
 */
export class IgnoreVerdictMemo {
  private readonly verdicts = new Map<string, Promise<IgnoreVerdict>>();

  verdict(root: string, relDir: string): Promise<IgnoreVerdict> {
    const key = `${root}\0${relDir}`;
    const cached = this.verdicts.get(key);
    if (cached) return cached;
    const pending = ignoreVerdict(root, relDir);
    this.verdicts.set(key, pending);
    return pending;
  }
}
