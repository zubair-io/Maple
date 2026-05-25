// FolderListingCache — stale-while-revalidate cache for `/api/fs/dir-fast`
// directory listings, keyed by absolute path.
//
// Two tiers:
//   - an in-memory Map for synchronous hits within a session (instant tree
//     expand / folder open on re-navigation), and
//   - an IndexedDB write-through layer so a full app reload paints the
//     sidebar tree + grid from the last-seen listing before the network
//     round-trip lands.
//
// The cache is advisory: callers always revalidate over the network and
// apply the fresh listing on top of the cached one (see
// `LibraryFetch._swrListDir`). Listings are pure filesystem data (sub-dir +
// RAW-image names), so a stale paint is at worst a folder that has since
// gained/lost an entry — corrected within one round-trip.
//
// Shape mirrors `xmp/sidecar-idb-cache.ts`: a hand-rolled IDB module with no
// extra dependency, and an in-memory implementation for tests.

import { Injectable, InjectionToken, inject } from '@angular/core';
import { FsDirListing } from './filesystem-browse.service';

const IDB_DB_NAME = 'maple-folder-listing-cache';
const IDB_STORE = 'listings-by-path';
const IDB_VERSION = 1;

/** Persisted record. `listing` is the raw `/api/fs/dir-fast` response. */
export interface FolderListingRecord {
  /** Absolute, symlink-resolved directory path (the cache key). */
  path: string;
  listing: FsDirListing;
  storedAt: number;
}

/**
 * Contract consumed by `LibraryFetch`. Implementations must not throw on a
 * missing key — resolve `null`. `peek` is the synchronous in-memory hit;
 * `get` falls back to the persistent layer. `put` is best-effort (a failed
 * persist must not reject the caller's flow).
 */
export interface FolderListingCacheApi {
  /** Synchronous in-memory hit, or null. Never touches IndexedDB. */
  peek(path: string): FsDirListing | null;
  /** In-memory hit, else the persisted listing (hydrating memory), else null. */
  get(path: string): Promise<FsDirListing | null>;
  /** Write through to both tiers. Best-effort on the persistent layer. */
  put(path: string, listing: FsDirListing): void;
  /** Drop everything (e.g. on sign-out). */
  clear(): Promise<void>;
}

@Injectable({ providedIn: 'root' })
export class FolderListingIdbCache implements FolderListingCacheApi {
  private readonly mem = new Map<string, FsDirListing>();

  peek(path: string): FsDirListing | null {
    return this.mem.get(path) ?? null;
  }

  async get(path: string): Promise<FsDirListing | null> {
    const hit = this.mem.get(path);
    if (hit) return hit;
    const rec = await this._idbGet(path).catch(() => null);
    if (rec) {
      this.mem.set(path, rec.listing);
      return rec.listing;
    }
    return null;
  }

  put(path: string, listing: FsDirListing): void {
    this.mem.set(path, listing);
    void this._idbPut(path, listing).catch(() => {
      // Best-effort: a full quota or a private-mode IDB block must not break
      // navigation. The in-memory tier still serves this session.
    });
  }

  async clear(): Promise<void> {
    this.mem.clear();
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

  private _idbGet(path: string): Promise<FolderListingRecord | null> {
    return this._open().then(
      (db) =>
        new Promise<FolderListingRecord | null>((resolve, reject) => {
          const tx = db.transaction(IDB_STORE, 'readonly');
          const req = tx.objectStore(IDB_STORE).get(path);
          req.onsuccess = () => {
            db.close();
            resolve((req.result as FolderListingRecord | undefined) ?? null);
          };
          req.onerror = () => {
            db.close();
            reject(req.error);
          };
        }),
    );
  }

  private async _idbPut(path: string, listing: FsDirListing): Promise<void> {
    const db = await this._open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const record: FolderListingRecord = { path, listing, storedAt: Date.now() };
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

  private _open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_DB_NAME, IDB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
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
 * In-memory implementation. Exposed so tests (and any non-browser host) can
 * substitute it without faking IndexedDB.
 */
export class InMemoryFolderListingCache implements FolderListingCacheApi {
  private readonly mem = new Map<string, FsDirListing>();

  peek(path: string): FsDirListing | null {
    return this.mem.get(path) ?? null;
  }

  async get(path: string): Promise<FsDirListing | null> {
    return this.mem.get(path) ?? null;
  }

  put(path: string, listing: FsDirListing): void {
    this.mem.set(path, listing);
  }

  async clear(): Promise<void> {
    this.mem.clear();
  }
}

/** DI token used by `LibraryFetch` so tests can substitute the in-memory
 * implementation. The factory goes through `inject(FolderListingIdbCache)`
 * so the class participates in DI (and tests can `useValue` against the
 * token without losing the production binding). */
export const FOLDER_LISTING_CACHE = new InjectionToken<FolderListingCacheApi>(
  'FOLDER_LISTING_CACHE',
  {
    providedIn: 'root',
    factory: () => inject(FolderListingIdbCache),
  },
);
