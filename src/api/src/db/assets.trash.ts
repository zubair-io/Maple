/**
 * Trash workflows — soft-delete, hard-delete, restore.
 *
 * The bodies live in `repos/assets.trash.ts`; this file is the import surface
 * its callers name. See `assets.repo.ts` for why every re-export here is named
 * rather than a star.
 *
 * Two shape changes came across with the port, both deliberate:
 *
 *  - `dbOverride` is a `SqliteDb`. No production call site passes one.
 *  - the return is an `UpdateOutcome` / `DeleteOutcome` rather than the driver's
 *    `UpdateResult` / `DeleteResult`. They carry `matchedCount`,
 *    `modifiedCount` and `deletedCount` with the same meanings, which is what
 *    every caller branches on. The one real difference is that SQLite's
 *    `changes()` counts a row the statement touched even when the new value
 *    equals the old, so `matchedCount` and `modifiedCount` are always equal
 *    here where Mongo could report a match that changed nothing. Nothing in
 *    this repository distinguishes the two.
 *
 * `source` is now a named `LocationSource` rather than an inline object type;
 * the fields are unchanged.
 */

export { hardDelete } from './repos/assets.trash.ts';
