/**
 * The two asset-collection writes `POST /api/backup-ingest` ends in — split
 * out of `backup-ingest.ts` (a single 580-line route handler) so the row
 * shape lives in one place: a brand-new asset for a first upload, or one
 * more location appended to an asset the library already holds.
 *
 * Both keep the denormalised fields in step with `fileinfo`:
 * `live_location_count` (#1302) and `media_kind` (#3492).
 */
import { ObjectId, type Collection, type Document } from 'mongodb';
import type { AssetDoc } from '../db/schema.ts';
import path from 'node:path';
import { updateLiveLocationCount } from '../indexer/images.repo.ts';
import { classifyMediaType } from '../indexer/media-types.ts';

/** `dirname` of a library-relative path in POSIX form, `''` at the root — a
 * Windows host with `\` as `path.sep` must not store backslashes. */
function relDirOf(relPath: string): string {
  const raw = path.posix.dirname(relPath.split(path.sep).join('/'));
  return raw === '.' || raw === '' ? '' : raw;
}

export interface AppendBackupLocationInput {
  resolvedTargetRelPath: string;
  filename: string;
  libraryId: ObjectId;
  /** The PhotoKit link to record alongside the location, or null when this
   * asset is already linked to that device. */
  link: object | null;
}

/** Cross-library dedup: the content already exists as an asset — record this
 * upload as one more location on it (and the device link if new). */
export async function appendBackupLocation(
  assets: Collection<AssetDoc>,
  existingId: ObjectId,
  input: AppendBackupLocationInput,
): Promise<void> {
  const newFileInfo = {
    path: relDirOf(input.resolvedTargetRelPath),
    filename: input.filename,
    library_id: input.libraryId,
    deleted_at: null,
  };
  await assets.updateOne({ _id: existingId }, {
    $push: input.link
      ? { fileinfo: newFileInfo, phasset_links: input.link }
      : { fileinfo: newFileInfo },
  } as Document);
  // Recompute live count + media_kind after adding a new live fileinfo entry.
  await updateLiveLocationCount(assets, existingId);
}

export interface InsertBackupAssetInput {
  resolvedTargetRelPath: string;
  libraryId: ObjectId;
  totalBytes: number;
  mapleId: string;
  isScreenshot: boolean;
  link: object;
}

/** First upload of this content: create the asset row. */
export async function insertBackupAsset(
  assets: Collection<AssetDoc>,
  input: InsertBackupAssetInput,
): Promise<void> {
  const relFilename = path.posix.basename(input.resolvedTargetRelPath);
  await assets.insertOne({
    _id: new ObjectId(),
    fileinfo: [
      {
        path: relDirOf(input.resolvedTargetRelPath),
        filename: relFilename,
        library_id: input.libraryId,
        deleted_at: null,
      },
    ],
    // One live fileinfo entry on insert.
    live_location_count: 1,
    media_kind: classifyMediaType(relFilename),
    size: input.totalBytes,
    mtime: Date.now(),
    rating: 0,
    flag: 0,
    color_label: '',
    indexed_at: new Date().toISOString(),
    maple_id: input.mapleId,
    // Seed the screenshot flag from the same filename heuristic that chose
    // the `<year>/Screenshot` folder, so the row matches its on-disk home
    // before the EXIF stage runs. The EXIF stage re-affirms it (now with
    // camera_make) and the describe stage refines it with the vision verdict.
    is_screenshot: input.isScreenshot,
    phasset_links: [input.link],
    deleted_from_photos: false,
  } as unknown as AssetDoc);
}
