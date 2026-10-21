/**
 * Refile's sidecar carry (#5061): each sidecar is snapshotted and published
 * under its save barrier, and its source is settled under both barriers once
 * the row is repointed, so a late save is carried rather than deleted.
 */
import * as fs from '../../fs/mirrored.ts';
import {
  publishSidecarSnapshot,
  readSidecarBytes,
  SidecarNotRegularFileError,
  writeVerifiedTemp,
} from '../../fs/sidecar-ownership.ts';
import { publishExclusive } from '../../fs/relocate-publish.ts';
import { serializeSidecarWrites } from '../../fs/sidecar-write-order.ts';
import { pickFreeConflictPath } from '../../fs/xmp-conflict.ts';
import { child as childLogger } from '../../log.ts';

const log = childLogger('migration:refile-sidecar');

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
): Promise<CarriedSidecar | null> {
  try {
    return { source, dest, primary, snapshot: await publishSidecarSnapshot(source, dest) };
  } catch (err) {
    if (!(err instanceof SidecarNotRegularFileError)) throw err;
    log.warn({ source }, 'refile: sidecar is not a regular file — left in place');
    return null;
  }
}

async function publishConflictCopy(carried: CarriedSidecar, bytes: Buffer): Promise<void> {
  const conflict = await pickFreeConflictPath(carried.primary, 'refile');
  const tmp = await writeVerifiedTemp(conflict, bytes);
  try {
    await publishExclusive(tmp, conflict);
  } finally {
    await fs.unlink(tmp).catch(() => {});
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
  await fs.rename(tmp, carried.dest);
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
