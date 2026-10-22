/** Streaming upload steps. Replacing a same-named file always keeps the previous
 * bytes: a catalogued asset goes through the leased Trash workflow, anything else
 * (video, plain file) is moved to `.maple/trash` by path (#4694). An existing
 * sidecar is never replaced here — sidecars are written through the XMP routes
 * with their preconditions, so the raw upload answers 409 instead. */
import * as path from 'node:path';
import { link, lstat, open, rename, stat, unlink, utimes } from '../fs/mirrored.ts';
import { findAssetToReplaceAtAddress, upsertUploadedAsset } from '../db/repos/assets.address.ts';
import { recordAndPublishAssetChange } from '../db/changes.repo.ts';
import { ALL_STAGE_NAMES } from '../workers/stages/manifest.ts';
import { classifyMediaType, isVideoFilename } from '../indexer/media-types.ts';
import {
  trashUploadReplacement,
  discardIdenticalReplacement,
} from '../library/upload-replacement.ts';
import type { FolderWithId } from '../db/schema.ts';
import type { ObjectId } from '../db/object-id.ts';
import { child } from '../log.ts';
import { errnoCode, LINK_UNSUPPORTED, PublishCollisionError } from '../fs/relocate-publish.ts';
import { serializeSidecarWrite } from '../fs/sidecar-write-order.ts';
import {
  captureUploadedSidecarAdmission,
  type UploadedSidecarAdmission,
} from './folders.upload-sidecar-admission';

const log = child('folders/upload');
function isSidecarUpload(filename: string): boolean {
  return path.extname(filename).toLowerCase() === '.xmp';
}
/** The target already holds a file this route must not replace; the route answers 409. */
export class UploadConflictError extends Error {}
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
  sidecarAdmission?: UploadedSidecarAdmission;
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
function refuseSidecarReplacement(target: string, filename: string): void {
  if (!isSidecarUpload(filename)) return;
  throw new UploadConflictError(
    `A sidecar already exists at "${target}"; write sidecars through the XMP routes`,
  );
}
async function trashExistingUpload(input: UploadTarget): Promise<TrashedReplacement | undefined> {
  const { folder, target, absPath, filename } = input;
  try {
    await stat(absPath);
    refuseSidecarReplacement(target, filename);
    const directory = relativeDirectory(target);
    const existing = await findAssetToReplaceAtAddress(folder._id, directory, filename);
    const moved = await trashUploadReplacement({
      existingId: existing?._id,
      root: folder.path,
      libraryId: folder._id,
      original: absPath,
      relativeDirectory: directory,
      filename,
      pairedWithSidecars: input.isMedia || isVideoFilename(filename),
    });
    if (moved.kind === 'ok')
      return existing ? { docId: existing._id, newAbsPath: moved.newAbsPath } : undefined;
    // Another actor may have completed the move; it owns the Trash update.
    if (await sourceExists(absPath)) throw new Error(moved.error);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    if (error instanceof UploadConflictError) throw error;
    throw uploadError('pre-trash', error);
  }
}
async function publishUploadedBody(input: UploadTarget): Promise<void> {
  if (isSidecarUpload(input.filename)) return publishUploadedSidecar(input);
  try {
    await rename(input.tmp, input.absPath);
  } catch (error) {
    throw uploadError('rename', error);
  }
}

/** Inside the sidecar's save barrier and exclusive (#5067): a save through the
 * XMP routes that landed after the existence check is never replaced. */
async function publishUploadedSidecar(input: UploadTarget): Promise<void> {
  const admission =
    input.sidecarAdmission ?? (await captureUploadedSidecarAdmission(input.absPath));
  await serializeSidecarWrite(
    input.absPath,
    async () => {
      try {
        await publishWhole(input.tmp, input.absPath);
      } catch (error) {
        if (!(error instanceof PublishCollisionError)) throw uploadError('publish', error);
        refuseSidecarReplacement(input.target, input.filename);
        throw error;
      } finally {
        await unlink(input.tmp).catch(() => {});
      }
      await preserveUploadMtime(input.absPath, input.mtimeHeader);
    },
    { primarySidecar: admission?.primarySidecar, admissionScope: admission?.scope },
  );
}
/** Readers never see a partial sidecar: a hard link, or where links aren't
 * supported (SMB) a rename after an absence check, which the barrier already
 * guards against every in-process writer. */
async function publishWhole(tmp: string, destination: string): Promise<void> {
  try {
    await link(tmp, destination);
    return;
  } catch (error) {
    if (errnoCode(error) === 'EEXIST') throw new PublishCollisionError(destination);
    if (!LINK_UNSUPPORTED.has(errnoCode(error) ?? '')) throw error;
  }
  const occupied = await lstat(destination).then(
    () => true,
    (error: unknown) => (errnoCode(error) === 'ENOENT' ? false : Promise.reject(error)),
  );
  if (occupied) throw new PublishCollisionError(destination);
  await rename(tmp, destination);
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
    if (!isSidecarUpload(input.filename))
      await preserveUploadMtime(input.absPath, input.mtimeHeader);
    await discardRedundantTrash(input, trashed);
    // A replaced asset the indexer had catalogued (e.g. a video) is re-indexed
    // even when the extension is outside the direct-upload set, so the
    // replacement does not vanish from the catalog until the next sweep.
    const catalogued = input.isMedia || trashed !== undefined;
    const assetId = catalogued ? await indexUploadedMedia(input, info.size, info.mtimeMs) : null;
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
