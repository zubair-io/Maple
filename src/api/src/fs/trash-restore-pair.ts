import * as fs from './mirrored.ts';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { filesIdentical, moveNoClobber } from '../backup/fs-util.ts';
import { listPairedSidecarsStrict } from './xmp-conflict.ts';
import {
  isLegacyBackupSidecarOf,
  otherOldNameSpellings,
  removePhotoUnlessOldNameEditStays,
} from './legacy-backup-sidecar.ts';

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
  SidecarCollisionError,
  carryAsConflictCopy,
  incomingSidecarFor,
  joinCarriedSidecar,
  requireSidecarBytes,
  sameSidecarFile,
  settleCarriedSidecar,
  sidecarAlreadyCarried,
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
 * absence; dangling symlinks and lookup errors must not become free paths.
 * With `source`, a stem whose every sidecar already holds exactly the bytes
 * that photo carries there is free to join: no one's edits change, the rule
 * moves follow (`assetDestinationOccupied`), and it is what lets the second
 * half of a RAW+JPEG stack come back beside the first (#5930). */
export async function restoreDestinationOccupied(
  candidate: string,
  source?: string,
): Promise<boolean> {
  try {
    await fs.lstat(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }
  try {
    const present = await listPairedSidecars(candidate);
    if (present.length === 0) return false;
    return source === undefined || !(await joinsIdenticalSidecars(source, candidate, present));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw error;
  }
}

async function joinsIdenticalSidecars(
  source: string,
  candidate: string,
  present: readonly string[],
): Promise<boolean> {
  const own = await listPairedSidecars(source);
  for (const sidecar of present) {
    const incoming = await incomingSidecarFor(source, candidate, own, sidecar);
    if (!incoming || !(await sidecarAlreadyCarried(incoming, sidecar))) return false;
  }
  return true;
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
 * sidecar already holding its exact bytes is joined, not published. A losing
 * claim, or an orphan sidecar appearing at the stem, returns false. */
async function publishPair(
  staged: StagedFile[],
  destination: string,
  published: string[],
): Promise<boolean> {
  const [primary, ...sidecars] = staged as [StagedFile, ...StagedFile[]];
  // Recheck orphan sidecars after the potentially long RAW copy. Each
  // publish is still exclusive, so the check is never overwrite permission.
  if (await restoreDestinationOccupied(destination, primary.source)) return false;
  const joins = await Promise.all(sidecars.map((entry) => pathPresent(entry.destination)));
  if (!(await moveNoClobber(primary.temporary, primary.destination))) return false;
  published.push(primary.destination);
  const joined = sidecars.filter((_, index) => joins[index]);
  if (!(await onlySidecarsJoined(destination, joined))) return false;
  for (const [index, entry] of sidecars.entries()) {
    if (joins[index]) {
      if (!(await joinIdentical(entry))) return false;
      continue;
    }
    if (!(await moveNoClobber(entry.temporary, entry.destination))) return false;
    published.push(entry.destination);
  }
  return true;
}

async function pathPresent(target: string): Promise<boolean> {
  return fs.lstat(target).then(
    () => true,
    () => false,
  );
}

/** Whether every sidecar at the restored photo's stem is one it joins. */
async function onlySidecarsJoined(
  destination: string,
  joined: readonly StagedFile[],
): Promise<boolean> {
  for (const sidecar of await listPairedSidecars(destination)) {
    const expected = await Array.fromAsync(joined, (entry) =>
      sameSidecarFile(entry.destination, sidecar),
    );
    if (!expected.some(Boolean)) return false;
  }
  return true;
}

/** A save that changed the joined sidecar since the check makes it a collision. */
async function joinIdentical(entry: StagedFile): Promise<boolean> {
  return joinCarriedSidecar(entry.source, entry.destination).then(
    () => true,
    (err: unknown) => (err instanceof SidecarCollisionError ? false : Promise.reject(err)),
  );
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
          primary!.destination,
        )
      : fs.unlink(entry.source);
    await removal.catch((error) => {
      log.warn(
        { source: entry.source, error: String(error) },
        'restore: source delete failed after verified publication — duplicate retained',
      );
    });
  }
  await carryOtherSpellings(primary!, sidecars, beforeSourceDelete);
  await removeTrashedPrimary(primary!.source, beforeSourceDelete);
}

/** The photo's other old-name spellings come back as conflict copies beside it,
 * which the migration never adopts. One that can't is left in the trash, which
 * keeps the trashed photo with it. */
async function carryOtherSpellings(
  primary: StagedFile,
  carried: StagedFile[],
  beforeSourceDelete?: () => Promise<void>,
): Promise<void> {
  const others = await otherOldNameSpellings(
    primary.source,
    carried.map((entry) => entry.source),
  ).catch(() => []);
  for (const source of others) {
    const allowed = await (beforeSourceDelete?.() ?? Promise.resolve()).then(
      () => true,
      () => false,
    );
    if (!allowed) return;
    const stranded = await carryAsConflictCopy(source, primary.destination).catch(
      (error: unknown) => {
        log.warn({ source, error: String(error) }, 'restore: an old-name edit could not come back');
        return null;
      },
    );
    if (stranded !== null)
      log.error({ source }, 'restore: an old-name edit could not come back — kept in the trash');
  }
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
  if (allowed) await removePhotoUnlessOldNameEditStays(source, 'restore');
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
