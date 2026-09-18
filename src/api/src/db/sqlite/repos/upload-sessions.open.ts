/**
 * `openOrResume` — the one upload-session verb with real branching, and the
 * reason it lives beside {@link file://./upload-sessions.repo.ts} instead of
 * inside it. Everything else in that module is a single statement against a
 * known id; this is a decision tree over whatever the previous attempt left
 * behind, and it reads better with each branch named than as one long function.
 *
 * ## What the tree is deciding
 *
 * A device re-sends the same enqueue request after every interruption — a
 * dropped connection, a process restart, a downstream step failing and
 * re-queueing the task. The request carries no session id, only the resume key
 * `(library_id, device_id, phasset_local_id)`, so this function has to work out
 * from the stored row which of those happened and hand the route one of three
 * answers: resume where you were, restart from offset 0 (`reset`), or stop —
 * the bytes are already here (`alreadyComplete`). Each of the helpers below
 * answers exactly one of those questions:
 *
 *   - {@link abandonStalePeers}     is a sibling device uploading this photo?
 *   - {@link resumeOpenSession}     can the in-flight session carry on as-is?
 *   - {@link reopenClosedSession}   a finished or abandoned row, reused in place
 *   - {@link insertFreshSession}    nothing stored — first contact
 *
 * ## Why a closed row is reopened rather than replaced
 *
 * The resume key is UNIQUE across *every* state, not just `open`. A completed
 * or abandoned row therefore blocks an insert on the same key, so the reopen
 * paths update in place. Deleting the old row first would be the other option
 * and is worse: the row is the only record that those bytes were ever received.
 *
 * ## `$unset` is `SET … = NULL`
 *
 * The reopen paths clear `maple_id`, `resolved_rel_path` and sometimes
 * `phasset_cloud_id`. On a document those fields go away; on a row they go to
 * NULL, and `toUploadSession` maps NULL back to an *absent key* rather than to
 * `undefined` — `UploadSessionDoc` declares all three optional and the route
 * code branches on `=== undefined`, so an absent Mongo field and a NULL column
 * have to read back identically.
 */

import type { ObjectId } from 'mongodb';
import type { UploadSessionDoc } from '../../schema.ts';
import { newObjectIdHex } from '../object-id.ts';
import type { SqliteDb } from './db-handle.ts';
import {
  ABANDON_PEERS_SQL,
  BY_ID_SQL,
  BY_RESUME_KEY_SQL,
  NEWEST_PEER_SQL,
  stamps,
  toUploadSession,
  type UploadSessionRow,
} from './upload-sessions.rows.ts';
import { toDate, toHex } from './values.ts';

export interface OpenOrResumeArgs {
  libraryId: ObjectId;
  deviceId: string;
  phassetLocalId: string;
  totalBytes: number;
  chunkSize: number;
  targetRelPath: string;
  phassetCloudId?: string;
}

export interface OpenOrResumeResult {
  session: UploadSessionDoc;
  /**
   * The stored progress was thrown away and the client must start again at
   * offset 0. The route reacts by unlinking the stale tmp file, so that the
   * next chunk append cannot pick up bytes belonging to the previous attempt.
   */
  reset: boolean;
  /**
   * These bytes are already on the server, under the `maple_id` and path the
   * returned session carries. The route answers HTTP 200 straight away instead
   * of letting the client spend its retry budget re-sending an upload that
   * finished server-side.
   */
  alreadyComplete: boolean;
}

/** One session row by id, or `null`. */
export async function readSessionRow(db: SqliteDb, id: string): Promise<UploadSessionRow | null> {
  const rows = await db.read<UploadSessionRow>(BY_ID_SQL, [id]);
  return rows[0] ?? null;
}

/**
 * Re-read a row this call just wrote, or fail loudly.
 *
 * The Mongo original asserts the same thing with a `!`. A miss means the row
 * was deleted between the update and the read, which nothing in this codebase
 * does — reporting it beats handing the route a session it never wrote.
 */
async function reread(db: SqliteDb, id: string): Promise<UploadSessionRow> {
  const row = await readSessionRow(db, id);
  if (row === null) throw new Error(`upload_sessions: session ${id} vanished mid-update`);
  return row;
}

/**
 * The cloud id a write should store, given what the caller offered.
 *
 * `undefined` means the caller has none, and both reset paths treat that as
 * "clear whatever is there" — the Mongo version's `$unset` on
 * `phasset_cloud_id`, which it only bothered to emit when the row actually had
 * one. Writing NULL over a NULL is the same outcome with one fewer branch.
 */
function cloudIdOrNull(args: OpenOrResumeArgs): string | null {
  return args.phassetCloudId === undefined ? null : args.phassetCloudId;
}

/** Same byte count, same destination: the request describes the stored upload. */
function isSameContent(row: UploadSessionRow, args: OpenOrResumeArgs): boolean {
  return row.total_bytes === args.totalBytes && row.target_rel_path === args.targetRelPath;
}

/**
 * How long a peer's session counts as "actively uploading" after its last
 * chunk. Generous on purpose: a phone that sleeps mid-upload, or a network blip
 * spanning several backoff cycles, must not have its upload stolen by a sibling
 * device. Being conservative costs a wait of up to this long when the peer is
 * genuinely dead, which is the cheaper mistake — both devices usually hold the
 * same iCloud copy, so deferring beats racing.
 */
export const CROSS_DEVICE_BUSY_WINDOW_MS = 30 * 60 * 1000;

/**
 * Raised when a different device is mid-upload on the same iCloud photo. The
 * backup routes turn it into HTTP 423 plus the `Retry-After` carried here.
 */
export class BusyElsewhereError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('another device is actively uploading this asset');
    this.name = 'BusyElsewhereError';
  }
}

/**
 * Stand aside for, or take over from, a sibling device uploading the same
 * iCloud photo. Only meaningful when both sides know a cloud id.
 *
 * This read/throw/insert sequence is NOT atomic, exactly as it was not on
 * Mongo. Two devices that fire their first chunk inside the same ~millisecond
 * window can both observe no peer and both proceed. That is deliberate — the
 * final-chunk path dedups by `maple_id`, so the worst case is one device
 * burning redundant bandwidth and its bytes being discarded at the finish line.
 * A UNIQUE constraint over `(library_id, phasset_cloud_id)` would prevent the
 * wasted upload but serialise legitimate same-cloud-id retries through
 * constraint violations, a worse trade for a workload where the collision is
 * rare.
 *
 * The peer read takes the most recently updated peer first. The cloud-id index
 * is intentionally non-unique, so after a simultaneous-first-chunk race several
 * "open" peers can exist for one cloud id. An arbitrary pick could land on a
 * stale duplicate while a sibling was still progressing, abandon the stale one
 * and let the caller proceed alongside the active peer — defeating the
 * coordination entirely. Preferring the newest peer: if THAT one is active,
 * throw; if THAT one is stale, every older peer is stale too and one sweep
 * abandons them all.
 */
async function abandonStalePeers(db: SqliteDb, args: OpenOrResumeArgs): Promise<void> {
  if (!args.phassetCloudId) return;
  const peerKey = [toHex(args.libraryId), args.phassetCloudId, args.deviceId, args.phassetLocalId];
  const peers = await db.read<UploadSessionRow>(NEWEST_PEER_SQL, peerKey);
  const peer = peers[0];
  if (peer === undefined) return;

  const ageMs = Date.now() - toDate(peer.updated_at).getTime();
  if (ageMs <= CROSS_DEVICE_BUSY_WINDOW_MS) {
    throw new BusyElsewhereError(Math.ceil((CROSS_DEVICE_BUSY_WINDOW_MS - ageMs) / 1000));
  }
  const [updatedAt, expiresAt] = stamps();
  await db.write(ABANDON_PEERS_SQL, [updatedAt, expiresAt, ...peerKey]);
}

/**
 * The row this device's resume key points at, in whatever state it is in.
 *
 * Deliberately unfiltered by state. The unique key spans every state, so a new
 * insert cannot be used when an `open`-only lookup misses — an abandoned row
 * from a prior cross-device takeover would collide, and the route would turn
 * that into the `resumeMismatchNoOffset` failure.
 */
async function readResumeRow(
  db: SqliteDb,
  args: OpenOrResumeArgs,
): Promise<UploadSessionRow | undefined> {
  const rows = await db.read<UploadSessionRow>(BY_RESUME_KEY_SQL, [
    toHex(args.libraryId),
    args.deviceId,
    args.phassetLocalId,
  ]);
  return rows[0];
}

/**
 * The device is offering different metadata for a session already in flight,
 * which means what it holds changed under it (the user edited the asset). The
 * device is the source of truth for that, so take the new metadata and rewind
 * to offset 0 in place.
 *
 * `created_at` is deliberately NOT bumped: this is the same session with
 * corrected metadata, where {@link reopenClosedSession} is a genuinely new
 * upload attempt.
 */
async function healMetadataMismatch(
  db: SqliteDb,
  args: OpenOrResumeArgs,
  existing: UploadSessionRow,
): Promise<OpenOrResumeResult> {
  const [updatedAt, expiresAt] = stamps();
  await db.write(
    `UPDATE upload_sessions
        SET total_bytes = ?, target_rel_path = ?, chunk_size = ?, received_bytes = 0,
            phasset_cloud_id = ?, updated_at = ?, expires_at = ?
      WHERE id = ?`,
    [
      args.totalBytes,
      args.targetRelPath,
      args.chunkSize,
      cloudIdOrNull(args),
      updatedAt,
      expiresAt,
      existing.id,
    ],
  );
  return {
    session: toUploadSession(await reread(db, existing.id)),
    reset: true,
    alreadyComplete: false,
  };
}

/**
 * An `open` session holding every byte it expects is not resumable: the next
 * legal Content-Range cannot start at `total_bytes`. It means a final chunk
 * appended successfully but the process died before `complete()` committed.
 * Returned unchanged, the client receives `409 expected_offset == total`
 * forever. Rewind in place; the route sees `reset: true`, removes the stale
 * `.part` and accepts the offset-0 request as a clean restart.
 *
 * `null` means the rewind did not happen because the row is no longer `open` —
 * a concurrent `complete()` landed between the read and this write. The
 * `state = 'open'` guard in the UPDATE is what keeps that honest, and the
 * caller re-enters against the fresh row rather than reporting a rewind that
 * never happened.
 */
async function rewindFullyReceived(
  db: SqliteDb,
  existing: UploadSessionRow,
): Promise<OpenOrResumeResult | null> {
  const [updatedAt, expiresAt] = stamps();
  const rewound = await db.write(
    `UPDATE upload_sessions SET received_bytes = 0, updated_at = ?, expires_at = ?
      WHERE id = ? AND state = 'open'`,
    [updatedAt, expiresAt, existing.id],
  );
  if (rewound.changes === 0) return null;
  return {
    session: toUploadSession(await reread(db, existing.id)),
    reset: true,
    alreadyComplete: false,
  };
}

/**
 * The caller is now offering a cloud id the row did not have — iCloud was
 * enabled mid-upload. Metadata only: progress stays, nothing is invalidated.
 */
async function attachCloudId(
  db: SqliteDb,
  cloudId: string,
  existing: UploadSessionRow,
): Promise<OpenOrResumeResult> {
  const [updatedAt, expiresAt] = stamps();
  await db.write(
    `UPDATE upload_sessions SET phasset_cloud_id = ?, updated_at = ?, expires_at = ?
      WHERE id = ?`,
    [cloudId, updatedAt, expiresAt, existing.id],
  );
  return {
    session: toUploadSession({ ...existing, phasset_cloud_id: cloudId }),
    reset: false,
    alreadyComplete: false,
  };
}

/**
 * Carry on an in-flight upload, or repair it first. `null` asks the caller to
 * re-enter because the row stopped being `open` underneath the rewind — see
 * {@link rewindFullyReceived}.
 */
async function resumeOpenSession(
  db: SqliteDb,
  args: OpenOrResumeArgs,
  existing: UploadSessionRow,
): Promise<OpenOrResumeResult | null> {
  if (!isSameContent(existing, args)) return healMetadataMismatch(db, args, existing);
  if (existing.received_bytes >= existing.total_bytes) return rewindFullyReceived(db, existing);
  if (args.phassetCloudId !== undefined && existing.phasset_cloud_id === null) {
    return attachCloudId(db, args.phassetCloudId, existing);
  }
  return { session: toUploadSession(existing), reset: false, alreadyComplete: false };
}

/**
 * Re-use a `completed` or `abandoned` row for a new upload attempt: back to
 * `open`, progress zeroed, the previous attempt's `maple_id` and resolved path
 * cleared, and `created_at` bumped because this really is a new attempt.
 *
 * Completed-content changes and abandoned retries share exactly this in-place
 * reset. Their guards stay at the call site.
 */
async function reopenClosedSession(
  db: SqliteDb,
  args: OpenOrResumeArgs,
  existing: UploadSessionRow,
): Promise<OpenOrResumeResult> {
  const [updatedAt, expiresAt] = stamps();
  await db.write(
    `UPDATE upload_sessions
        SET state = 'open', total_bytes = ?, target_rel_path = ?, chunk_size = ?,
            received_bytes = 0, maple_id = NULL, resolved_rel_path = NULL,
            phasset_cloud_id = ?, created_at = ?, updated_at = ?, expires_at = ?
      WHERE id = ?`,
    [
      args.totalBytes,
      args.targetRelPath,
      args.chunkSize,
      cloudIdOrNull(args),
      updatedAt,
      updatedAt,
      expiresAt,
      existing.id,
    ],
  );
  return {
    session: toUploadSession(await reread(db, existing.id)),
    reset: true,
    alreadyComplete: false,
  };
}

/** First contact: nothing is stored under this resume key. */
async function insertFreshSession(
  db: SqliteDb,
  args: OpenOrResumeArgs,
): Promise<OpenOrResumeResult> {
  const id = newObjectIdHex();
  const [createdAt, expiresAt] = stamps();
  // Falsy rather than `!== undefined`, matching the Mongo insert: an empty
  // cloud id is not a cloud id and must not enter the peer index.
  const cloudId = args.phassetCloudId || null;
  await db.write(
    `INSERT INTO upload_sessions
       (id, library_id, device_id, phasset_local_id, phasset_cloud_id,
        target_rel_path, resolved_rel_path, total_bytes, received_bytes, chunk_size,
        state, maple_id, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 0, ?, 'open', NULL, ?, ?, ?)`,
    [
      id,
      toHex(args.libraryId),
      args.deviceId,
      args.phassetLocalId,
      cloudId,
      args.targetRelPath,
      args.totalBytes,
      args.chunkSize,
      createdAt,
      createdAt,
      expiresAt,
    ],
  );
  // Built rather than re-read: every column's value is known here, and the
  // first chunk of every upload takes this path.
  const inserted: UploadSessionRow = {
    id,
    library_id: toHex(args.libraryId),
    device_id: args.deviceId,
    phasset_local_id: args.phassetLocalId,
    phasset_cloud_id: cloudId,
    target_rel_path: args.targetRelPath,
    resolved_rel_path: null,
    total_bytes: args.totalBytes,
    received_bytes: 0,
    chunk_size: args.chunkSize,
    state: 'open',
    maple_id: null,
    created_at: createdAt,
    updated_at: createdAt,
  };
  return { session: toUploadSession(inserted), reset: false, alreadyComplete: false };
}

/**
 * Open a session for this upload, or hand back the one a previous attempt left.
 *
 * The `completed` branch is the one worth reading twice. The chunked upload
 * finished, but a downstream step in the device pipeline (sidecar, rendered
 * companion, Live Photo .mov) threw and re-enqueued the task, so the client is
 * retrying from offset 0. Without it the insert would collide on the resume
 * key, the route would answer 409 with no `expected_offset`, and the client
 * would burn retry slots until `.failedRetry`. Same content short-circuits to
 * `alreadyComplete`; drifted content is a genuine new upload and reopens.
 *
 * `maple_id` is optional on the document — `complete()` always sets it in the
 * normal flow, but a corrupt or migration-inserted row could be `completed`
 * without one. Short-circuiting then would return a 200 body the Swift client
 * cannot decode, dropping it back into the retry loop this branch exists to
 * end. A missing id counts as corrupt, and reopening re-earns it on the next
 * final chunk.
 */
export async function openOrResumeSession(
  db: SqliteDb,
  args: OpenOrResumeArgs,
): Promise<OpenOrResumeResult> {
  await abandonStalePeers(db, args);

  const existing = await readResumeRow(db, args);
  if (existing === undefined) return insertFreshSession(db, args);

  if (existing.state === 'open') {
    const resumed = await resumeOpenSession(db, args, existing);
    return resumed ?? openOrResumeSession(db, args);
  }
  if (existing.state === 'completed' && isSameContent(existing, args) && existing.maple_id) {
    return { session: toUploadSession(existing), reset: false, alreadyComplete: true };
  }
  return reopenClosedSession(db, args, existing);
}
