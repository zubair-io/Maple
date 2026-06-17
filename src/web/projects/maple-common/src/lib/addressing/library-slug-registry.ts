// LibrarySlugRegistry — maps slug ↔ FileSystemDirectoryHandle in IndexedDB.
//
// Used by FsAccessLibrarySource (Hosted mode). A "library" is identified by
// a stable slug minted from handle.name on first registration. The handle is
// persisted in IndexedDB (handles are structured-clonable per the FS-Access
// spec) so the library stays accessible across sessions.
//
// Slug rules mirror the M1 server's slug generation:
//   - ASCII-folded to lowercase; non-[a-z0-9] → dash.
//   - Consecutive dashes collapsed to one; leading/trailing dashes stripped.
//   - Collision: append -2, -3, … until unique.

import { Injectable } from '@angular/core';
import { openDb, reqToPromise, txDone } from '../util/idb';

const DB_NAME = 'maple-slug-registry';
const DB_VERSION = 1;
const STORE = 'slugs'; // key=slug → value=FileSystemDirectoryHandle

/** Convert a human label into a URL-safe slug [a-z0-9-]. */
export function slugify(label: string): string {
  return (
    label
      // Normalize unicode: decompose into base + combining marks, then strip marks.
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      // Lowercase.
      .toLowerCase()
      // Replace any character that isn't alphanumeric with a dash.
      .replace(/[^a-z0-9]+/g, '-')
      // Strip leading/trailing dashes.
      .replace(/^-+|-+$/g, '')
  );
}

/**
 * Return a unique slug given a set of already-taken slugs.
 * Appends -2, -3, … until the candidate is not in `taken`.
 */
export function dedupeSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * IndexedDB upgrade callback: create the slug→handle store, guarding against
 * re-creation. A future DB_VERSION bump would otherwise fire onupgradeneeded
 * with STORE already present and throw ConstraintError, breaking the app.
 */
function ensureSlugStore(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
}

@Injectable({ providedIn: 'root' })
export class LibrarySlugRegistry {
  private async openStore(mode: IDBTransactionMode) {
    const db = await openDb(DB_NAME, DB_VERSION, ensureSlugStore);
    return { db, tx: db.transaction(STORE, mode), store: null as unknown as IDBObjectStore };
  }

  /**
   * Register a FileSystemDirectoryHandle. If the handle refers to a directory
   * already registered (same OS identity, checked via isSameEntry), returns the
   * existing slug. Two different directories whose names happen to be identical
   * get distinct slugs (the second gets a "-2" suffix). Persists in IndexedDB.
   */
  async register(handle: FileSystemDirectoryHandle): Promise<string> {
    const existing = await this.list();
    const taken = new Set(existing.map((e) => e.slug));
    // Check identity: isSameEntry is the OS-level pointer comparison; comparing
    // names alone would collide when two different dirs share a basename.
    for (const entry of existing) {
      const candidate = await this.getHandle(entry.slug);
      if (candidate && (await candidate.isSameEntry(handle))) return entry.slug;
    }

    const slug = dedupeSlug(slugify(handle.name), taken);

    const db = await openDb(DB_NAME, DB_VERSION, ensureSlugStore);
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(handle, slug);
    await txDone(tx);
    db.close();
    return slug;
  }

  /** Retrieve a previously-registered handle by slug, or null. */
  async getHandle(slug: string): Promise<FileSystemDirectoryHandle | null> {
    const db = await openDb(DB_NAME, DB_VERSION, ensureSlugStore);
    const tx = db.transaction(STORE, 'readonly');
    const result = await reqToPromise(tx.objectStore(STORE).get(slug));
    db.close();
    return (result as FileSystemDirectoryHandle | undefined) ?? null;
  }

  /** List all registered slugs + handle names. */
  async list(): Promise<{ slug: string; name: string }[]> {
    const db = await openDb(DB_NAME, DB_VERSION, ensureSlugStore);
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const keys = await reqToPromise(store.getAllKeys());
    const values = await reqToPromise(store.getAll());
    db.close();

    return (keys as string[]).map((slug, i) => ({
      slug,
      name: (values[i] as FileSystemDirectoryHandle).name,
    }));
  }
}
