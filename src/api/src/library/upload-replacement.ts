import { appleCompanionPaths } from '../db/apple-companions.ts';
import { revertCreated, type RelocatePublication } from '../fs/relocate-publish.ts';
import * as path from 'node:path';
import type { ObjectId } from '../db/object-id.ts';
import { findCoreInfoById } from '../db/repos/assets.repo.ts';
import { hardDelete } from '../db/repos/assets.trash.ts';
import { fileHash, jailedFile } from '../cloud-backup/inventory.ts';
import { prepareIdenticalReplacementPurge } from '../cloud-backup/lifecycle.ts';
import { unlink, unlinkPrimaryForPurge } from '../fs/mirrored.ts';
import { listPairedSidecarsStrict } from '../fs/xmp-conflict.ts';
import { trashAssetById } from './asset-trash.ts';
import { publishConflictBytes, sidecarStemOwnedByAnotherFile } from '../fs/sidecar-ownership.ts';
import { readSidecarBytes } from '../fs/sidecar-bytes.ts';
import { isLegacyBackupSidecarOf } from '../fs/legacy-backup-sidecar.ts';
import { trySerializeSidecarWrite, serializeSidecarWrites } from '../fs/sidecar-write-order.ts';
import { xmpSidecarPath } from '../fs/xmp.ts';
import { child as childLogger } from '../log.ts';
import { moveFileToTrash, moveToTrash } from '../fs/trash.ts';

const log = childLogger('library/upload-replacement');

/** Indexed replacement uses the same leased, durable Trash workflow as DELETE.
 * An unindexed file has no catalog or backup identity to fence: media that is
 * merely not indexed yet still carries its sidecars into Trash, while a plain
 * file moves alone — any same-stem `.xmp` belongs to a photo, not to it (#4694). */
export interface UploadReplacement {
  existingId: ObjectId | undefined;
  root: string;
  libraryId: ObjectId;
  original: string;
  relativeDirectory: string;
  filename: string;
  /** Media (indexed or not) carries its `.xmp` sidecars into Trash; a plain file moves alone. */
  pairedWithSidecars: boolean;
  /** The target sits under `.mapleignore` (#5398). */
  ignored: boolean;
}

export async function trashUploadReplacement(replacement: UploadReplacement) {
  const { existingId, root, libraryId, original, relativeDirectory, filename } = replacement;
  if (!existingId) {
    return replacement.pairedWithSidecars
      ? moveToTrash(original, root)
      : moveFileToTrash(original, root);
  }
  const result = await trashAssetById(existingId, {
    entry: { libraryId, path: relativeDirectory, filename },
    ...(replacement.ignored ? { allowExcluded: true as const } : {}),
  });
  if (result.kind === 'ok') return { kind: 'ok' as const, newAbsPath: result.newAbsPath };
  return {
    kind: 'error' as const,
    error: result.kind === 'error' ? result.error : `Replacement Trash unavailable: ${result.kind}`,
  };
}

async function unlinkPurgedPrimary(filename: string): Promise<void> {
  try {
    await unlinkPrimaryForPurge(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

interface StagedLateEdit {
  source: string;
  bytes: Buffer;
  publication: RelocatePublication;
}

async function withLateSourceBarrier(
  sidecar: string,
  heldPaths: ReadonlySet<string>,
  operation: () => Promise<void>,
): Promise<void> {
  if (heldPaths.has(path.resolve(sidecar).normalize('NFC').toLowerCase())) return operation();
  // A conflict writer reserves this name together with the held canonical
  // path. Never wait on that writer while holding the canonical purge fence.
  const result = await trySerializeSidecarWrite(sidecar, operation);
  if (!result.acquired) throw new Error('late sidecar has a queued writer');
}

async function withdrawStagedLateEdits(staged: readonly StagedLateEdit[]): Promise<void> {
  for (const edit of staged) {
    const current = await readSidecarBytes(edit.publication.path);
    if (current?.equals(edit.bytes)) await revertCreated([edit.publication]);
  }
}

async function retireStagedLateEdits(
  staged: readonly StagedLateEdit[],
  heldPaths: ReadonlySet<string>,
): Promise<void> {
  for (const edit of staged)
    await withLateSourceBarrier(edit.source, heldPaths, async () => {
      const current = await readSidecarBytes(edit.source);
      if (current?.equals(edit.bytes)) await unlink(edit.source);
    });
}

/** Equal bytes don't make an edit redundant: a sidecar first written beside the
 * trashed photo after the purge checked (#5069) follows the replacement as a
 * `(conflict from move)` copy, and leaves the trash under its barrier once
 * copied after admission. A canonical sidecar a trashed same-stem sibling still shares stays
 * with that sibling; an old-name edit names this photo alone, so it follows. */
async function carryLateEditsToReplacement(
  trashedPath: string,
  replacementPath: string,
  heldPaths: ReadonlySet<string>,
  staged: StagedLateEdit[] | null,
): Promise<boolean> {
  // Strict: an unreadable Trash folder must never read as "no late edits".
  const shared = await sidecarStemOwnedByAnotherFile(trashedPath);
  const late = (await listPairedSidecarsStrict(trashedPath)).filter(
    (sidecar) => !shared || isLegacyBackupSidecarOf(trashedPath, sidecar),
  );
  // One at a time, so the edits don't race each other for conflict names.
  const followed = await Array.fromAsync(late, (sidecar) =>
    carryLateEdit(sidecar, replacementPath, heldPaths, staged),
  );
  return followed.every(Boolean);
}

function carryLateEdit(
  sidecar: string,
  replacementPath: string,
  heldPaths: ReadonlySet<string>,
  staged: StagedLateEdit[] | null,
): Promise<boolean> {
  const carry = async () => {
    const bytes = await readSidecarBytes(sidecar);
    if (bytes === null) return;
    const publications: RelocatePublication[] = [];
    if (!(await publishConflictBytes(replacementPath, bytes, publications))) {
      throw new Error('no conflict copy could be published');
    }
    if (staged) {
      const publication = publications[0];
      if (!publication) throw new Error('conflict publication has no receipt');
      staged.push({ source: sidecar, bytes, publication });
    } else await unlink(sidecar);
  };
  const operation = withLateSourceBarrier(sidecar, heldPaths, carry);
  return operation.then(
    () => true,
    (err: unknown) => {
      log.error(
        { sidecar, err: err instanceof Error ? err.message : err },
        'identical replacement: a late edit could not follow — kept in Trash',
      );
      return false;
    },
  );
}

/** Prefix hashes are insufficient for erasure: compare the complete files.
 * Keep multi-location identities and their other surviving copies intact. */
export async function discardIdenticalReplacement(
  assetId: ObjectId,
  root: string,
  trashedPath: string,
  replacementPath: string,
): Promise<boolean> {
  const info = await findCoreInfoById(assetId);
  if (!info || info.fileinfo?.length !== 1) return false;
  if ((await fileHash(trashedPath)) !== (await fileHash(replacementPath))) return false;
  const location = info.fileinfo[0];
  const slots = [xmpSidecarPath(trashedPath), `${trashedPath}.xmp`];
  const heldPaths = new Set(slots.map((slot) => path.resolve(slot).normalize('NFC').toLowerCase()));
  // Wait for first saves even when their atomic publication has not appeared
  // in the directory yet; keep the fence through catalog deletion.
  return serializeSidecarWrites(slots, async () => {
    const sidecars = await listPairedSidecarsStrict(trashedPath);
    // Equal RAW bytes do not imply redundant edits or rendered companions.
    if (sidecars.length || appleCompanionPaths(info).length) return false;
    const files = [trashedPath];
    for (const filename of files)
      await jailedFile(root, path.relative(root, filename).split(path.sep).join('/'));
    // An edit written since the check above follows first: once the intent is
    // recorded the purge can't be undone, so one that can't follow keeps the photo
    // (#5129). Edits that did follow stay as conflict copies beside the replacement.
    const staged: StagedLateEdit[] = [];
    const lateEditsFollowed = await carryLateEditsToReplacement(
      trashedPath,
      replacementPath,
      heldPaths,
      staged,
    ).catch((err: unknown) => {
      log.error(
        { trashedPath, err: err instanceof Error ? err.message : err },
        'identical replacement: checking for late edits failed — photo kept in Trash',
      );
      return false;
    });
    if (!lateEditsFollowed) {
      await withdrawStagedLateEdits(staged);
      return false;
    }
    // Intent and mirror inventories must survive every subsequent local unlink
    // and catalog deletion. Failure retains the row and its association for retry.
    const admitted = await prepareIdenticalReplacementPurge(assetId.toHexString(), {
      libraryId: location.library_id.toHexString(),
      path: location.path,
      filename: location.filename,
    }).catch(async (error: unknown) => {
      await withdrawStagedLateEdits(staged);
      throw error;
    });
    if (!admitted) {
      await withdrawStagedLateEdits(staged);
      return false;
    }
    await retireStagedLateEdits(staged, heldPaths);
    for (const filename of files) await unlinkPurgedPrimary(filename);
    // Never skips the row's deletion: the photo is already gone.
    await carryLateEditsToReplacement(trashedPath, replacementPath, heldPaths, null).catch(
      (err: unknown) => {
        log.error(
          { trashedPath, err: err instanceof Error ? err.message : err },
          'identical replacement: checking for late edits failed',
        );
      },
    );
    await hardDelete(assetId);
    return true;
  });
}
