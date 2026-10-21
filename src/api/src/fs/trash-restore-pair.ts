import * as fs from './mirrored.ts';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { filesIdentical, moveNoClobber } from '../backup/fs-util.ts';
import { listPairedSidecarsStrict } from './xmp-conflict.ts';
import { hasLegacyBackupEdit, isLegacyBackupSidecarOf } from './legacy-backup-sidecar.ts';

/** Whether a restore carries an old-name edit (#5063), which can't land on a taken slot. */
export async function carriesOldNameEdit(source: string): Promise<boolean> {
  const sidecars = await listPairedSidecars(source);
  return sidecars.some((sidecar) => isLegacyBackupSidecarOf(source, sidecar));
}
import { workflowSidecarBase } from './workflow-sidecar-pairing';
import { isVideoFilename } from '../indexer/media-types';
import { sidecarRenameTarget } from './sidecar-rename.ts';
import { child as childLogger } from '../log.ts';
import { serializeSidecarWrite } from './sidecar-write-order.ts';
import {
  requireSidecarBytes,
  settleCarriedSidecar,
  sidecarStemClaimedBySibling,
} from './sidecar-ownership.ts';

const log = childLogger('fs/trash-restore');

/** Restore associates the saved pair case-insensitively. Ordinary move/trash
 * keeps differently cased UUID branches separate; retain that contract there.
 * The existing UUID parser still rejects malformed identities and suffixes. */
async function listPairedSidecars(source: string): Promise<string[]> {
  const paired = await listPairedSidecarsStrict(source);
  const directory = path.dirname(source);
  const base = path.basename(source, isVideoFilename(source) ? '' : path.extname(source));
  const comparisonBase = base.toLowerCase();
  const entries = await fs.readdir(directory);
  const workflow = entries
    .filter((name) => workflowSidecarBase(name)?.toLowerCase() === comparisonBase)
    .map((name) => path.join(directory, name));
  return [...new Set([...paired, ...workflow])];
}

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
  isSidecar: boolean;
}

/** Sidecars are read inside their save barrier so the later source unlink
 * can tell whether a save landed after the snapshot (#4692). */
async function stage(entry: StagedFile): Promise<Buffer | null> {
  if (!entry.isSidecar) {
    await fs.copyFile(entry.source, entry.temporary);
    if (await filesIdentical(entry.source, entry.temporary)) return null;
    throw new Error(`restore: copy verification failed: ${entry.source}`);
  }
  return serializeSidecarWrite(entry.source, async () => {
    const snapshot = await requireSidecarBytes(entry.source);
    await fs.writeFile(entry.temporary, snapshot);
    if (snapshot.equals(await fs.readFile(entry.temporary))) return snapshot;
    throw new Error(`restore: copy verification failed: ${entry.source}`);
  });
}

function planPair(source: string, destination: string, sidecars: string[]): StagedFile[] {
  const pairs = [
    { source, destination, isSidecar: false },
    ...sidecars.map((sidecar) => {
      const target = sidecarRenameTarget(source, destination, sidecar);
      if (!target) throw new Error(`restore: cannot pair sidecar ${sidecar}`);
      return { source: sidecar, destination: target, isSidecar: true };
    }),
  ];
  return pairs.map((pair) => ({
    ...pair,
    temporary: `${pair.destination}.tmp.${process.pid}-${randomBytes(8).toString('hex')}`,
  }));
}

/** Claim every staged file exclusively, recording each published path. A
 * losing claim, or an orphan sidecar appearing at the stem, returns false. */
async function publishPair(
  staged: StagedFile[],
  destination: string,
  published: string[],
): Promise<boolean> {
  // Recheck orphan sidecars after the potentially long RAW copy. Each
  // publish is still exclusive, so the check is never overwrite permission.
  if (await restoreDestinationOccupied(destination)) return false;
  for (const [index, entry] of staged.entries()) {
    if (!(await moveNoClobber(entry.temporary, entry.destination))) return false;
    published.push(entry.destination);
    if (index === 0 && (await listPairedSidecars(destination)).length > 0) return false;
  }
  return true;
}

/** After any source was removed, retain published copies even if a later
 * ownership check fails: rollback would discard the only remaining bytes. A
 * sidecar another trashed same-stem photo still uses stays in the trash. */
async function removeSources(
  staged: StagedFile[],
  snapshots: Map<StagedFile, Buffer>,
  sidecarClaimedInTrash: boolean,
  beforeSourceDelete?: () => Promise<void>,
): Promise<void> {
  const [primary, ...sidecars] = staged;
  for (const entry of sidecars) {
    await beforeSourceDelete?.();
    const snapshot = snapshots.get(entry);
    const removal = snapshot
      ? settleCarriedSidecar(
          entry.source,
          entry.destination,
          snapshot,
          sidecarClaimedInTrash && !isLegacyBackupSidecarOf(primary!.source, entry.source),
        )
      : fs.unlink(entry.source);
    await removal.catch((error) => {
      log.warn(
        { source: entry.source, error: String(error) },
        'restore: source delete failed after verified publication — duplicate retained',
      );
    });
  }
  await removeTrashedPrimary(primary!.source, beforeSourceDelete);
}

/** Last, and kept while an old-name edit of it is still beside it in the
 * trash, the only place the migration looks for that edit (#5063). */
async function removeTrashedPrimary(
  source: string,
  beforeSourceDelete?: () => Promise<void>,
): Promise<void> {
  const allowed = await (beforeSourceDelete?.() ?? Promise.resolve()).then(
    () => true,
    () => false,
  );
  if (!allowed) return;
  if (await hasLegacyBackupEdit(source)) {
    log.error({ source }, 'restore: an old-name backup edit stayed in the trash — photo kept');
    return;
  }
  await fs.unlink(source).catch((error) => {
    log.warn(
      { source, error: String(error) },
      'restore: source delete failed after verified publication — duplicate retained',
    );
  });
}

/** Copy and verify the complete pair before publishing any of it. Claim the
 * primary with the existing no-clobber primitive, then claim every sidecar.
 * A losing claim rolls back only this attempt's files and retains ALL sources
 * so the caller can retry the next restore name. Ordinary Replace operations
 * continue to use relocateFile; restore never authorizes replacement. */
export async function restoreFilePair(
  source: string,
  destination: string,
  beforeSourceDelete?: () => Promise<void>,
  onVerified?: (destination: string) => Promise<void>,
): Promise<boolean> {
  const staged = planPair(source, destination, await listPairedSidecars(source));
  const sidecarClaimedInTrash = await sidecarStemClaimedBySibling(source);
  const published: string[] = [];
  const snapshots = new Map<StagedFile, Buffer>();
  let committed = false;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    for (const entry of staged) {
      const snapshot = await stage(entry);
      if (snapshot) snapshots.set(entry, snapshot);
    }
    if (!(await publishPair(staged, destination, published))) return false;
    await beforeSourceDelete?.();
    await onVerified?.(destination);
    committed = onVerified !== undefined;
    await beforeSourceDelete?.();
    committed = true;
    await removeSources(staged, snapshots, sidecarClaimedInTrash, beforeSourceDelete);
    return true;
  } finally {
    if (!committed) {
      for (const created of published) await fs.unlink(created).catch(() => {});
    }
    for (const entry of staged) await fs.rm(entry.temporary, { force: true }).catch(() => {});
  }
}
