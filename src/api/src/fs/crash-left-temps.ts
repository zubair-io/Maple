import * as path from 'node:path';
import { child as childLogger } from '../log.ts';
import * as fs from './mirrored.ts';
import { parsePrivateSibling } from './private-sibling.ts';

const log = childLogger('fs/crash-left-temps');

/** A live relocation keeps writing to its temp; one untouched this long was
 * abandoned by a process that died mid-relocation, on this host or another
 * one sharing the volume. */
const IDLE_BEFORE_ABANDONED_MS = 24 * 60 * 60 * 1000;

interface DirectoryEntry {
  name: string;
  isFile(): boolean;
}

/** Removes the private siblings a crashed relocation left in `dir` (#5136),
 * each only when its bytes provably live somewhere else: a verifying copy, or
 * any other sibling that is a hard link of the file it sits beside. A displaced
 * photo or moved-aside file with no second name may be the only copy, so it
 * stays. Returns how many were removed. */
export async function sweepCrashLeftTemps(
  dir: string,
  entries: readonly DirectoryEntry[],
): Promise<number> {
  const now = Date.now();
  const outcomes = await Array.fromAsync(entries, (entry) => removeIfCrashLeft(dir, entry, now));
  const removed = outcomes.filter(Boolean).length;
  if (removed > 0) log.info({ dir, removed }, 'removed temp files left by a crashed relocation');
  return removed;
}

async function removeIfCrashLeft(
  dir: string,
  entry: DirectoryEntry,
  now: number,
): Promise<boolean> {
  const sibling = entry.isFile() ? parsePrivateSibling(entry.name) : null;
  if (!sibling || sibling.pid === process.pid) return false;
  const file = path.join(dir, entry.name);
  const stat = await fs.lstat(file, { bigint: true }).catch(() => null);
  if (!stat?.isFile() || now - Number(stat.mtimeMs) < IDLE_BEFORE_ABANDONED_MS) return false;
  const redundant =
    sibling.verifyingCopy || (await isHardLinkOf(stat, path.join(dir, sibling.base)));
  return (
    redundant &&
    (await fs.unlink(file).then(
      () => true,
      () => false,
    ))
  );
}

async function isHardLinkOf(stat: { dev: bigint; ino: bigint }, beside: string): Promise<boolean> {
  const other = await fs.lstat(beside, { bigint: true }).catch(() => null);
  return other?.isFile() === true && other.dev === stat.dev && other.ino === stat.ino;
}
