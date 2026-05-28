/**
 * Shared configuration for the backup ingest / rendered routes.
 *
 * `BACKUP_CHUNK_DIR` is the on-disk staging directory where in-flight
 * chunked uploads are appended to a `<sessionId>.part` file before being
 * `atomicMove`d to the final library path on the last chunk. Defaults to
 * `/tmp/maple-backup-chunks`, but self-hosted operators should override
 * via `MAPLE_BACKUP_TMP` to a path on the same volume as the library
 * folders — both to avoid `/tmp` quota/size limits (EDQUOT under
 * concurrent uploads) and to keep the final rename an O(1) inode move
 * instead of the cross-device copy fallback.
 */
import fs from 'node:fs/promises';

export const BACKUP_CHUNK_DIR =
  process.env.MAPLE_BACKUP_TMP ?? '/tmp/maple-backup-chunks';

/**
 * Wipe and recreate the chunk staging directory. Called once at API
 * startup so leftover `.part` files from a previous run (crash, kill,
 * deploy) don't accumulate and don't trip the size-mismatch check on a
 * resume — the ingest route is already self-healing when the `.part`
 * file is missing (returns `409 expected_offset: 0` and the client
 * restarts from offset 0), so wiping is safe.
 */
export async function clearBackupChunkDir(): Promise<void> {
  await fs.rm(BACKUP_CHUNK_DIR, { recursive: true, force: true });
  await fs.mkdir(BACKUP_CHUNK_DIR, { recursive: true });
}
