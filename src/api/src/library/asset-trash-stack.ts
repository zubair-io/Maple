/**
 * Trash a RAW+JPEG stack under one trash stem (#5930). Two per-asset trashes
 * each pick their own free name, so with an older `IMG_1.CR3` already in the
 * trash the RAW became `IMG_1.1.CR3` while the JPEG landed as `IMG_1.JPG`
 * beside that older photo and published its edits there. Here the RAW's trash
 * move carries the JPEG beside it (`fs/relocate.ts`'s `stackCompanion`) onto a
 * stem free for the RAW, the JPEG and their sidecar, and both rows are stamped
 * trashed in one transaction: a failure leaves both live.
 */

import * as path from 'node:path';
import type { ObjectId } from '../db/object-id.ts';
import { findCoreInfoById } from '../db/repos/assets.repo.ts';
import { markStackSoftDeleted, type SoftDeleteArgs } from '../db/repos/assets.trash.ts';
import { recordAndPublishAssetChange } from '../db/repos/changes.repo.ts';
import {
  fenceLifecycleMove,
  finishLocalLifecycle,
  lifecycleCommit,
  prepareLifecycle,
  recordLifecycleTarget,
  runLifecycleMove,
} from '../cloud-backup/lifecycle.ts';
import { moveToTrash } from '../fs/trash.ts';
import { stackCompanionTarget } from '../fs/relocate-stack.ts';
import { trashTarget, type AssetLocationEntry, type TrashAssetOutcome } from './asset-trash.ts';
import { companionBeside } from './relocate-stack-companion.ts';

export type TrashStackOutcome = TrashAssetOutcome | { kind: 'companion-missing' };

interface StackHalf {
  id: ObjectId;
  source: AssetLocationEntry;
  absPath: string;
  /** Where this half lands once the RAW's trash name is known. */
  landsAt: (rawTarget: string) => string;
}

/** Trash the RAW `id` with the JPEG `companionId` beside it, under one stem. */
export async function trashStackById(
  id: ObjectId,
  companionId: ObjectId,
): Promise<TrashStackOutcome> {
  const [info, companionInfo] = await Promise.all([
    findCoreInfoById(id),
    findCoreInfoById(companionId),
  ]);
  if (!info) return { kind: 'not-found' };
  if (info.deleted_at || companionInfo?.deleted_at) return { kind: 'already-trashed' };
  const target = await trashTarget(info.fileinfo, {});
  if ('kind' in target) return target;
  const { entrySpec, folder } = target;
  const location = companionInfo
    ? companionBeside(companionInfo.fileinfo ?? [], {
        library_id: entrySpec.libraryId,
        path: entrySpec.path,
        filename: entrySpec.filename,
      })
    : null;
  if (!location) return { kind: 'companion-missing' };

  const rawAbsPath = path.join(folder.path, entrySpec.path, entrySpec.filename);
  const jpegAbsPath = path.join(folder.path, location.path, location.filename);
  const halves: StackHalf[] = [
    { id, source: entrySpec, absPath: rawAbsPath, landsAt: (rawTarget) => rawTarget },
    {
      id: companionId,
      source: { libraryId: entrySpec.libraryId, path: location.path, filename: location.filename },
      absPath: jpegAbsPath,
      landsAt: (rawTarget) => stackCompanionTarget(rawTarget, jpegAbsPath),
    },
  ];
  return trashHalves(halves, folder.path, entrySpec.libraryId);
}

async function trashHalves(
  halves: readonly StackHalf[],
  root: string,
  libraryId: ObjectId,
): Promise<TrashStackOutcome> {
  const intents = await prepareIntents(halves, root, libraryId);
  const [raw, jpeg] = halves as [StackHalf, StackHalf];
  const [rawIntent, jpegIntent] = intents as [string, string];
  const recordTargets = async (rawTarget: string) => {
    await recordLifecycleTarget(rawIntent, root, raw.absPath, raw.landsAt(rawTarget));
    await recordLifecycleTarget(jpegIntent, root, jpeg.absPath, jpeg.landsAt(rawTarget));
  };
  const fence = async () => {
    await fenceLifecycleMove(rawIntent);
    await fenceLifecycleMove(jpegIntent);
  };
  const markTrashed = async (rawTarget: string) =>
    markStackSoftDeleted(await softDeletes(halves, intents, root, rawTarget, libraryId));
  const result = await runLifecycleMove(rawIntent, () =>
    runLifecycleMove(jpegIntent, () =>
      moveToTrash(raw.absPath, root, recordTargets, fence, markTrashed, jpeg.absPath),
    ),
  );
  for (const intent of intents) await finishLocalLifecycle(intent, result.kind !== 'ok');
  if (result.kind !== 'ok') return { kind: 'error', error: result.error };

  for (const half of halves) {
    await recordAndPublishAssetChange({
      kind: 'delete',
      asset_id: half.id,
      folder_id: libraryId,
      abs_path: half.absPath,
    }).catch(() => {});
  }
  return {
    kind: 'ok',
    assetId: halves[0]!.id,
    folderId: libraryId,
    newAbsPath: result.newAbsPath,
    originalAbsPath: halves[0]!.absPath,
  };
}

/** One lifecycle intent per half; a failure releases those already prepared. */
async function prepareIntents(
  halves: readonly StackHalf[],
  root: string,
  libraryId: ObjectId,
): Promise<string[]> {
  const intents: string[] = [];
  try {
    for (const half of halves) {
      const relative = path.relative(root, half.absPath).split(path.sep).join('/');
      intents.push(
        await prepareLifecycle(half.id.toHexString(), 'trash', libraryId.toHexString(), relative),
      );
    }
    return intents;
  } catch (err) {
    for (const intent of intents) await finishLocalLifecycle(intent, true);
    throw err;
  }
}

async function softDeletes(
  halves: readonly StackHalf[],
  intents: readonly string[],
  root: string,
  rawTarget: string,
  libraryId: ObjectId,
): Promise<SoftDeleteArgs[]> {
  return Promise.all(
    halves.map(async (half, index) => ({
      id: half.id,
      libraryRoot: root,
      libraryId,
      newAbsPath: half.landsAt(rawTarget),
      originalAbsPath: half.absPath,
      source: half.source,
      lifecycle: await lifecycleCommit(intents[index]!),
    })),
  );
}
