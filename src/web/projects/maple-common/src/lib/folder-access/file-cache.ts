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

import { openDb, reqToPromise, txDone } from '../util/idb';

const IDB_DB_NAME = 'maple-file-cache';
const IDB_STORE = 'files';
const IDB_VERSION = 1;

export interface PersistedFileRecord {
  id: string;
  filename: string;
  file: File;
  storedAt: number;
  xmp?: string;
}

function openFileDb(): Promise<IDBDatabase> {
  return openDb(IDB_DB_NAME, IDB_VERSION, (db) => {
    db.createObjectStore(IDB_STORE, { keyPath: 'id' });
  });
}

export async function persistFile(id: string, file: File, xmp?: string): Promise<void> {
  const db = await openFileDb();
  const tx = db.transaction(IDB_STORE, 'readwrite');
  const record: PersistedFileRecord = {
    id,
    filename: file.name,
    file,
    storedAt: Date.now(),
    xmp,
  };
  tx.objectStore(IDB_STORE).clear();
  tx.objectStore(IDB_STORE).put(record);
  await txDone(tx).finally(() => db.close());
}

export async function getPersistedFile(id: string): Promise<PersistedFileRecord | null> {
  const db = await openFileDb();
  const tx = db.transaction(IDB_STORE, 'readonly');
  const result = await reqToPromise(tx.objectStore(IDB_STORE).get(id)).finally(() => db.close());
  return (result as PersistedFileRecord | undefined) ?? null;
}

export async function deletePersistedFile(id: string): Promise<void> {
  const db = await openFileDb();
  const tx = db.transaction(IDB_STORE, 'readwrite');
  tx.objectStore(IDB_STORE).delete(id);
  await txDone(tx).finally(() => db.close());
}
