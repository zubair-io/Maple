// SidecarIdbCache — thin IndexedDB write-through layer for SidecarStore.
//
// Stores the parsed XMP body keyed by the source file's absolute path. The
// store consults this cache on cold reads (instant first paint while the
// network catches up) and writes through on every successful network read /
// optimistic write.
//
// Path-keyed (NOT AssetId-keyed) as of slice 4 of #193: the data model has
// path↔sidecar 1:1, and the API endpoint is `/api/xmp?path=…` — keying the
// client cache the same way means a cache hit on a path-keyed URL is a true
// content match. Two paths to the same RAW (e.g. a user-`cp`-ed duplicate)
// each keep their own sidecar; the cache mirrors that.
//
// Kept deliberately small + injectable so tests can swap in an in-memory fake.
// The shape mirrors `folder-access/file-cache.ts` — a hand-rolled IDB module
// without an extra dependency.

import { Injectable, InjectionToken, inject } from '@angular/core';

const IDB_DB_NAME = 'maple-sidecar-cache';
const IDB_STORE = 'sidecars-by-path';
// Bumped from 1 → 2 for the AssetId → path key rotation. The old `sidecars`
// object store is dropped in `onupgradeneeded` so a previous tab's
// AssetId-keyed rows don't linger as dead bytes. Re-fetch on first cold read
// after upgrade is acceptable — sidecars are tiny and the server has them.
const IDB_VERSION = 2;
const IDB_LEGACY_STORE = 'sidecars';

/** Persisted record. `xml` is the canonical form — re-parse on read. */
export interface SidecarCacheRecord {
  /** Absolute filesystem path of the source RAW that this sidecar describes. */
  path: string;
  xml: string;
  storedAt: number;
}

/**
 * Contract used by `SidecarStore`. Implementations must not throw on missing
 * keys — return `null` instead. Errors are reserved for "the cache itself is
 * broken" (quota, schema mismatch) and stores log + bypass.
 */
export interface SidecarCache {
  get(path: string): Promise<SidecarCacheRecord | null>;
  put(path: string, xml: string): Promise<void>;
  delete(path: string): Promise<void>;
  clear(): Promise<void>;
}

@Injectable({ providedIn: 'root' })
export class SidecarIdbCache implements SidecarCache {
  async get(path: string): Promise<SidecarCacheRecord | null> {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(path);
      req.onsuccess = () => {
        db.close();
        resolve((req.result as SidecarCacheRecord | undefined) ?? null);
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    });
  }

  async put(path: string, xml: string): Promise<void> {
    const db = await this._open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const record: SidecarCacheRecord = { path, xml, storedAt: Date.now() };
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

  async delete(path: string): Promise<void> {
    const db = await this._open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(path);
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

  async clear(): Promise<void> {
    const db = await this._open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).clear();
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

  private _open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_DB_NAME, IDB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        // Drop the legacy AssetId-keyed store from v1 (if present) — those
        // rows can't be migrated reliably (no path was recorded) and a
        // re-fetch on next cold read is cheap.
        if (db.objectStoreNames.contains(IDB_LEGACY_STORE)) {
          db.deleteObjectStore(IDB_LEGACY_STORE);
        }
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE, { keyPath: 'path' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
}

/**
 * In-memory implementation. Exposed so tests + the Hosted backend (which has
 * its own caching via `.maple/cache/`) can provide an alternative without
 * touching real IndexedDB.
 */
export class InMemorySidecarCache implements SidecarCache {
  private readonly entries = new Map<string, SidecarCacheRecord>();

  async get(path: string): Promise<SidecarCacheRecord | null> {
    return this.entries.get(path) ?? null;
  }

  async put(path: string, xml: string): Promise<void> {
    this.entries.set(path, { path, xml, storedAt: Date.now() });
  }

  async delete(path: string): Promise<void> {
    this.entries.delete(path);
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }
}

/** DI token used by `SidecarStore` so tests can substitute the in-memory
 * implementation without faking IndexedDB itself. The factory goes through
 * `inject(SidecarIdbCache)` so the class participates in DI (and tests can
 * `useValue` against the token without losing the production binding). */
export const SIDECAR_CACHE = new InjectionToken<SidecarCache>('SIDECAR_CACHE', {
  providedIn: 'root',
  factory: () => inject(SidecarIdbCache),
});
