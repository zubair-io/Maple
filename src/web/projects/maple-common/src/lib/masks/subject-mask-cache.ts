// subject-mask-cache.ts — browser-side store for person-skin rasters (#3300).
//
// IndexedDB `maple-subject-masks`, keyed by the recipe digest — the web half
// of Apple's `.maple/masks/<digest>.png` (`MaskRasterStore`). Bytes are the
// server's PNG verbatim (never re-encoded); the caller decodes to R8 on the
// way into the render worker's registry. Tabulated in docs/caching.md.
//
// Shape mirrors `film/film-lut-idb-cache.ts`: an interface, the real IDB
// implementation, and an in-memory one for the vitest run (which has no
// IndexedDB).

import { Injectable, InjectionToken, inject } from '@angular/core';
import { openDb, reqToPromise, txDone } from '../util/idb';

const IDB_DB_NAME = 'maple-subject-masks';
const IDB_STORE = 'rasters-by-digest';
const IDB_VERSION = 1;

/** One cached raster: the server's PNG bytes plus the dims they decode to. */
export interface CachedSubjectMaskRaster {
  /** 16 lowercase hex chars — `BitmapRecipe.digest`. */
  digest: string;
  width: number;
  height: number;
  /** Grayscale PNG, byte-identical to what the server served. */
  png: ArrayBuffer;
}

/**
 * Contract used by `SubjectMaskService`. A missing key returns `null` —
 * errors are reserved for "the cache itself is broken", which the service
 * logs + bypasses (the raster is always re-fetchable).
 */
export interface SubjectMaskRasterCache {
  get(digest: string): Promise<CachedSubjectMaskRaster | null>;
  put(raster: CachedSubjectMaskRaster): Promise<void>;
}

@Injectable({ providedIn: 'root' })
class SubjectMaskIdbCache implements SubjectMaskRasterCache {
  async get(digest: string): Promise<CachedSubjectMaskRaster | null> {
    const db = await this.open();
    const tx = db.transaction(IDB_STORE, 'readonly');
    const result = await reqToPromise(tx.objectStore(IDB_STORE).get(digest)).finally(() =>
      db.close(),
    );
    const record = result as CachedSubjectMaskRaster | undefined;
    return record && record.png instanceof ArrayBuffer ? record : null;
  }

  async put(raster: CachedSubjectMaskRaster): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(raster);
    await txDone(tx).finally(() => db.close());
  }

  private open(): Promise<IDBDatabase> {
    return openDb(IDB_DB_NAME, IDB_VERSION, (db) => {
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: 'digest' });
      }
    });
  }
}

/** In-memory implementation — what specs provide instead of real IndexedDB. */
export class InMemorySubjectMaskCache implements SubjectMaskRasterCache {
  private readonly entries = new Map<string, CachedSubjectMaskRaster>();

  async get(digest: string): Promise<CachedSubjectMaskRaster | null> {
    return this.entries.get(digest) ?? null;
  }

  async put(raster: CachedSubjectMaskRaster): Promise<void> {
    this.entries.set(raster.digest, raster);
  }
}

/** DI token used by `SubjectMaskService` so specs can substitute the
 *  in-memory implementation without faking IndexedDB itself. */
export const SUBJECT_MASK_CACHE = new InjectionToken<SubjectMaskRasterCache>('SUBJECT_MASK_CACHE', {
  providedIn: 'root',
  factory: () => inject(SubjectMaskIdbCache),
});
