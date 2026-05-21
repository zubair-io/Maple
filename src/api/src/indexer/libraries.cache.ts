/**
 * Process-wide cache of `library_id hex → absolute path`.
 *
 * Every code path that resolves a `fileinfo[]` entry to an on-disk location
 * needs this map (cache-path resolution, change feed projection, route
 * handlers). Folders rarely change; we cache the read and invalidate
 * explicitly on writes to the folders collection.
 *
 * The cache lives at module scope (process-local) and is rebuilt lazily on
 * the first read after invalidation. There is no TTL — clients that need
 * fresh data after mutating folders must call `invalidateLibraryRoots()`.
 */
import { foldersCollection } from '../db/client.ts';

let cached: ReadonlyMap<string, string> | null = null;

export async function loadLibraryRoots(): Promise<ReadonlyMap<string, string>> {
  if (cached) return cached;
  const coll = await foldersCollection();
  const docs = await coll.find({}, { projection: { path: 1 } }).toArray();
  const map = new Map<string, string>();
  for (const d of docs) {
    map.set(d._id.toHexString(), d.path);
  }
  cached = map;
  return map;
}

export function invalidateLibraryRoots(): void {
  cached = null;
}
