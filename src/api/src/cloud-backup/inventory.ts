import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { constants, open, lstat, realpath, type FileHandle } from '../fs/mirrored.ts';
import { listPairedSidecarsStrict } from '../fs/xmp-conflict.ts';
import type { PublishSource } from './provider.ts';
import { BackupRepository } from './repository.ts';

export interface InventoryLocation {
  asset_id: string;
  ordinal: number;
  library_id: string;
  root: string;
  relative_path: string;
  original_path: string | null;
  deleted_at: string | null;
  hidden: number;
  apple_rendered_path: string | null;
}
export interface CapturedFile {
  path: string;
  absolutePath: string;
  role: 'original' | 'sidecar' | 'companion';
  stamp: string;
  source: PublishSource;
  /** The engine releases the pinned descriptor after every transfer outcome. */
  close: () => Promise<void>;
}

export async function assetInventory(
  assetId: string,
  libraryId: string,
  repo = new BackupRepository(),
): Promise<InventoryLocation[]> {
  return repo.db.read<InventoryLocation>(
    `SELECT l.asset_id,l.ordinal,l.library_id,f.path AS root,
    CASE WHEN l.path='' THEN l.filename ELSE l.path||'/'||l.filename END AS relative_path,
    a.original_path,a.deleted_at,a.hidden,a.apple_rendered_path
    FROM asset_locations l JOIN assets a ON a.id=l.asset_id JOIN folders f ON f.id=l.library_id
    WHERE l.asset_id=? AND l.library_id=? AND l.deleted_at IS NULL AND l.missing_since IS NULL
    AND (a.deleted_reason IS NULL OR a.deleted_reason!='reaped')`,
    [assetId, libraryId],
  );
}

export function relativeBackupPath(value: string): string {
  if (
    !value ||
    value.length > 4096 ||
    value.includes('\\') ||
    value.includes('\0') ||
    path.posix.isAbsolute(value) ||
    value.split('/').some((p) => !p || p === '.' || p === '..')
  )
    throw new Error('Unsafe backup path');
  return value;
}

/** Recheck every component. Readers additionally pin and verify an O_NOFOLLOW descriptor. */
export async function jailedFile(root: string, relative: string): Promise<string> {
  relativeBackupPath(relative);
  const canonicalRoot = await realpath(root);
  const components = relative.split('/');
  const absolute = path.join(canonicalRoot, ...components);
  for (const [index] of components.entries()) {
    const component = path.join(canonicalRoot, ...components.slice(0, index + 1));
    if ((await lstat(component)).isSymbolicLink())
      throw new Error('Backup path contains a symlink');
  }
  if ((await realpath(absolute)) !== absolute) throw new Error('Backup file escaped library');
  return absolute;
}

function fileStamp(value: {
  isFile(): boolean;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}): string {
  if (!value.isFile()) throw new Error('Backup source is not a regular file');
  return `${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`;
}

async function verifyPinned(
  handle: FileHandle,
  expected: string,
  absolute: string,
  root?: string,
  relative?: string,
): Promise<void> {
  if (fileStamp(await handle.stat()) !== expected)
    throw new Error('Backup source changed during reading');
  if (
    root !== undefined &&
    relative !== undefined &&
    (await jailedFile(root, relative)) !== absolute
  )
    throw new Error('Backup source escaped its captured library');
  // Do not read a newly substituted file, even if it has identical bytes and timestamps.
  if (fileStamp(await lstat(absolute)) !== expected)
    throw new Error('Backup source path changed during reading');
  if (fileStamp(await handle.stat()) !== expected)
    throw new Error('Backup source changed during reading');
}

const CHUNK_SIZE = 256 * 1024;
async function descriptorHash(
  handle: FileHandle,
  expected: string,
  absolute: string,
  size: number,
  root?: string,
  relative?: string,
  signal?: AbortSignal,
): Promise<string> {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
  let offset = 0;
  while (offset < size) {
    signal?.throwIfAborted();
    await verifyPinned(handle, expected, absolute, root, relative);
    const { bytesRead } = await handle.read(
      buffer,
      0,
      Math.min(buffer.length, size - offset),
      offset,
    );
    if (bytesRead === 0) throw new Error('Backup source was truncated during hashing');
    await verifyPinned(handle, expected, absolute, root, relative);
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  await verifyPinned(handle, expected, absolute, root, relative);
  return hash.digest('hex');
}

/** Also used for recovery's staged file; never follow a substituted final-component symlink. */
export async function fileHash(absolute: string): Promise<string> {
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    return await descriptorHash(handle, fileStamp(stat), absolute, stat.size);
  } finally {
    await handle.close();
  }
}

function descriptorStream(
  handle: FileHandle,
  expected: string,
  absolute: string,
  root: string,
  relative: string,
  size: number,
  start: number,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  if (!Number.isSafeInteger(start) || start < 0 || start > size)
    throw new Error('Invalid backup read offset');
  let offset = start;
  // Explicit positions permit retries/range reads without sharing a descriptor seek cursor.
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          signal?.throwIfAborted();
          await verifyPinned(handle, expected, absolute, root, relative);
          if (offset === size) {
            controller.close();
            return;
          }
          const buffer = Buffer.allocUnsafe(Math.min(CHUNK_SIZE, size - offset));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
          if (bytesRead === 0) throw new Error('Backup source was truncated during transfer');
          await verifyPinned(handle, expected, absolute, root, relative);
          offset += bytesRead;
          controller.enqueue(buffer.subarray(0, bytesRead));
        } catch (error) {
          controller.error(error);
        }
      },
    },
    { highWaterMark: 0 },
  );
}

function contentType(absolute: string, role: CapturedFile['role']): string {
  if (role === 'sidecar') return 'application/rdf+xml';
  const extension = path.extname(absolute).slice(1).toLowerCase();
  const known: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    heic: 'image/heic',
    heif: 'image/heif',
    dng: 'image/x-adobe-dng',
    avif: 'image/avif',
    webp: 'image/webp',
    gif: 'image/gif',
    bmp: 'image/bmp',
    mov: 'video/quicktime',
    mp4: 'video/mp4',
  };
  return known[extension] ?? 'application/octet-stream';
}

async function captureFile(
  root: string,
  relative: string,
  role: CapturedFile['role'],
  signal?: AbortSignal,
): Promise<CapturedFile> {
  signal?.throwIfAborted();
  const absolute = await jailedFile(root, relative);
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    const stamp = fileStamp(stat);
    const sha256 = await descriptorHash(handle, stamp, absolute, stat.size, root, relative, signal);
    let closed = false;
    return {
      path: relative,
      absolutePath: absolute,
      role,
      stamp,
      source: {
        size: stat.size,
        sha256,
        name: path.basename(absolute),
        contentType: contentType(absolute, role),
        open: (offset) =>
          descriptorStream(handle, stamp, absolute, root, relative, stat.size, offset, signal),
      },
      close: async () => {
        if (!closed) {
          closed = true;
          await handle.close();
        }
      },
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function releaseCapture(files: readonly CapturedFile[]): Promise<void> {
  const results = await Promise.allSettled(files.map((file) => file.close()));
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}

export async function captureInventory(
  location: InventoryLocation,
  signal?: AbortSignal,
): Promise<CapturedFile[]> {
  const root = await realpath(location.root);
  const original = await jailedFile(root, location.relative_path);
  const sidecars = (await listPairedSidecarsStrict(original)).sort();
  const companion = location.apple_rendered_path
    ? [await jailedFile(root, location.apple_rendered_path)]
    : [];
  const paths = [
    { absolute: original, role: 'original' as const },
    ...sidecars.map((absolute) => ({ absolute, role: 'sidecar' as const })),
    ...companion
      .filter((p) => p !== original)
      .map((absolute) => ({ absolute, role: 'companion' as const })),
  ];
  const result: CapturedFile[] = [];
  try {
    for (const file of paths) {
      const relative = path.relative(root, file.absolute).split(path.sep).join('/');
      result.push(await captureFile(root, relative, file.role, signal));
    }
    return result;
  } catch (error) {
    await releaseCapture(result);
    throw error;
  }
}

export async function validateCapture(
  location: InventoryLocation,
  files: CapturedFile[],
  signal?: AbortSignal,
): Promise<void> {
  const current = await captureInventory(location, signal);
  try {
    if (
      JSON.stringify(current.map((f) => [f.path, f.stamp, f.source.sha256])) !==
      JSON.stringify(files.map((f) => [f.path, f.stamp, f.source.sha256]))
    )
      throw new Error('Backup source or sidecar set changed during transfer');
  } finally {
    await releaseCapture(current);
  }
}
