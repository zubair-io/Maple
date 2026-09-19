/**
 * Retry for a failed (or partially-failed) import.
 *
 * Kept separate from `repo.ts` because it is the one import accessor with real
 * branching — a scan-level failure re-queues for a fresh scan, a per-file
 * failure recovers only the rows whose destination is still safe — and reads
 * better on its own than buried among thin CRUD wrappers.
 *
 * The implementation moved to `db/sqlite/repos/imports.retry.ts` at the cutover
 * (#3787), with one behaviour strengthened rather than reproduced: the file-row
 * resets and the import's own reset are a single transaction there, so the
 * window this version had — file rows `pending` while the import is still
 * `failed`, repaired by a later retry — is unreachable.
 */

export { retryImport } from '../db/sqlite/repos/imports.retry.ts';
