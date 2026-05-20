// SidecarIdbCache — thin IndexedDB write-through layer for SidecarStore.
//
// Stores the parsed XMP body keyed by AssetId. The store consults this cache
// on cold reads (instant first paint while the network catches up) and writes
// through on every successful network read / optimistic write.
//
// Kept deliberately small + injectable so tests can swap in an in-memory fake.
// The shape mirrors `folder-access/file-cache.ts` — a hand-rolled IDB module
// without an extra dependency.

import { Injectable } from '@angular/core';
import type { AssetId } from '../models/asset';

const IDB_DB_NAME = 'maple-sidecar-cache';
const IDB_STORE = 'sidecars';
const IDB_VERSION = 1;

/** Persisted record. `xml` is the canonical form — re-parse on read. */
export interface SidecarCacheRecord {
  id: AssetId;
  xml: string;
  storedAt: number;
}

/**
 * Contract used by `SidecarStore`. Implementations must not throw on missing
 * keys — return `null` instead. Errors are reserved for "the cache itself is
 * broken" (quota, schema mismatch) and stores log + bypass.
 */
export interface SidecarCache {
  get(id: AssetId): Promise<SidecarCacheRecord | null>;
  put(id: AssetId, xml: string): Promise<void>;
  delete(id: AssetId): Promise<void>;
  clear(): Promise<void>;
}

@Injectable({ providedIn: 'root' })
export class SidecarIdbCache implements SidecarCache {
  async get(id: AssetId): Promise<SidecarCacheRecord | null> {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(id);
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

  async put(id: AssetId, xml: string): Promise<void> {
    const db = await this._open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const record: SidecarCacheRecord = { id, xml, storedAt: Date.now() };
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

  async delete(id: AssetId): Promise<void> {
    const db = await this._open();
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
        req.result.createObjectStore(IDB_STORE, { keyPath: 'id' });
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
  private readonly entries = new Map<AssetId, SidecarCacheRecord>();

  async get(id: AssetId): Promise<SidecarCacheRecord | null> {
    return this.entries.get(id) ?? null;
  }

  async put(id: AssetId, xml: string): Promise<void> {
    this.entries.set(id, { id, xml, storedAt: Date.now() });
  }

  async delete(id: AssetId): Promise<void> {
    this.entries.delete(id);
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }
}

/** DI token used by `SidecarStore` so tests can substitute the in-memory
 * implementation without faking IndexedDB itself. */
import { InjectionToken } from '@angular/core';
export const SIDECAR_CACHE = new InjectionToken<SidecarCache>('SIDECAR_CACHE', {
  providedIn: 'root',
  factory: () => new SidecarIdbCache(),
});
