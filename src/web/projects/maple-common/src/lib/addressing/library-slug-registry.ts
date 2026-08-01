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
import type { MapleFolderHandle } from '../folder-access/folder-access.types';
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
  /**
   * Session front for handles that cannot be cloned into IndexedDB (private
   * browsing, storage denial, or an otherwise restricted browser profile).
   * A successfully opened folder must remain readable for the current
   * session even when cross-session persistence is unavailable.
   */
  private readonly sessionHandles = new Map<string, FileSystemDirectoryHandle>();
  private readonly fallbackSlugs = new WeakMap<MapleFolderHandle, string>();
  private readonly persistedKeySlugs = new Map<string, string>();
  private readonly fallbackNames = new Map<string, string>();

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
      if (!candidate) continue;
      if (candidate === handle) return entry.slug;
      if (typeof candidate.isSameEntry !== 'function') continue;
      try {
        if (await candidate.isSameEntry(handle)) return entry.slug;
      } catch {
        // A revoked or otherwise inaccessible prior handle is not proof that
        // the newly selected folder is the same entry. Keep checking and mint
        // a deduplicated slug when no accessible registration matches.
      }
    }

    const slug = dedupeSlug(slugify(handle.name) || 'folder', taken);
    this.sessionHandles.set(slug, handle);

    try {
      const db = await openDb(DB_NAME, DB_VERSION, ensureSlugStore);
      try {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(handle, slug);
        await txDone(tx);
      } finally {
        db.close();
      }
    } catch (err) {
      // The in-memory registration above is sufficient for this open editor
      // session. Persisting the handle is an optional reload convenience, not
      // permission to make a readable folder unusable.
      console.warn('LibrarySlugRegistry: handle persistence unavailable', err);
    }
    return slug;
  }

  /**
   * Mint a session-stable namespace for a folder without a native handle.
   * Object identity covers a repeated open of the same fallback handle, while
   * a persisted key lets a reconstructed wrapper recover that identity.
   */
  async registerFallback(folder: MapleFolderHandle): Promise<string> {
    const byReference = this.fallbackSlugs.get(folder);
    if (byReference) return byReference;

    const byPersistedKey = folder.persistedKey
      ? this.persistedKeySlugs.get(folder.persistedKey)
      : undefined;
    if (byPersistedKey) {
      this.fallbackSlugs.set(folder, byPersistedKey);
      return byPersistedKey;
    }

    const taken = new Set((await this.list()).map((entry) => entry.slug));
    const slug = dedupeSlug(slugify(folder.name) || 'folder', taken);
    this.fallbackSlugs.set(folder, slug);
    if (folder.persistedKey) this.persistedKeySlugs.set(folder.persistedKey, slug);
    this.fallbackNames.set(slug, folder.name);
    return slug;
  }

  /** Retrieve a previously-registered handle by slug, or null. */
  async getHandle(slug: string): Promise<FileSystemDirectoryHandle | null> {
    const session = this.sessionHandles.get(slug);
    if (session) return session;
    try {
      const db = await openDb(DB_NAME, DB_VERSION, ensureSlugStore);
      try {
        const tx = db.transaction(STORE, 'readonly');
        const result = await reqToPromise(tx.objectStore(STORE).get(slug));
        return (result as FileSystemDirectoryHandle | undefined) ?? null;
      } finally {
        db.close();
      }
    } catch {
      return null;
    }
  }

  /** List all registered slugs + handle names. */
  async list(): Promise<{ slug: string; name: string }[]> {
    const entries = new Map(this.fallbackNames);
    for (const [slug, handle] of this.sessionHandles) entries.set(slug, handle.name);
    try {
      const db = await openDb(DB_NAME, DB_VERSION, ensureSlugStore);
      try {
        const tx = db.transaction(STORE, 'readonly');
        const store = tx.objectStore(STORE);
        const keys = await reqToPromise(store.getAllKeys());
        const values = await reqToPromise(store.getAll());
        (keys as string[]).forEach((slug, index) => {
          if (!entries.has(slug))
            entries.set(slug, (values[index] as FileSystemDirectoryHandle).name);
        });
      } finally {
        db.close();
      }
    } catch {
      // Session registrations remain usable when IndexedDB is unavailable.
    }
    return [...entries].map(([slug, name]) => ({ slug, name }));
  }
}
