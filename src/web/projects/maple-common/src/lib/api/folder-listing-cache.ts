// FolderListingCache — stale-while-revalidate cache for LibrarySource.listFolder()
// directory listings, keyed by formatted MapleAddress string (e.g. `library:2026/jan`).
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
// `LibraryFetch._swrListFolder`). Listings are pure filesystem data (sub-dir +
// RAW-image names), so a stale paint is at worst a folder that has since
// gained/lost an entry — corrected within one round-trip.
//
// Shape mirrors `xmp/sidecar-idb-cache.ts`: a hand-rolled IDB module with no
// extra dependency, and an in-memory implementation for tests.
//
// Migration note: the cache was previously keyed by absolute path and stored
// FsDirListing. Task 9 of M2 switches the key to a `slug:relPath` address
// string and the value to FolderListing (the LibrarySource contract type).

import { Injectable, InjectionToken, inject } from '@angular/core';
import type { FolderListing } from '../addressing/library-source';
import { openDb, reqToPromise, txDone } from '../util/idb';

const IDB_DB_NAME = 'maple-folder-listing-cache';
const IDB_STORE = 'listings-by-address';
// Bump the version so any stale IDB from before the migration (keyed by
// absPath, storing FsDirListing) is discarded rather than misread.
const IDB_VERSION = 2;

/** Persisted record. `listing` is the raw `LibrarySource.listFolder` response. */
export interface FolderListingRecord {
  /** `slug:relPath` address string (the cache key). */
  address: string;
  listing: FolderListing;
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
  peek(address: string): FolderListing | null;
  /** In-memory hit, else the persisted listing (hydrating memory), else null. */
  get(address: string): Promise<FolderListing | null>;
  /** Write through to both tiers. Best-effort on the persistent layer. */
  put(address: string, listing: FolderListing): void;
  /** Drop everything (e.g. on sign-out). */
  clear(): Promise<void>;
}

@Injectable({ providedIn: 'root' })
export class FolderListingIdbCache implements FolderListingCacheApi {
  private readonly mem = new Map<string, FolderListing>();

  peek(address: string): FolderListing | null {
    return this.mem.get(address) ?? null;
  }

  async get(address: string): Promise<FolderListing | null> {
    const hit = this.mem.get(address);
    if (hit) return hit;
    const rec = await this._idbGet(address).catch(() => null);
    if (rec) {
      this.mem.set(address, rec.listing);
      return rec.listing;
    }
    return null;
  }

  put(address: string, listing: FolderListing): void {
    this.mem.set(address, listing);
    void this._idbPut(address, listing).catch(() => {
      // Best-effort: a full quota or a private-mode IDB block must not break
      // navigation. The in-memory tier still serves this session.
    });
  }

  async clear(): Promise<void> {
    this.mem.clear();
    const db = await this._open();
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).clear();
    await txDone(tx).finally(() => db.close());
  }

  private async _idbGet(address: string): Promise<FolderListingRecord | null> {
    const db = await this._open();
    const tx = db.transaction(IDB_STORE, 'readonly');
    const result = await reqToPromise(tx.objectStore(IDB_STORE).get(address)).finally(() =>
      db.close(),
    );
    return (result as FolderListingRecord | undefined) ?? null;
  }

  private async _idbPut(address: string, listing: FolderListing): Promise<void> {
    const db = await this._open();
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const record: FolderListingRecord = { address, listing, storedAt: Date.now() };
    tx.objectStore(IDB_STORE).put(record);
    await txDone(tx).finally(() => db.close());
  }

  private _open(): Promise<IDBDatabase> {
    return openDb(IDB_DB_NAME, IDB_VERSION, (db) => {
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: 'address' });
      }
    });
  }
}

/**
 * In-memory implementation. Exposed so tests (and any non-browser host) can
 * substitute it without faking IndexedDB.
 */
export class InMemoryFolderListingCache implements FolderListingCacheApi {
  private readonly mem = new Map<string, FolderListing>();

  peek(address: string): FolderListing | null {
    return this.mem.get(address) ?? null;
  }

  async get(address: string): Promise<FolderListing | null> {
    return this.mem.get(address) ?? null;
  }

  put(address: string, listing: FolderListing): void {
    this.mem.set(address, listing);
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
