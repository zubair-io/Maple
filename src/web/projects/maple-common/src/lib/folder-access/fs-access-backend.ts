// Chromium File System Access API backend.
// All the quirks of FileSystemDirectoryHandle are encapsulated here so the
// unified service never has to touch the native API directly.
//
// TypeScript's built-in lib does not include the full FS Access API (permission
// methods, showDirectoryPicker options) — we use inline ambient interfaces where
// needed to avoid requiring a separate @types package.

import { MapleFolderHandle, FolderEntry, PersistedHandleRecord } from './folder-access.types';
import { openDb, reqToPromise, txDone } from '../util/idb';

// ── Ambient type patches for FS Access API gaps in TS lib ────────────────────

interface FsHandleWithPermission extends FileSystemDirectoryHandle {
  queryPermission(desc: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission(desc: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}

interface FsFileHandleWithWritable extends FileSystemFileHandle {
  createWritable(): Promise<FileSystemWritableFileStream>;
}

interface WindowWithDirectoryPicker extends Window {
  showDirectoryPicker(opts?: {
    mode?: 'read' | 'readwrite';
    id?: string;
    startIn?: string;
  }): Promise<FileSystemDirectoryHandle>;
}

const IDB_DB_NAME = 'maple-fs-handles';
const IDB_STORE = 'handles';
const IDB_VERSION = 1;

// ── IndexedDB helpers ─────────────────────────────────────────────────────────

function openHandleDb(): Promise<IDBDatabase> {
  return openDb(IDB_DB_NAME, IDB_VERSION, (db) => {
    db.createObjectStore(IDB_STORE, { keyPath: 'key' });
  });
}

async function persistHandle(handle: FileSystemDirectoryHandle): Promise<string> {
  const key = crypto.randomUUID();
  const record: PersistedHandleRecord = {
    key,
    name: handle.name,
    handle,
    accessedAt: Date.now(),
  };
  const db = await openHandleDb();
  const tx = db.transaction(IDB_STORE, 'readwrite');
  tx.objectStore(IDB_STORE).put(record);
  await txDone(tx).finally(() => db.close());
  return key;
}

export async function getPersistedHandles(): Promise<PersistedHandleRecord[]> {
  const db = await openHandleDb();
  const tx = db.transaction(IDB_STORE, 'readonly');
  const result = await reqToPromise(tx.objectStore(IDB_STORE).getAll()).finally(() => db.close());
  return result as PersistedHandleRecord[];
}

export async function removePersistedHandle(key: string): Promise<void> {
  const db = await openHandleDb();
  const tx = db.transaction(IDB_STORE, 'readwrite');
  tx.objectStore(IDB_STORE).delete(key);
  await txDone(tx).finally(() => db.close());
}

// ── Permission helpers ────────────────────────────────────────────────────────

async function verifyPermission(
  handle: FileSystemDirectoryHandle,
  mode: 'read' | 'readwrite',
): Promise<boolean> {
  const h = handle as FsHandleWithPermission;
  if (typeof h.queryPermission !== 'function') {
    // Browser doesn't implement permission API — assume granted (no-op).
    return true;
  }
  if ((await h.queryPermission({ mode })) === 'granted') return true;
  return (await h.requestPermission({ mode })) === 'granted';
}

// ── Open folder ───────────────────────────────────────────────────────────────

/**
 * Prompt the user to pick a directory via the FS Access API.
 * Returns null if the user cancels or denies permission.
 */
export async function fsAccessOpenFolder(): Promise<MapleFolderHandle | null> {
  let nativeHandle: FileSystemDirectoryHandle;
  try {
    nativeHandle = await (window as unknown as WindowWithDirectoryPicker).showDirectoryPicker({
      mode: 'readwrite',
      id: 'maple-folder',
    });
  } catch {
    // AbortError or SecurityError — user cancelled.
    return null;
  }

  return fsAccessOpenDroppedFolder(nativeHandle);
}

/**
 * Normalize a directory handle supplied by drag/drop instead of the picker.
 * Chrome exposes the same permission contract for both entry points.
 */
export async function fsAccessOpenDroppedFolder(
  nativeHandle: FileSystemDirectoryHandle,
): Promise<MapleFolderHandle | null> {
  // Try readwrite first; fall back to read-only.
  const write = await verifyPermission(nativeHandle, 'readwrite');
  const read = write || (await verifyPermission(nativeHandle, 'read'));
  if (!read) return null;

  let persistedKey: string | undefined;
  try {
    persistedKey = await persistHandle(nativeHandle);
  } catch {
    // Non-fatal: continue without persistence.
  }

  return { name: nativeHandle.name, read, write, native: nativeHandle, persistedKey };
}

/**
 * Re-open a previously persisted handle.  The browser will re-prompt for
 * permission if the page has been reloaded.
 */
export async function fsAccessReopenHandle(
  record: PersistedHandleRecord,
): Promise<MapleFolderHandle | null> {
  const nativeHandle = record.handle;
  const write = await verifyPermission(nativeHandle, 'readwrite');
  const read = write || (await verifyPermission(nativeHandle, 'read'));
  if (!read) return null;
  return {
    name: nativeHandle.name,
    read,
    write,
    native: nativeHandle,
    persistedKey: record.key,
  };
}

/** Request write access for an already-open read-only handle. */
export async function fsAccessRequestWrite(folder: MapleFolderHandle): Promise<boolean> {
  if (!folder.native) return false;
  return verifyPermission(folder.native, 'readwrite');
}

// ── List entries ──────────────────────────────────────────────────────────────

export async function fsAccessListEntries(folder: MapleFolderHandle): Promise<FolderEntry[]> {
  if (!folder.native) return [];
  const entries: FolderEntry[] = [];
  for await (const [name, handle] of folder.native.entries()) {
    if (handle.kind === 'file') {
      const fileHandle = handle as FileSystemFileHandle;
      entries.push({
        name,
        kind: 'file',
        getFile: () => fileHandle.getFile(),
        getSubFolder: () => Promise.reject(new Error('Not a directory')),
      });
    } else {
      const dirHandle = handle as FileSystemDirectoryHandle;
      entries.push({
        name,
        kind: 'directory',
        getFile: () => Promise.reject(new Error('Not a file')),
        getSubFolder: async (): Promise<MapleFolderHandle> => ({
          name,
          read: folder.read,
          write: folder.write,
          native: dirHandle,
        }),
      });
    }
  }
  return entries;
}

// ── Read file ─────────────────────────────────────────────────────────────────

/**
 * Read a path like '.maple/index.json' relative to the folder.
 * Throws if not found or access denied.
 */
export async function fsAccessReadFile(
  folder: MapleFolderHandle,
  path: string,
): Promise<Uint8Array> {
  if (!folder.native) throw new Error('fs-access: no native handle');
  const parts = path.split('/').filter((p) => p.length > 0 && p !== '.');
  let dir: FileSystemDirectoryHandle = folder.native;
  for (let i = 0; i < parts.length - 1; i++) {
    dir = await dir.getDirectoryHandle(parts[i], { create: false });
  }
  const filename = parts[parts.length - 1];
  const fileHandle = await dir.getFileHandle(filename ?? '', { create: false });
  const file = await fileHandle.getFile();
  return new Uint8Array(await file.arrayBuffer());
}

// ── Write file ────────────────────────────────────────────────────────────────

/**
 * Write `data` to `path` relative to the folder. Creates intermediate
 * directories as needed. Uses a FileSystemWritableFileStream.
 */
export async function fsAccessWriteFile(
  folder: MapleFolderHandle,
  path: string,
  data: Uint8Array,
): Promise<void> {
  if (!folder.native) throw new Error('fs-access: no native handle');
  if (!folder.write) throw new Error('fs-access: no write permission');
  const parts = path.split('/').filter((p) => p.length > 0 && p !== '.');
  let dir: FileSystemDirectoryHandle = folder.native;
  for (let i = 0; i < parts.length - 1; i++) {
    dir = await dir.getDirectoryHandle(parts[i], { create: true });
  }
  const filename = parts[parts.length - 1];
  const fileHandle = await dir.getFileHandle(filename ?? '', { create: true });
  const writable = await (fileHandle as FsFileHandleWithWritable).createWritable();
  // Copy into a plain ArrayBuffer so the writable stream gets the correct type.
  const ab = new ArrayBuffer(data.byteLength);
  new Uint8Array(ab).set(data);
  await writable.write(ab);
  await writable.close();
}

// ── Ensure subdirectory ───────────────────────────────────────────────────────

export async function fsAccessEnsureSubdirectory(
  folder: MapleFolderHandle,
  name: string,
): Promise<MapleFolderHandle> {
  if (!folder.native) throw new Error('fs-access: no native handle');
  const parts = name.split('/').filter((p) => p.length > 0 && p !== '.');
  let dir: FileSystemDirectoryHandle = folder.native;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: folder.write });
  }
  return { name, read: folder.read, write: folder.write, native: dir };
}
