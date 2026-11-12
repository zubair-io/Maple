/**
 * `folder_scan` — walk a registered library and push every supported file
 * through the discover producer, which dedups by maple_id/sha1_head and
 * relinks moved or new files onto their asset rows. Registering a folder,
 * Rescan and the scan-on-open all start one; the walk is idempotent, so an
 * attempt interrupted by a restart simply walks again. `last_scan` is stamped
 * once the walk completes, and is what the scan-on-open de-bounce reads.
 */

import type { Dirent } from 'node:fs';
import * as nodePath from 'node:path';
import { ObjectId } from '../../db/object-id.ts';
import { findFolderById, setFolderLastScan } from '../../db/repos/folders.repo.ts';
import { DUPLICATES_DIR_NAME } from '../../fs/duplicates.ts';
import { listingHasIgnoreMarker } from '../../fs/mapleignore.ts';
import { readdir } from '../../fs/mirrored.ts';
import { child as childLogger } from '../../log.ts';
import { handleEvent } from '../../workers/discover/index.ts';
import type { JobHandler, JobHandlerContext } from './index.ts';

const log = childLogger('folder-scan');

/** Directories listed, and files handed to discover, at once. */
const CONCURRENCY = 8;

/**
 * Supported extensions (lowercase with leading dot): a cheap pre-filter in
 * front of `handleEvent`, which is itself gated by the canonical
 * `SUPPORTED_EXTS` in `workers/discover/types.ts`. This list is narrower than
 * that one (no video/psd/psb/hdr).
 */
const SUPPORTED_EXTS: ReadonlySet<string> = new Set([
  '.dng',
  '.cr2',
  '.cr3',
  '.nef',
  '.arw',
  '.raf',
  '.orf',
  '.rw2',
  '.pef',
  '.srw',
  '.x3f',
  '.3fr',
  '.mef',
  '.erf',
  '.mrw',
  '.raw',
  '.fff',
  '.jpg',
  '.jpeg',
  '.tif',
  '.tiff',
  '.heic',
  '.heif',
  '.eip',
  '.braw',
  '.afphoto',
  '.ai',
  '.mp3',
  '.wav',
  '.m4a',
  '.aac',
]);

/** Runs `run` over `items`, at most `limit` at a time; a failed item does not stop the rest. */
async function dispatchPool<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  const cursor = { next: 0 };
  const lane = async (): Promise<void> => {
    const index = cursor.next++;
    if (index >= items.length) return;
    await run(items[index]!).catch(() => {});
    await lane();
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

interface Listing {
  dirs: string[];
  files: string[];
}

/** One directory's subdirectories and supported files; an unreadable or ignored directory has none. */
async function listDirectory(dir: string): Promise<Listing> {
  const entries = await readdir(dir, { withFileTypes: true }).then(
    (listed) => listed as unknown as Dirent[],
    () => null,
  );
  if (entries === null) return { dirs: [], files: [] };
  const names = entries.map((entry) => entry.name as unknown as string);
  if (await listingHasIgnoreMarker(dir, names)) return { dirs: [], files: [] };
  // `.maple`, `.thumbnails` and the like, and the DeDuplicate quarantine, whose
  // copies are byte-identical to the kept originals.
  const kept = entries.filter((entry) => {
    const name = entry.name as unknown as string;
    return !name.startsWith('.') && name !== DUPLICATES_DIR_NAME;
  });
  const pathOf = (entry: Dirent) => nodePath.join(dir, entry.name as unknown as string);
  return {
    dirs: kept.filter((entry) => entry.isDirectory()).map(pathOf),
    files: kept
      .filter((entry) => entry.isFile())
      .map(pathOf)
      .filter((path) => SUPPORTED_EXTS.has(nodePath.extname(path).toLowerCase())),
  };
}

interface WalkState {
  queue: string[];
  found: number;
}

/** Walks breadth-first, a batch of directories at a time; false when cancelled part-way. */
async function walk(
  folderId: ObjectId,
  libraryRoot: string,
  ctx: JobHandlerContext,
  state: WalkState,
): Promise<boolean> {
  if (state.queue.length === 0) return true;
  if (await ctx.shouldCancel()) return false;
  const listings = await Promise.all(state.queue.slice(0, CONCURRENCY).map(listDirectory));
  const files = listings.flatMap((listing) => listing.files);
  await dispatchPool(files, CONCURRENCY, (absPath) =>
    handleEvent({ kind: 'created', absPath }, folderId, libraryRoot).catch((err: unknown) =>
      log.warn(
        { absPath, err: err instanceof Error ? err.message : err },
        'discover upsert failed during folder scan',
      ),
    ),
  );
  const found = state.found + files.length;
  await ctx.reportProgress(found, 0);
  return walk(folderId, libraryRoot, ctx, {
    queue: [...state.queue.slice(CONCURRENCY), ...listings.flatMap((listing) => listing.dirs)],
    found,
  });
}

export const folderScanHandler: JobHandler = {
  async run(payload, ctx) {
    const folderId = typeof payload['folderId'] === 'string' ? payload['folderId'] : '';
    if (!ObjectId.isValid(folderId)) throw new Error('A folder scan needs a folderId');
    const folder = await findFolderById(new ObjectId(folderId));
    if (folder === null) throw new Error('Folder not found');
    const completed = await walk(folder._id, folder.path, ctx, { queue: [folder.path], found: 0 });
    if (!completed) return { kind: 'cancelled', result: { last_scan: null } };
    const scannedAt = new Date().toISOString();
    await setFolderLastScan(folder._id, scannedAt);
    return { kind: 'done', result: { last_scan: scannedAt } };
  },
};
