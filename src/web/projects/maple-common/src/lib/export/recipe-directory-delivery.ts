/** Browser folder writes use a durable hash journal and the browser's atomic writable stream. */
import { sha256 } from '@noble/hashes/sha2.js';
import { SUPPORTED_RAW_EXTENSIONS } from '../state/raw-extensions';
import type { RecipeEntry, RecipeQueueRecord } from './export-recipe-store';

const PROTECTED_ORIGINAL_EXTENSIONS = new Set([
  ...SUPPORTED_RAW_EXTENSIONS,
  'jpg',
  'jpeg',
  'png',
  'webp',
  'gif',
  'tif',
  'tiff',
  'heic',
  'heif',
  'avif',
  'bmp',
  'psd',
  'psb',
  'hdr',
]);

const directoryFileCache = new WeakMap<
  FileSystemDirectoryHandle,
  Promise<Map<string, FileSystemFileHandle>>
>();

function directoryFileIndex(
  directory: FileSystemDirectoryHandle,
): Promise<Map<string, FileSystemFileHandle>> {
  let cached = directoryFileCache.get(directory);
  if (!cached) {
    cached = (async () => {
      const map = new Map<string, FileSystemFileHandle>();
      const iterable = directory as Partial<
        Record<'values', () => AsyncIterable<FileSystemHandle>>
      >;
      if (typeof iterable.values !== 'function') return map;
      for await (const entry of iterable.values()) {
        if (entry.kind === 'file') map.set(entry.name.toLowerCase(), entry as FileSystemFileHandle);
      }
      return map;
    })();
    directoryFileCache.set(directory, cached);
  }
  return cached;
}

function isCreatedByExport(
  record: RecipeQueueRecord,
  filename: string,
  actualName: string,
  currentHash: string | null,
): boolean {
  if (!currentHash || !record.createdOutputs) return false;
  const expected =
    record.createdOutputs[filename.toLowerCase()] ??
    record.createdOutputs[actualName.toLowerCase()];
  return expected === currentHash;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

async function digest(blob: Blob): Promise<string> {
  const hash = sha256.create();
  const reader = blob.stream().getReader();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      hash.update(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Array.from(hash.digest(), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
async function existing(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemFileHandle | null> {
  try {
    return await directory.getFileHandle(name);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
    return (await directoryFileIndex(directory)).get(name.toLowerCase()) ?? null;
  }
}
async function fileHash(handle: FileSystemFileHandle | null): Promise<string | null> {
  return handle ? digest(await handle.getFile()) : null;
}
async function guardSelectedOriginals(
  handle: FileSystemFileHandle,
  originals: (FileSystemFileHandle | null)[] | undefined,
): Promise<void> {
  // Legacy records may already be filtered by a retry. Their full identity set is lost.
  if (!originals?.length)
    throw new Error(
      'Original identity unavailable for this saved export. Reopen the source folder and start a new export.',
    );
  for (const source of originals) {
    if (!source) throw new Error('Original identity unavailable. Reopen the source folder.');
    if (await handle.isSameEntry(source))
      throw new Error(
        'Destination is an original photo. Choose another folder or naming template.',
      );
  }
}
async function guardOriginal(
  handle: FileSystemFileHandle | null,
  record: RecipeQueueRecord,
  filename: string,
  currentHash: string | null,
): Promise<void> {
  if (!handle) return;
  await guardSelectedOriginals(handle, record.protectedOriginals);
  if (record.recipe.overwritePolicy !== 'replace') return;
  const actualName = handle.name || filename;
  const ext = extensionOf(actualName);
  if (
    ext === 'xmp' ||
    (PROTECTED_ORIGINAL_EXTENSIONS.has(ext) &&
      !isCreatedByExport(record, filename, actualName, currentHash))
  )
    throw new Error('Destination is an original photo. Choose another folder or naming template.');
}
export async function prepareDirectoryEntry(
  record: RecipeQueueRecord,
  id: string,
  filename: string,
): Promise<RecipeEntry> {
  const handle = await existing(record.directoryHandle!, filename);
  if (handle && record.recipe.overwritePolicy === 'skip')
    return { id, filename, status: 'skipped' };
  const beforeHash = await fileHash(handle);
  await guardOriginal(handle, record, filename, beforeHash);
  if (handle && record.recipe.overwritePolicy === 'error')
    throw new Error(`Output already exists: ${filename}. Choose another name, skip, or replace.`);
  return { id, filename, status: 'rendering', beforeHash };
}

export async function deliverDirectoryEntry(
  record: RecipeQueueRecord,
  entry: RecipeEntry,
  blob: Blob,
  save: (entry: RecipeEntry) => Promise<void>,
): Promise<RecipeEntry> {
  const directory = record.directoryHandle!;
  const filename = entry.filename!;
  let handle = await existing(directory, filename);
  const currentBefore = await fileHash(handle);
  await guardOriginal(handle, record, filename, currentBefore);
  if (currentBefore !== entry.beforeHash)
    throw new Error('Output changed while rendering. Review the destination before retrying.');
  const afterHash = await digest(blob);
  const previousCreated = record.createdOutputs;
  record.createdOutputs = { ...previousCreated, [filename.toLowerCase()]: afterHash };
  const writing: RecipeEntry = { ...entry, status: 'writing', afterHash };
  // This marker MUST commit before createWritable or its final close can change any output.
  try {
    await save(writing);
  } catch (error) {
    record.createdOutputs = previousCreated;
    throw error;
  }
  // Existing entries were identity-checked above. A new entry remains empty until close.
  handle ??= await directory.getFileHandle(filename, { create: true });
  const writer = await handle.createWritable();
  try {
    const current = await fileHash(handle);
    // A newly created destination is empty until close; existing outputs must still match.
    if (entry.beforeHash !== null && current !== entry.beforeHash)
      throw new Error('Output changed before publication. Review it before retrying.');
    if (entry.beforeHash === null && (await handle.getFile()).size !== 0)
      throw new Error('Another file appeared at the destination. Review it before retrying.');
    await writer.write(blob);
    await writer.close();
  } catch (error) {
    await writer.abort().catch(() => undefined);
    throw error;
  }
  return { ...writing, status: 'applied' };
}

/** Reconcile a lost completion acknowledgement using actual bytes, never blindly re-export. */
export async function recoverDirectoryWrites(
  record: RecipeQueueRecord,
): Promise<RecipeQueueRecord> {
  if (!record.directoryHandle) return record;
  for (const [index, entry] of record.entries.entries()) {
    if (entry.status !== 'writing' || !entry.filename) continue;
    const handle = await existing(record.directoryHandle, entry.filename);
    const current = await fileHash(handle);
    if (current === entry.afterHash) {
      if (entry.afterHash)
        record.createdOutputs = {
          ...record.createdOutputs,
          [entry.filename.toLowerCase()]: entry.afterHash,
        };
      record.entries[index] = { ...entry, status: 'applied' };
    } else if (current === entry.beforeHash)
      record.entries[index] = { id: entry.id, status: 'pending' };
    else
      record.entries[index] = {
        ...entry,
        status: 'failed',
        reason:
          'Destination changed during interruption. Review the file before retrying; a new empty file may need removal.',
      };
  }
  return record;
}
