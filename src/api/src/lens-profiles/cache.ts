/**
 * Durable storage for imported lens-correction profiles, and the in-process
 * cache in front of it.
 *
 * A profile is user content: an operator uploads a .lcp, the core reports what
 * is in it, and an XMP sidecar then references it forever by the BLAKE3 hash of
 * its bytes. So the bytes have to survive, and they have to hash to the digest
 * that names them — both on the way in and on the way back out, because a
 * profile that silently decodes to something else would change every rendered
 * pixel of every photo that selected it.
 *
 * Previously a GridFS bucket, which existed because a .lcp can exceed MongoDB's
 * 16 MiB document ceiling. The SQLite table stores the whole file in one BLOB
 * (`db/repos/lens-profiles.repo.ts`), so the chunking is gone.
 *
 * ## The in-process cache is not an optimisation, it is a budget
 *
 * `restoreLensProfile` runs inside the isolated FFI decode child on EVERY
 * `renderDevelop` and `histogram` request — that is, on every slider tick of an
 * image whose sidecar selects a profile. It clears the core's own profile cache
 * and re-registers the bytes each time, so the bytes really are needed per
 * render.
 *
 * Fetching up to 32 MiB from the database per tick would blow the 16 ms slider
 * budget on its own, before any decode. {@link loadLensProfile} therefore holds
 * the last profile it read and answers a repeat from memory. One entry, not an
 * LRU: the access pattern is "the image being edited, over and over", the entry
 * is keyed by digest so switching images simply misses once, and one entry is
 * bounded at 32 MiB by the same constant that bounds an upload. A byte-budgeted
 * map would cost eviction machinery for a second profile nothing in the hot path
 * asks for. The bytes are content-addressed and therefore immutable, so a cache
 * hit can never be stale.
 */

import { blake3 } from '@noble/hashes/blake3.js';
import { sqliteDatabasePath } from '../db/sqlite/database-path.ts';
import { isSqliteOpen, openSqlitePool } from '../db/sqlite/index.ts';
import { readLensProfileBytes, saveLensProfileBytes } from '../db/repos/lens-profiles.repo.ts';
import { lensProfileDigest, MAX_LCP_BYTES, type LensProfileInventory } from './types.ts';

/**
 * The FFI decode child opens no database of its own.
 *
 * It is spawned by `ffi-pool.ts` to own the raw-ffi dylib, and this module is
 * the only database reader anywhere in its module graph — every other arm of
 * `raw_ffi-dispatch.ts` works on paths and bytes. The pool is opened once at
 * startup by whoever owns the process, and nobody owns this one.
 *
 * So the pool is opened here, on the first profile a child actually needs, and
 * never for a child that only ever decodes thumbnails — which is almost all of
 * them. One reader is enough: a child handles one request at a time.
 *
 * The child never migrates: the path resolver is a module with no imports of
 * its own, so learning where the database lives costs this process nothing and
 * brings neither the schema nor the migration runner along with it.
 *
 * **This child never writes, and that matters to a decision made elsewhere.**
 * `SqlitePool.open` always spawns a writer thread, so a decode child that has
 * handled one develop is holding a writer connection alongside the API process
 * and the worker child. The cross-process arbitration decided for #3752 was
 * reasoned about two writers, and this makes three — but only nominally: this
 * pool is used by {@link loadLensProfile} alone, which reads, and a WAL
 * connection that never writes takes no write lock. So it adds no contention to
 * arbitrate, and the busy-retry ladder's reasoning is unaffected. If anything in
 * this child ever does write, that stops being true and the decision needs
 * revisiting rather than extending.
 */
let opening: Promise<void> | null = null;

async function ensureDatabase(): Promise<void> {
  if (isSqliteOpen()) return;
  // Serialised: `openSqlitePool` throws rather than waits when a second caller
  // arrives while the first is still spawning its threads.
  opening ??= openSqlitePool({ path: sqliteDatabasePath(), readers: 1 })
    .then(() => undefined)
    .catch((err: unknown) => {
      // A failed open must not poison every later attempt with a settled
      // rejection; the next caller retries.
      opening = null;
      throw err;
    });
  await opening;
}

/** The last profile read, kept for the next render of the same image. */
let cached: { digest: string; bytes: Uint8Array } | null = null;

/** Drops the in-process cache. For tests, which switch databases under it. */
export function __resetLensProfileCacheForTests(): void {
  cached = null;
}

export async function saveLensProfile(
  bytes: Uint8Array,
  inventory: LensProfileInventory,
): Promise<void> {
  if (!bytes.length || bytes.length > MAX_LCP_BYTES)
    throw new Error('LCP must be between 1 byte and 32 MiB');
  const digest = lensProfileDigest(inventory.reference);
  verifyDigest(bytes, digest);
  await ensureDatabase();
  await saveLensProfileBytes(digest, bytes, inventory);
}

export async function loadLensProfile(digest: string): Promise<Uint8Array | null> {
  // Rejects a malformed digest before it reaches a query, exactly as the
  // GridFS version did — the route passes a path segment straight through.
  lensProfileDigest(`lcp1:${digest}`);
  if (cached?.digest === digest) return cached.bytes;

  await ensureDatabase();
  const bytes = await readLensProfileBytes(digest);
  if (!bytes) return null;
  if (bytes.length <= 0 || bytes.length > MAX_LCP_BYTES)
    throw new Error('Stored LCP has an invalid size');
  // The stored bytes are one column rather than a chain of chunks, so a short
  // read is no longer expressible — but a blob that stops hashing to its own
  // key still is, and that is the failure that would change rendered pixels.
  verifyDigest(bytes, digest);
  cached = { digest, bytes };
  return bytes;
}

function verifyDigest(bytes: Uint8Array, digest: string): void {
  if (Buffer.from(blake3(bytes)).toString('hex') !== digest) {
    throw new Error('LCP contents do not match the authored content digest');
  }
}
