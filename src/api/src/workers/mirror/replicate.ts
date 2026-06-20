/**
 * Pure file-replication helpers shared by the mirror copy worker and the
 * mirror-scan detector. No Mongo, no queue — just "is the mirror stale?" and
 * "copy the primary onto the mirror, atomically + mtime-faithfully". Kept
 * separate so both are unit-testable on a temp dir.
 *
 * These deliberately use the real `node:fs/promises`, NOT the mirror-aware
 * drop-in: we are writing *to* the mirror here, so re-mirroring would recurse.
 */

import { mkdir, copyFile, stat, utimes, open, rename, unlink } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Decide whether the mirror needs (re)replicating from the primary. True when
 * the mirror file is absent, a different size, or older than the primary
 * (1s mtime granularity tolerance, matching the rest of the cache-staleness
 * checks). A `null` mirror stat means "not present" ⇒ replicate.
 */
export function needsReplication(primary: Stats, mirror: Stats | null): boolean {
  if (mirror === null) return true;
  if (primary.size !== mirror.size) return true;
  // Primary newer than mirror (beyond fs granularity) ⇒ mirror is stale.
  return primary.mtimeMs > mirror.mtimeMs + 1000;
}

/** stat a path, returning null on ENOENT (any other error propagates). */
export async function statOrNull(p: string): Promise<Stats | null> {
  try {
    return await stat(p);
  } catch (err) {
    if ((err as { code?: string } | null)?.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Copy `src` onto `dst` atomically and preserve the source's mtime. Writes to a
 * sibling temp, fsyncs, restores atime/mtime, then renames into place — so a
 * crash never leaves a partial file at the mirror path, and the mirror copy is
 * a byte- and mtime-faithful replica (matters for the mtime-based thumbnail
 * staleness check once the mirror serves reads).
 */
export async function copyFileToMirror(src: string, dst: string): Promise<void> {
  await mkdir(path.dirname(dst), { recursive: true });
  const tmp = `${dst}.mirror.tmp.${process.pid}.${randomBytes(8).toString('hex')}`;
  try {
    await copyFile(src, tmp);
    try {
      const st = await stat(src);
      await utimes(tmp, st.atime, st.mtime);
    } catch {
      /* mtime fidelity only — bytes are already copied */
    }
    const fh = await open(tmp, 'r+');
    try {
      await fh.datasync();
    } finally {
      await fh.close();
    }
    await rename(tmp, dst);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}
