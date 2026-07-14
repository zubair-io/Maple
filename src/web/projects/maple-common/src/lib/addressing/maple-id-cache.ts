// MapleIdCache — IndexedDB-backed cache of computed `maple_id`s for
// Hosted-mode (FS-Access) local files (#1995).
//
// Computing a `maple_id` means reading (at minimum) a 64 KB head, and for
// files with no EXIF capture timestamp, streaming the ENTIRE file through a
// SHA-1 + BLAKE3 hash — expensive to redo on every folder revisit for a
// library of 100 MP RAWs. This cache persists the result keyed by the
// stable `slug:relPath` address (see `maple-address.ts`'s `formatAddress`),
// validated against the file's current `size` + `lastModified` on every
// lookup: a file replaced at the same path (same filename, different
// content) fails that check and the caller recomputes rather than silently
// serving a stale id for different bytes.
//
// Follows the same `openDb`/`reqToPromise`/`txDone` IndexedDB convention as
// `library-slug-registry.ts` (slug↔handle), `fs-access-backend.ts`
// (persisted directory handles), and `file-cache.ts` (persisted single-file
// imports) — a dedicated small IndexedDB database per concern, not a shared
// catch-all store. This is DELIBERATELY separate from the on-disk
// `.maple/index.json` cache protocol (`maple-cache.types.ts` /
// `maple-cache.service.ts`): that schema is spec-governed and explicitly
// closed to new fields ("Do NOT add fields not defined here; extra fields
// break cross-product interop" — shared byte-for-byte across Web/Apple/
// Self-Hosted). `maple_id` is a purely local computation cache, not part of
// that portable contract, so it belongs in this browser-local IndexedDB
// store instead.

import { Injectable } from '@angular/core';
import { openDb, reqToPromise, txDone } from '../util/idb';

const DB_NAME = 'maple-id-cache';
const DB_VERSION = 1;
const STORE = 'ids';

export interface CachedMapleId {
  /** `slug:relPath` — see `formatAddress` in `maple-address.ts`. */
  key: string;
  size: number;
  /** `File.lastModified` (unix ms). */
  mtime: number;
  mapleId: string;
  computedAt: number;
}

function ensureStore(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
}

function openIdDb(): Promise<IDBDatabase> {
  return openDb(DB_NAME, DB_VERSION, ensureStore);
}

/**
 * Look up a cached `maple_id` for `key`. Returns `null` on a cache miss OR
 * when the cached `size`/`mtime` no longer match the file's current values
 * (the file was replaced at this path — the caller must recompute).
 */
export async function getCachedMapleId(
  key: string,
  size: number,
  mtime: number,
): Promise<string | null> {
  const db = await openIdDb();
  const tx = db.transaction(STORE, 'readonly');
  const record = (await reqToPromise(tx.objectStore(STORE).get(key)).finally(() => db.close())) as
    | CachedMapleId
    | undefined;
  if (!record) return null;
  if (record.size !== size || record.mtime !== mtime) return null;
  return record.mapleId;
}

/** Persist a freshly computed `maple_id` for `key`, keyed to the `size`/
 * `mtime` it was computed against. */
export async function putCachedMapleId(
  key: string,
  size: number,
  mtime: number,
  mapleId: string,
): Promise<void> {
  const db = await openIdDb();
  const tx = db.transaction(STORE, 'readwrite');
  const record: CachedMapleId = { key, size, mtime, mapleId, computedAt: Date.now() };
  tx.objectStore(STORE).put(record);
  await txDone(tx).finally(() => db.close());
}

/**
 * Injectable wrapper around the free `getCachedMapleId`/`putCachedMapleId`
 * functions above. `HostedMapleIdService` depends on THIS (not the free
 * functions directly) so specs can substitute a fake via
 * `TestBed.overrideProvider` — Angular's unit-test runner rejects `vi.mock()`
 * on relative-path imports ("Please use Angular TestBed for mocking
 * dependencies"), so a plain module-level function isn't mockable in a spec
 * without this indirection. Contains no logic of its own beyond delegation;
 * `maple-id-cache.spec.ts` covers the actual caching/staleness behavior
 * through the free functions directly.
 */
@Injectable({ providedIn: 'root' })
export class MapleIdCacheService {
  get(key: string, size: number, mtime: number): Promise<string | null> {
    return getCachedMapleId(key, size, mtime);
  }

  put(key: string, size: number, mtime: number, mapleId: string): Promise<void> {
    return putCachedMapleId(key, size, mtime, mapleId);
  }
}
