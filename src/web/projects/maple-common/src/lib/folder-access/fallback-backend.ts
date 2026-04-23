// Fallback backend for browsers without the File System Access API (Safari, Firefox).
// Uses <input webkitdirectory> to obtain a FileList for the session,
// and IndexedDB as an in-session key-value store for any .maple/ cache data
// (since we can't write back to the real filesystem).

import { MapleFolderHandle, FolderEntry } from './folder-access.types';

const IDB_DB_NAME = 'maple-fallback-cache';
const IDB_STORE   = 'blobs';
const IDB_VERSION = 1;

// ── IndexedDB blob store ──────────────────────────────────────────────────────

function openBlobDb(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(IDB_DB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/** Store blob data under a composite key: `<folderLabel>/<path>`. */
export async function fallbackWriteBlob(
  folderLabel: string,
  path: string,
  data: Uint8Array,
): Promise<void> {
  const db = await openBlobDb();
  await new Promise<void>((resolve, reject) => {
    const key = `${folderLabel}/${path}`;
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(data, key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror    = () => { db.close(); reject(tx.error); };
  });
}

/** Retrieve blob data stored for `<folderLabel>/<path>`. */
export async function fallbackReadBlob(
  folderLabel: string,
  path: string,
): Promise<Uint8Array | null> {
  const db = await openBlobDb();
  return new Promise<Uint8Array | null>((resolve, reject) => {
    const key = `${folderLabel}/${path}`;
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => { db.close(); resolve((req.result as Uint8Array) ?? null); };
    req.onerror   = () => { db.close(); reject(req.error); };
  });
}

// ── Trigger file picker ───────────────────────────────────────────────────────

/**
 * Show a hidden <input webkitdirectory> element, wait for user selection,
 * and return a MapleFolderHandle backed by the resulting FileList.
 * Returns null if the user cancels.
 */
export function fallbackOpenFolder(): Promise<MapleFolderHandle | null> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
    input.multiple = true;
    input.style.display = 'none';
    document.body.appendChild(input);

    const cleanup = () => {
      document.body.removeChild(input);
    };

    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? []);
      cleanup();
      if (!files.length) { resolve(null); return; }
      // Derive the folder name from the common path prefix.
      const firstPath = (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath ?? files[0].name;
      const folderName = firstPath.split('/')[0] ?? 'folder';
      resolve({
        name: folderName,
        read: true,
        write: false, // can't write back without FS Access
        fallbackFiles: files,
      });
    });

    input.addEventListener('cancel', () => {
      cleanup();
      resolve(null);
    });

    input.click();
  });
}

// ── List entries ──────────────────────────────────────────────────────────────

/**
 * Return FolderEntry objects for the flat FileList stored in the fallback handle.
 * We only expose files at the root level (depth === 1 within the folder).
 */
export function fallbackListEntries(
  folder: MapleFolderHandle,
): FolderEntry[] {
  const files = folder.fallbackFiles ?? [];
  const folderName = folder.name;
  // Keep only top-level files (webkitRelativePath = "FolderName/filename").
  const topLevel = files.filter(f => {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath ?? f.name;
    const parts = rel.split('/');
    return parts.length === 2 && parts[0] === folderName;
  });

  return topLevel.map(f => {
    const name = ((f as File & { webkitRelativePath?: string }).webkitRelativePath ?? f.name)
      .split('/').pop() ?? f.name;
    return {
      name,
      kind: 'file' as const,
      getFile: () => Promise.resolve(f),
      getSubFolder: () => Promise.reject(new Error('Subdirectories not supported in fallback mode')),
    };
  });
}

// ── Read file (fallback = read from FileList or IndexedDB) ────────────────────

export async function fallbackReadFile(
  folder: MapleFolderHandle,
  path: string,
): Promise<Uint8Array> {
  const parts = path.split('/').filter(p => p.length > 0);
  const filename = parts[parts.length - 1];

  // For .maple/ paths, check IndexedDB first (written by us this session).
  if (path.startsWith('.maple/') || path.startsWith('.maple\\')) {
    const cached = await fallbackReadBlob(folder.name, path);
    if (cached) return cached;
    throw new Error(`fallback: file not found in IDB: ${path}`);
  }

  // For regular files, find in the FileList.
  const files = folder.fallbackFiles ?? [];
  const match = files.find(f => {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath ?? f.name;
    const fname = rel.split('/').pop();
    return fname === filename;
  });
  if (!match) throw new Error(`fallback: file not found: ${filename}`);
  return new Uint8Array(await match.arrayBuffer());
}

// ── Write file (fallback = write to IndexedDB only) ───────────────────────────

export async function fallbackWriteFile(
  folder: MapleFolderHandle,
  path: string,
  data: Uint8Array,
): Promise<void> {
  // Write to IndexedDB; we can't touch the real FS.
  await fallbackWriteBlob(folder.name, path, data);
}

// ── Ensure subdirectory (no-op in fallback) ───────────────────────────────────

export async function fallbackEnsureSubdirectory(
  folder: MapleFolderHandle,
  _name: string,
): Promise<MapleFolderHandle> {
  // No real directory to create; return a virtual sub-handle.
  return { ...folder, write: false };
}
