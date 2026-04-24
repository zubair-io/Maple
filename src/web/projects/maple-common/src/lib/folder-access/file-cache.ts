// Persistent per-file cache for Hosted imports.
//
// When a user picks a single RAW via the landing page, the resulting
// `/edit/<assetId>` URL should survive a reload — the app stores the File
// (name + bytes, via IndexedDB structured clone) under the same UUID that
// appears in the URL. `editor-shell` consults this cache as a fallback when
// the in-memory asset signal is empty (e.g. after a hard refresh).
//
// This is intentionally separate from `fs-access-backend.ts` which persists
// FS Access *handles* (folders). Single-file imports normally come from a
// plain `<input type="file">` where no persistent handle exists, so we
// persist the File blob itself.

const IDB_DB_NAME = 'maple-file-cache';
const IDB_STORE = 'files';
const IDB_VERSION = 1;

export interface PersistedFileRecord {
  id: string;
  filename: string;
  file: File;
  storedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_DB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IDB_STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function persistFile(id: string, file: File): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const record: PersistedFileRecord = {
      id,
      filename: file.name,
      file,
      storedAt: Date.now(),
    };
    tx.objectStore(IDB_STORE).put(record);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function getPersistedFile(id: string): Promise<PersistedFileRecord | null> {
  const db = await openDb();
  return new Promise<PersistedFileRecord | null>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(id);
    req.onsuccess = () => {
      db.close();
      resolve((req.result as PersistedFileRecord | undefined) ?? null);
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

export async function deletePersistedFile(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(id);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}
