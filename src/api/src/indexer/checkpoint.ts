/**
 * Per-library indexer checkpoint — where the last full walk got to, and which
 * jobs were in flight when the process went down.
 *
 * A restart re-walks the libraries whose on-disk mtime has advanced past the
 * recorded walk and re-enqueues whatever the row still lists as in flight.
 *
 * The storage moved to SQLite in #3787; the accessors live in
 * `db/sqlite/repos/indexer-checkpoints.repo.ts` and this module is the import
 * path the discover sweeper already uses. Two functions did not come across:
 *
 *  - `checkpointsCollection`, which handed out the raw Mongo collection. It had
 *    no caller outside this file.
 *  - `ensureCheckpointIndexes`, whose whole job was creating the unique index on
 *    `folderId` that the upserts depend on. `folder_id` is the table's primary
 *    key, so that uniqueness is now a property of the schema rather than of a
 *    startup call somebody has to remember to make.
 */

export {
  clearInflight,
  markInflight,
  readCheckpoint,
  writeCheckpoint,
} from '../db/sqlite/repos/indexer-checkpoints.repo.ts';
export type { CheckpointDoc } from '../db/sqlite/repos/indexer-checkpoints.repo.ts';
