/**
 * Refile's sidecar carry (#5061): each sidecar is snapshotted and published
 * under its save barrier, and its source is settled under both barriers once
 * the row is repointed, so a late save is carried rather than deleted.
 */
import * as path from 'node:path';
import * as fs from '../../fs/mirrored.ts';
import {
  publishSidecarSnapshot,
  readSidecarBytes,
  SidecarNotRegularFileError,
  sidecarStemClaimedBySibling,
  writeVerifiedTemp,
} from '../../fs/sidecar-ownership.ts';
import {
  PublishCollisionError,
  publishExclusive,
  type RelocatePublication,
} from '../../fs/relocate-publish.ts';
import { serializeSidecarWrites } from '../../fs/sidecar-write-order.ts';
import { listPairedSidecars, pickFreeConflictPath } from '../../fs/xmp-conflict.ts';
import { sidecarRenameTarget } from '../../fs/sidecar-rename.ts';
import { child as childLogger } from '../../log.ts';

const log = childLogger('migration:refile-sidecar');
const CONFLICT_ATTEMPTS = 5;

/** A sidecar published at `dest`, with the bytes its source held then. */
export interface CarriedSidecar {
  source: string;
  dest: string;
  snapshot: Buffer;
  /** The refiled photo's new path, which a conflict copy pairs with. */
  primary: string;
}

/** `null` for a link or other non-regular file, which stays where it is, as relocate leaves it (#4749). */
export async function carrySidecar(
  source: string,
  dest: string,
  primary: string,
  publications: RelocatePublication[],
): Promise<CarriedSidecar | null> {
  try {
    const snapshot = await publishSidecarSnapshot(source, dest, publications);
    return { source, dest, primary, snapshot };
  } catch (err) {
    if (!(err instanceof SidecarNotRegularFileError)) throw err;
    log.warn({ source }, 'refile: sidecar is not a regular file — left in place');
    return null;
  }
}

/** Another writer can take the picked name before the exclusive publish; pick again. */
async function atFreeConflictName<T>(
  primary: string,
  publish: (conflict: string) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < CONFLICT_ATTEMPTS; attempt++) {
    const conflict = await pickFreeConflictPath(primary, 'refile');
    const published = await publish(conflict).then(
      (value) => ({ value }),
      (err: unknown) => {
        if (err instanceof PublishCollisionError) return null;
        throw err;
      },
    );
    if (published) return published.value;
  }
  throw new Error(`refile: no free conflict name for ${primary}`);
}

async function publishConflictCopy(carried: CarriedSidecar, bytes: Buffer): Promise<void> {
  await atFreeConflictName(carried.primary, async (conflict) => {
    const tmp = await writeVerifiedTemp(conflict, bytes);
    try {
      await publishExclusive(tmp, conflict);
    } finally {
      await fs.unlink(tmp).catch(() => {});
    }
  });
}

/** Sidecars that first appeared at the old path after `planAndPlace` listed
 * them (a first backup send or web save) are carried once the row points at the
 * new path (#5061). A taken name gets a conflict copy beside the photo; a stem
 * a same-stem sibling still uses stays with that sibling. */
export async function carryLateRefileSidecars(
  oldAbs: string,
  newAbs: string,
  carried: readonly CarriedSidecar[],
): Promise<CarriedSidecar[]> {
  if (await sidecarStemClaimedBySibling(oldAbs, [newAbs])) return [];
  const known = new Set(carried.map((entry) => path.resolve(entry.source)));
  const late = (await listPairedSidecars(oldAbs)).filter((s) => !known.has(path.resolve(s)));
  const moved: CarriedSidecar[] = [];
  for (const source of late) {
    const dest = sidecarRenameTarget(oldAbs, newAbs, source);
    if (dest === null) continue;
    const entry = await carryLate(source, dest, newAbs).catch((err: unknown) => {
      log.warn(
        { source, err: err instanceof Error ? err.message : err },
        'refile: sidecar created mid-refile left in place',
      );
      return null;
    });
    if (entry) moved.push(entry);
  }
  return moved;
}

async function carryLate(
  source: string,
  dest: string,
  primary: string,
): Promise<CarriedSidecar | null> {
  try {
    return await carrySidecar(source, dest, primary, []);
  } catch (err) {
    if (!(err instanceof PublishCollisionError)) throw err;
    return atFreeConflictName(primary, (conflict) => carrySidecar(source, conflict, primary, []));
  }
}

/** A save on the source after its snapshot replaces `dest` while `dest` still
 * holds the snapshot; when both ends changed it lands as a conflict copy
 * beside the photo, never orphaned at the old path. */
async function carryLateSave(carried: CarriedSidecar, late: Buffer): Promise<void> {
  const atDest = await readSidecarBytes(carried.dest);
  if (atDest?.equals(late)) return;
  if (atDest === null || !atDest.equals(carried.snapshot)) {
    return publishConflictCopy(carried, late);
  }
  const tmp = await writeVerifiedTemp(carried.dest, late);
  await fs.rename(tmp, carried.dest).catch(async (err: unknown) => {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  });
}

/** Retire the source once the row points at the new path. A failure keeps it. */
export async function settleRefiledSidecar(carried: CarriedSidecar): Promise<void> {
  await serializeSidecarWrites([carried.source, carried.dest], async () => {
    const current = await readSidecarBytes(carried.source);
    if (current === null) return;
    if (!current.equals(carried.snapshot)) await carryLateSave(carried, current);
    await fs.unlink(carried.source);
  });
}
