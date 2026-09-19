/**
 * Change journal — the import surface the poll route, the SSE route, the
 * tailer, the file operations and several worker stages already name.
 *
 * The bodies moved to `sqlite/repos/changes.repo.ts` at the cutover (#3787).
 * This file stays so the cutover merge reverts as one unit (#3752).
 *
 * Every re-export is named. On this module in particular that is not a style
 * preference — three of its symbols do not survive a blanket forward, and a
 * star export would have swapped all three silently while everything kept
 * compiling:
 *
 * **1. `allocateCursor` is gone, and it is a near-homograph of one that stays.**
 * The Mongo verb allocated a cursor and handed it back with no row attached;
 * the SQLite name `allocatedCursor` *reads* the counter and allocates nothing.
 * One character apart, opposite meanings. Forwarding the module's exports
 * wholesale would not have produced `allocateCursor` at all (so that much would
 * have failed loudly), but any later hand-edit reaching for "the one about
 * allocation" lands on the wrong verb. The allocation is now part of the insert:
 * `asset_changes.cursor` is `INTEGER PRIMARY KEY`, so it is a rowid alias and
 * the insert's `lastInsertRowid` *is* the cursor, inside the same
 * `BEGIN IMMEDIATE` batch as the row. That closes the window where a cursor
 * existed with no row. `allocateCursor` had no caller outside this module and
 * its own test, so nothing is re-exported in its place.
 *
 * **2. `currentAllocatedCursor` is gone.** It was `allocatedCursor` under the
 * old name — same query, same meaning: the highest cursor ever allocated,
 * which survives retention pruning because it counts what was issued rather
 * than what is retained. The alias was kept for one call site that has since
 * moved to the SQLite name, so nothing imports the old spelling.
 *
 * **3. `isChangeCursorTooOld` changes shape without changing behaviour.** This
 * is the one #3784 flagged, so it is worth being exact about what did and did
 * not move. The two implementations answer identically: with rows in the
 * journal, `since + 1 < MIN(cursor)`; with an empty journal, `since < current`,
 * where `current` is the larger of the highest stored cursor and the allocation
 * counter. What changed is only the types — the return is the named
 * `ChangeCursorAge` rather than an inline `{ tooOld, current }` (structurally
 * identical, so callers are unaffected), and the first parameter is a
 * `SqliteDb`. The case table lives in `sqlite/repos/changes.repo.test.ts` and
 * covers the five situations #3784 enumerates, so a later change to the guard
 * has to move a test rather than slip through.
 *
 * Deriving staleness from the surviving minimum rather than from a persisted
 * retention floor is a known difference from what #3755 landed on the Mongo
 * path, and it is the owner's accepted form for the cutover: a journal with a
 * gap at its bottom and nothing actually pruned answers 409 where the Mongo
 * path answered 200. That case is pinned by a test so the behaviour is
 * recorded rather than assumed. #3784 tracks giving the SQLite guard the
 * retention floor, and is not a blocker here — this file no longer chooses
 * between two behaviours, it forwards the one that ships.
 */

export {
  computeRelativePath,
  recordAssetChange,
  recordAssetChangeRow,
  listChangesSince,
  recordAndPublishAssetChange,
  highestCursor,
  isChangeCursorTooOld,
  type ListChangesQuery,
} from './sqlite/repos/changes.repo.ts';
