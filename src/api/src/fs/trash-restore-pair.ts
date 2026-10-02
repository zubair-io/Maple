import * as fs from './mirrored.ts';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { filesIdentical, moveNoClobber } from '../backup/fs-util.ts';
import { listPairedSidecarsStrict as listPairedSidecars } from './xmp-conflict.ts';
import { sidecarRenameTarget } from './sidecar-rename.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('fs/trash-restore');

/** A sidecar without a primary still owns its stem. Restoring an unedited
 * photo there would silently apply someone else's edits. ENOENT alone means
 * absence; dangling symlinks and lookup errors must not become free paths. */
export async function restoreDestinationOccupied(candidate: string): Promise<boolean> {
  try {
    await fs.lstat(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }
  try {
    return (await listPairedSidecars(candidate)).length > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw error;
  }
}

interface StagedFile {
  source: string;
  destination: string;
  temporary: string;
}

/** Copy and verify the complete pair before publishing any of it. Claim the
 * primary with the existing no-clobber primitive, then claim every sidecar.
 * A losing claim rolls back only this attempt's files and retains ALL sources
 * so the caller can retry the next restore name. Ordinary Replace operations
 * continue to use relocateFile; restore never authorizes replacement. */
export async function restoreFilePair(source: string, destination: string): Promise<boolean> {
  const sidecars = await listPairedSidecars(source);
  const pairs = [
    { source, destination },
    ...sidecars.map((sidecar) => {
      const target = sidecarRenameTarget(source, destination, sidecar);
      if (!target) throw new Error(`restore: cannot pair sidecar ${sidecar}`);
      return { source: sidecar, destination: target };
    }),
  ];
  const staged: StagedFile[] = pairs.map((pair) => ({
    ...pair,
    temporary: `${pair.destination}.tmp.${process.pid}-${randomBytes(8).toString('hex')}`,
  }));
  const published: string[] = [];
  let committed = false;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    for (const entry of staged) {
      await fs.copyFile(entry.source, entry.temporary);
      if (!(await filesIdentical(entry.source, entry.temporary))) {
        throw new Error(`restore: copy verification failed: ${entry.source}`);
      }
    }
    // Recheck orphan sidecars after the potentially long RAW copy. Each
    // publish is still exclusive, so the check is never overwrite permission.
    if (await restoreDestinationOccupied(destination)) return false;
    for (const [index, entry] of staged.entries()) {
      if (!(await moveNoClobber(entry.temporary, entry.destination))) return false;
      published.push(entry.destination);
      if (index === 0 && (await listPairedSidecars(destination)).length > 0) return false;
    }
    committed = true;
    for (const entry of staged) {
      await fs.unlink(entry.source).catch((error) => {
        log.warn(
          { source: entry.source, error: String(error) },
          'restore: source delete failed after verified publication — duplicate retained',
        );
      });
    }
    return true;
  } finally {
    if (!committed) {
      for (const created of published) await fs.unlink(created).catch(() => {});
    }
    for (const entry of staged) await fs.rm(entry.temporary, { force: true }).catch(() => {});
  }
}
