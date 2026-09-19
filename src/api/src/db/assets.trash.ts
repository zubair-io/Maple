/**
 * Trash workflows — soft-delete, hard-delete, restore.
 *
 * The bodies moved to `sqlite/repos/assets.trash.ts` at the cutover (#3787);
 * this file stays as the import surface its callers already name, and so the
 * cutover merge reverts as one unit (#3752). See `assets.repo.ts` for why every
 * re-export here is named rather than a star.
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

export { hardDelete } from './sqlite/repos/assets.trash.ts';
