// user-preset-store.ts — hosted-backend storage for user presets (#1115).
//
// The hosted app (maple-syrup) has no API server, so user presets persist
// in IndexedDB — the same place its thumbnails and folder listings live.
// Self-hosted (maple) stores presets in the API's Mongo `presets`
// collection instead and never touches this module.
//
// Contract + in-memory variant + IDB variant, mirroring the
// `FolderListingCache` pattern: tests run against `InMemoryUserPresetStore`
// (jsdom has no IndexedDB); `IdbUserPresetStore` is the runtime
// implementation, with documents stored verbatim so unknown fields from
// newer schema versions round-trip untouched (the passthrough rule).

import { openDb, reqToPromise, txDone } from '../../util/idb';
import type { PresetFields } from './preset-model';

/** A stored user-preset document: the canonical preset shape plus the
 *  store-assigned id. Unknown extra keys ride along untouched. */
export interface StoredPreset {
  id: string;
  schemaVersion: number;
  name: string;
  fields: PresetFields;
  [key: string]: unknown;
}

export interface UserPresetStore {
  list(): Promise<StoredPreset[]>;
  put(preset: StoredPreset): Promise<void>;
  delete(id: string): Promise<void>;
}

// ── In-memory variant (tests, non-IDB environments) ───────────────────────

export class InMemoryUserPresetStore implements UserPresetStore {
  private readonly presets = new Map<string, StoredPreset>();

  async list(): Promise<StoredPreset[]> {
    return [...this.presets.values()].map((p) => structuredClone(p));
  }

  async put(preset: StoredPreset): Promise<void> {
    this.presets.set(preset.id, structuredClone(preset));
  }

  async delete(id: string): Promise<void> {
    this.presets.delete(id);
  }
}

// ── IndexedDB variant (hosted runtime) ────────────────────────────────────

const DB_NAME = 'maple-presets';
const DB_VERSION = 1;
const STORE = 'presets';

async function open(): Promise<IDBDatabase> {
  return openDb(DB_NAME, DB_VERSION, (db) => {
    if (!db.objectStoreNames.contains(STORE)) {
      db.createObjectStore(STORE, { keyPath: 'id' });
    }
  });
}

export class IdbUserPresetStore implements UserPresetStore {
  async list(): Promise<StoredPreset[]> {
    const db = await open();
    try {
      const tx = db.transaction(STORE, 'readonly');
      return await reqToPromise(tx.objectStore(STORE).getAll() as IDBRequest<StoredPreset[]>);
    } finally {
      db.close();
    }
  }

  async put(preset: StoredPreset): Promise<void> {
    const db = await open();
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(preset);
      await txDone(tx);
    } finally {
      db.close();
    }
  }

  async delete(id: string): Promise<void> {
    const db = await open();
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      await txDone(tx);
    } finally {
      db.close();
    }
  }
}

/** Runtime store for the hosted backend: IDB when the platform has it,
 *  in-memory otherwise (SSR, ancient browsers — presets then last for
 *  the session, which beats a hard failure). */
export function createHostedUserPresetStore(): UserPresetStore {
  return typeof indexedDB === 'undefined' ? new InMemoryUserPresetStore() : new IdbUserPresetStore();
}
