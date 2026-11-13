import * as path from 'node:path';
import { child as childLogger } from '../log.ts';
import { surfaceDisplaced } from './displaced-keepers.ts';
import { filesIdentical } from './file-bytes.ts';
import * as fs from './mirrored.ts';
import { parsePrivateSibling, type PrivateSiblingKind } from './private-sibling.ts';

const log = childLogger('fs/crash-left-temps');

/** A live relocation keeps touching its temp; one untouched this long was
 * abandoned by a process that died mid-relocation, on this host or another
 * one sharing the volume. */
const IDLE_BEFORE_ABANDONED_MS = 24 * 60 * 60 * 1000;

const NAMELESS = 'Recovered file';

interface DirectoryEntry {
  name: string;
  isFile(): boolean;
}

type Stat = { dev: bigint; ino: bigint; nlink: bigint; mtimeMs: bigint; ctimeMs: bigint };

export interface CrashLeftOutcome {
  removed: number;
  surfaced: number;
}

/** Settles the private siblings a crashed relocation left in `dir` (#5136,
 * #5786). One whose bytes provably live under another name is removed: a
 * verifying copy, a displaced file with a visible second name in `dir` or a
 * byte-identical file beside it, or any other sibling that is a hard link of
 * the file beside it. A displaced file with no other visible name may be the
 * only copy of something, and the
 * filesystem cannot say whether the crash fell before or after the move
 * committed, so it is published under a visible name instead (`surfaceDisplaced`)
 * and the user decides. Names from builds that did not mark them stay. */
export async function sweepCrashLeftTemps(
  dir: string,
  entries: readonly DirectoryEntry[],
): Promise<CrashLeftOutcome> {
  const now = Date.now();
  const named = entries.map((entry) => entry.name);
  const settled = await Array.fromAsync(entries, (entry) => settle(dir, entry, named, now));
  const outcome = {
    removed: settled.filter((result) => result === 'removed').length,
    surfaced: settled.filter((result) => result === 'surfaced').length,
  };
  if (outcome.removed > 0) {
    log.info({ dir, removed: outcome.removed }, 'removed temp files left by a crashed relocation');
  }
  if (outcome.surfaced > 0) {
    log.warn(
      { dir, surfaced: outcome.surfaced },
      'a crashed relocation displaced files with no other copy: published under visible names',
    );
  }
  return outcome;
}

async function settle(
  dir: string,
  entry: DirectoryEntry,
  named: readonly string[],
  now: number,
): Promise<'removed' | 'surfaced' | 'left'> {
  const sibling = entry.isFile() ? parsePrivateSibling(entry.name) : null;
  if (!sibling || sibling.pid === process.pid) return 'left';
  const file = path.join(dir, entry.name);
  const stat = await fs.lstat(file, { bigint: true }).catch(() => null);
  if (!stat?.isFile() || now - lastTouched(stat) < IDLE_BEFORE_ABANDONED_MS) return 'left';
  const beside = sibling.base === '' ? null : path.join(dir, sibling.base);
  if (await isRedundant(sibling.kind, file, stat, beside, named)) {
    const gone = await fs.unlink(file).then(
      () => true,
      () => false,
    );
    return gone ? 'removed' : 'left';
  }
  if (sibling.kind !== 'displaced') return 'left';
  const original = sibling.base === '' ? `${NAMELESS}${sibling.extension}` : sibling.base;
  return (await surfaced(file, original)) ? 'surfaced' : 'left';
}

/** A rename or a link changes the change time, not the modification time, so
 * the later of the two is when a live relocation last touched the file. */
function lastTouched(stat: Stat): number {
  return Math.max(Number(stat.mtimeMs), Number(stat.ctimeMs));
}

async function isRedundant(
  kind: PrivateSiblingKind,
  file: string,
  stat: Stat,
  beside: string | null,
  named: readonly string[],
): Promise<boolean> {
  if (kind === 'verifying-copy') return true;
  if (kind === 'displaced') {
    return (
      (stat.nlink > 1n && (await hasVisibleTwin(path.dirname(file), named, stat))) ||
      (beside !== null && (await sameBytesAs(file, beside)))
    );
  }
  return beside !== null && (await isHardLinkOf(stat, beside));
}

/** A second link proves nothing by itself: it may be another private name the
 * sweep removes too, or one outside the folder that can't be checked. Only a
 * visible name in the folder holding the same file does. */
async function hasVisibleTwin(dir: string, named: readonly string[], stat: Stat): Promise<boolean> {
  for (const name of named) {
    if (parsePrivateSibling(name) !== null) continue;
    if (await isHardLinkOf(stat, path.join(dir, name))) return true;
  }
  return false;
}

const surfaced = (file: string, original: string): Promise<boolean> =>
  surfaceDisplaced(file, original).catch((err: unknown) => {
    log.error(
      { file, err: err instanceof Error ? err.message : err },
      'a displaced file could not be published under a visible name — kept at its private name',
    );
    return false;
  });

async function isHardLinkOf(stat: Stat, beside: string): Promise<boolean> {
  const other = await fs.lstat(beside, { bigint: true }).catch(() => null);
  return other?.isFile() === true && other.dev === stat.dev && other.ino === stat.ino;
}

/** A kept copy of a file that is still beside it, on a volume without hard
 * links: the bytes live there too. */
async function sameBytesAs(file: string, beside: string): Promise<boolean> {
  const other = await fs.lstat(beside).catch(() => null);
  return other?.isFile() === true && (await filesIdentical(file, beside).catch(() => false));
}
