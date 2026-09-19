/**
 * ChangeFeedTailer — bridges persisted `asset_changes` rows to the in-process
 * ChangeBus.
 *
 * Why this exists: worker stages run in CHILD processes spawned by the
 * supervisor. When a worker calls `recordAndPublishAssetChange` the row lands in
 * the database (visible to every process) but the `getChangeBus().publish()`
 * only fires on the child's local bus — the parent API process, where SSE
 * clients are connected, never sees it. Without the tailer, every worker-emitted
 * change is invisible to the File Provider extension.
 *
 * ## Where the implementation went (#3787)
 *
 * `runtime/sqlite/change-feed-tailer.ts` is the tailer now, re-exported below
 * one name at a time so a changed signature fails to compile here rather than
 * being swapped in silently. `index.ts` keeps importing `getChangeFeedTailer`
 * from this path.
 *
 * There was never a Mongo change stream or oplog tail to replace: the tailer
 * polls — every `intervalMs` it reads the rows above the highest cursor it has
 * republished and hands each to the bus's cursor-idempotent `publish()`. That
 * shape carries over unchanged; only the read underneath it moved, from a
 * `find({ cursor: { $gt } })` to `listChangesSince()`.
 *
 * ## One behavioural difference, and it is a fix
 *
 * The bus's persisted high watermark is now seeded from the larger of the
 * journal's highest cursor and the allocation counter, where this module used
 * the journal alone. Retention pruning (#3741) deletes old rows by design, so a
 * swept journal read 0, the watermark started at 0, and
 * `ChangeBus.isCursorReplayable` then answered true for every stale cursor it
 * was asked about. A client that was offline across a sweep reconnected, was
 * told its cursor was fine, and got an open stream carrying nothing — silently
 * missing every change the sweep removed, with no 409 to send it back for a full
 * re-enumeration. `server_state.seq` survives pruning because it counts what was
 * allocated rather than what is retained, so seeding from the larger of the two
 * makes the empty-journal case answer 409 exactly as the pruned-but-non-empty
 * case already did.
 */

export {
  getChangeFeedTailer,
  __resetChangeFeedTailerForTests,
} from './sqlite/change-feed-tailer.ts';
