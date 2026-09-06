/** Browser folder writes use a durable hash journal and the browser's atomic writable stream. */
import { sha256 } from '@noble/hashes/sha2.js';
import type { RecipeEntry, RecipeQueueRecord } from './export-recipe-store';

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
    if (error instanceof DOMException && error.name === 'NotFoundError') return null;
    throw error;
  }
}
async function fileHash(handle: FileSystemFileHandle | null): Promise<string | null> {
  return handle ? digest(await handle.getFile()) : null;
}
async function guardOriginal(
  handle: FileSystemFileHandle | null,
  record: RecipeQueueRecord,
): Promise<void> {
  if (!handle) return;
  for (const source of record.targets) {
    if (!source.sourceHandle)
      throw new Error('Original identity unavailable. Reopen the source folder.');
    if (await handle.isSameEntry(source.sourceHandle))
      throw new Error(
        'Destination is an original photo. Choose another folder or naming template.',
      );
  }
}
export async function prepareDirectoryEntry(
  record: RecipeQueueRecord,
  id: string,
  filename: string,
): Promise<RecipeEntry> {
  const handle = await existing(record.directoryHandle!, filename);
  await guardOriginal(handle, record);
  const beforeHash = await fileHash(handle);
  if (handle && record.recipe.overwritePolicy === 'skip')
    return { id, filename, status: 'skipped' };
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
  await guardOriginal(handle, record);
  if ((await fileHash(handle)) !== entry.beforeHash)
    throw new Error('Output changed while rendering. Review the destination before retrying.');
  const writing: RecipeEntry = { ...entry, status: 'writing', afterHash: await digest(blob) };
  // This marker MUST commit before createWritable or its final close can change any output.
  await save(writing);
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
    if (current === entry.afterHash) record.entries[index] = { ...entry, status: 'applied' };
    else if (current === entry.beforeHash)
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
