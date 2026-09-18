/**
 * mirror_queue repo — the durable work queue between the *detectors* (the
 * mirror-scan worker + the inline `onMirrorFailure` sink) and the mirror *copy*
 * worker. Detectors only enqueue; the copy worker claims, copies, and
 * completes/retries. Claim is atomic with a lease so a crashed worker's row is
 * retaken. Mirrors the `discover_frontier` pattern.
 *
 * ## Where the queries went (#3787)
 *
 * The implementation is `db/sqlite/repos/mirror-queue.repo.ts`; this module is
 * now the import path its five callers already use, re-exported name by name so
 * a changed signature surfaces as a compile error here rather than being
 * swapped in unnoticed.
 *
 * One type did change, deliberately. `MirrorQueueEntry._id` is a number rather
 * than an `ObjectId`, because `mirror_queue` rows carry an `INTEGER PRIMARY KEY`
 * rowid — the id never reaches a client, and its only consumer,
 * `workers/mirror/copy.ts`, takes it off a claimed row and hands it straight
 * back to `completeMirrorCopy` or `failMirrorCopy` without ever serialising,
 * comparing or storing it. The SQLite module's header sets out the full
 * argument, including why the claim is a compare-and-swap rather than
 * `UPDATE … RETURNING`.
 */

export {
  claimNextMirrorCopy,
  completeMirrorCopy,
  enqueueMirrorCopy,
  failMirrorCopy,
  mirrorQueueCounts,
  retryDeadMirrorCopies,
  type MirrorQueueEntry,
} from '../db/sqlite/repos/mirror-queue.repo.ts';
