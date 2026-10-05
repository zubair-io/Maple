/** Streaming upload steps; replacement always retains durable Trash/purge intent. */
import * as path from 'node:path';
import { open, rename, stat, unlink, utimes } from '../fs/mirrored.ts';
import {
  RAW_EXTENSIONS,
  BITMAP_EXTENSIONS,
  PSD_HDR_EXTENSIONS,
  STUB_IMAGE_EXTENSIONS,
  AUDIO_EXTENSIONS,
} from '../fs/browse.ts';
import { findAssetToReplaceAtAddress, upsertUploadedAsset } from '../db/repos/assets.address.ts';
import { recordAndPublishAssetChange } from '../db/changes.repo.ts';
import { ALL_STAGE_NAMES } from '../workers/stages/manifest.ts';
import { classifyMediaType } from '../indexer/media-types.ts';
import {
  trashUploadReplacement,
  discardIdenticalReplacement,
} from '../library/upload-replacement.ts';
import type { FolderWithId } from '../db/schema.ts';
import type { ObjectId } from '../db/object-id.ts';
import { child } from '../log.ts';

const log = child('folders/upload');
const mediaExtensions = [
  RAW_EXTENSIONS,
  BITMAP_EXTENSIONS,
  PSD_HDR_EXTENSIONS,
  STUB_IMAGE_EXTENSIONS,
  AUDIO_EXTENSIONS,
];
export function isIndexedUpload(filename: string): boolean {
  const extension = path.extname(filename).slice(1).toLowerCase();
  return mediaExtensions.some((extensions) => extensions.has(extension));
}
async function removeFailedUpload(filename: string): Promise<void> {
  await unlink(filename).catch(() => {});
}
function uploadError(phase: string, error: unknown): Error {
  return new Error(
    `Upload ${phase} failed: ${error instanceof Error ? error.message : String(error)}`,
  );
}
async function writeStream(filename: string, stream: ReadableStream<Uint8Array>): Promise<void> {
  const sink = Bun.file(filename).writer();
  try {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) sink.write(value);
      }
    } finally {
      reader.releaseLock();
    }
    await sink.flush();
  } finally {
    await sink.end();
  }
}
export async function streamUploadedBody(
  filename: string,
  stream: ReadableStream<Uint8Array> | null,
): Promise<void> {
  try {
    if (stream) await writeStream(filename, stream);
    else {
      const file = await open(filename, 'w');
      await file.close();
    }
  } catch (error) {
    await removeFailedUpload(filename);
    throw uploadError('write', error);
  }
}
interface UploadTarget {
  folder: FolderWithId;
  target: string;
  filename: string;
  absPath: string;
  tmp: string;
  isMedia: boolean;
  mtimeHeader: string | undefined;
  ownerId: string | undefined;
}
interface TrashedReplacement {
  docId: ObjectId;
  newAbsPath: string;
}
function relativeDirectory(target: string): string {
  const directory = path.dirname(target);
  return directory === '.' ? '' : directory.split(path.sep).join('/');
}
async function sourceExists(filename: string): Promise<boolean> {
  try {
    await stat(filename);
    return true;
  } catch {
    return false;
  }
}
async function trashExistingUpload(input: UploadTarget): Promise<TrashedReplacement | undefined> {
  if (!input.isMedia) return;
  const { folder, target, absPath, filename } = input;
  try {
    await stat(absPath);
    const directory = relativeDirectory(target);
    const existing = await findAssetToReplaceAtAddress(folder._id, directory, filename);
    const moved = await trashUploadReplacement(
      existing?._id,
      folder.path,
      folder._id,
      absPath,
      directory,
      filename,
    );
    if (moved.kind === 'ok')
      return existing ? { docId: existing._id, newAbsPath: moved.newAbsPath } : undefined;
    // Another actor may have completed the move; it owns the Trash update.
    if (await sourceExists(absPath)) throw new Error(moved.error);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw uploadError('pre-trash', error);
  }
}
async function publishUploadedBody(input: UploadTarget): Promise<void> {
  try {
    await rename(input.tmp, input.absPath);
  } catch (error) {
    throw uploadError('rename', error);
  }
}
async function preserveUploadMtime(filename: string, value: string | undefined): Promise<void> {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return;
  const epoch = parseInt(value, 10);
  await utimes(filename, epoch, epoch).catch(() => {});
}
async function discardRedundantTrash(
  input: UploadTarget,
  trashed: TrashedReplacement | undefined,
): Promise<void> {
  if (!trashed) return;
  try {
    await discardIdenticalReplacement(
      trashed.docId,
      input.folder.path,
      trashed.newAbsPath,
      input.absPath,
    );
  } catch (error) {
    log.warn(
      { absPath: input.absPath, err: error instanceof Error ? error.message : String(error) },
      'duplicate-upload cleanup failed — leaving trash entry in place',
    );
  }
}
async function indexUploadedMedia(
  input: UploadTarget,
  size: number,
  mtimeMs: number,
): Promise<ObjectId> {
  try {
    return await upsertUploadedAsset({
      libraryId: input.folder._id,
      ownerId: input.ownerId,
      path: relativeDirectory(input.target),
      filename: input.filename,
      size,
      mtimeMs,
      indexedAt: new Date().toISOString(),
      mediaKind: classifyMediaType(input.filename),
      stages: ALL_STAGE_NAMES,
    });
  } catch (error) {
    await removeFailedUpload(input.absPath);
    throw uploadError('metadata', error);
  }
}
async function announceUploadedFile(input: UploadTarget, assetId: ObjectId | null): Promise<void> {
  await recordAndPublishAssetChange({
    kind: 'create',
    asset_id: assetId,
    folder_id: input.folder._id,
    abs_path: input.absPath,
    ...(assetId ? {} : { relative_path: input.target }),
  }).catch((error) => {
    log.warn({ absPath: input.absPath, error }, 'change-feed emit failed after upload');
  });
}
export async function finalizeUploadedFile(input: UploadTarget) {
  try {
    const trashed = await trashExistingUpload(input);
    await publishUploadedBody(input);
    const info = await stat(input.absPath);
    await preserveUploadMtime(input.absPath, input.mtimeHeader);
    await discardRedundantTrash(input, trashed);
    const assetId = input.isMedia ? await indexUploadedMedia(input, info.size, info.mtimeMs) : null;
    await announceUploadedFile(input, assetId);
    return {
      ...(assetId ? { asset_id: assetId.toHexString() } : {}),
      abs_path: input.absPath,
      size: info.size,
      mtime: new Date(info.mtimeMs).toISOString(),
    };
  } catch (error) {
    await removeFailedUpload(input.tmp);
    throw error;
  }
}
