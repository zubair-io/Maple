// FilmLutIdbCache — thin IndexedDB write-through layer for FilmLutService
// (epic #2683, Task 12).
//
// Stores the raw `.mlut` v1 bytes keyed by the film-catalog id (the same id
// that doubles as `papp:FilmLook` and the `.mlut` filename stem — see
// `film-catalog.generated.ts`). A cache hit skips the network fetch entirely
// on repeat selection of a look already downloaded this session/device.
//
// Shape mirrors `xmp/sidecar-idb-cache.ts` — a hand-rolled IDB module on top
// of the shared `util/idb.ts` primitives, per `best-practices.md` ("don't
// reinvent the wheel" but also don't pull in a dependency for a three-method
// surface).

import { Injectable, InjectionToken, inject } from '@angular/core';
import { openDb, reqToPromise, txDone } from '../util/idb';

const IDB_DB_NAME = 'maple-film-lut-cache';
const IDB_STORE = 'luts-by-id';
const IDB_VERSION = 1;

/** Persisted record. `bytes` is the raw `.mlut` v1 buffer, byte-identical to
 *  what the network served — no re-encoding on write or read. */
interface FilmLutCacheRecord {
  /** Film-catalog id (== `papp:FilmLook` value == `.mlut` filename stem). */
  id: string;
  bytes: ArrayBuffer;
  storedAt: number;
}

/**
 * Contract used by `FilmLutService`. Implementations must not throw on a
 * missing key — return `null` instead. Errors are reserved for "the cache
 * itself is broken" (quota, schema mismatch); the service logs + bypasses.
 */
export interface FilmLutCache {
  get(id: string): Promise<ArrayBuffer | null>;
  put(id: string, bytes: ArrayBuffer): Promise<void>;
}

@Injectable({ providedIn: 'root' })
class FilmLutIdbCache implements FilmLutCache {
  async get(id: string): Promise<ArrayBuffer | null> {
    const db = await this._open();
    const tx = db.transaction(IDB_STORE, 'readonly');
    const result = await reqToPromise(tx.objectStore(IDB_STORE).get(id)).finally(() => db.close());
    const record = result as FilmLutCacheRecord | undefined;
    return record ? record.bytes : null;
  }

  async put(id: string, bytes: ArrayBuffer): Promise<void> {
    const db = await this._open();
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const record: FilmLutCacheRecord = { id, bytes, storedAt: Date.now() };
    tx.objectStore(IDB_STORE).put(record);
    await txDone(tx).finally(() => db.close());
  }

  private _open(): Promise<IDBDatabase> {
    return openDb(IDB_DB_NAME, IDB_VERSION, (db) => {
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: 'id' });
      }
    });
  }
}

/** In-memory implementation. Exposed so tests can provide an alternative
 *  without touching real IndexedDB (`Maple-common`'s vitest run has no
 *  IndexedDB implementation — see `util/idb.spec.ts`'s header note). */
export class InMemoryFilmLutCache implements FilmLutCache {
  private readonly entries = new Map<string, ArrayBuffer>();

  async get(id: string): Promise<ArrayBuffer | null> {
    return this.entries.get(id) ?? null;
  }

  async put(id: string, bytes: ArrayBuffer): Promise<void> {
    this.entries.set(id, bytes);
  }
}

/** DI token used by `FilmLutService` so tests can substitute the in-memory
 *  implementation without faking IndexedDB itself. */
export const FILM_LUT_CACHE = new InjectionToken<FilmLutCache>('FILM_LUT_CACHE', {
  providedIn: 'root',
  factory: () => inject(FilmLutIdbCache),
});
