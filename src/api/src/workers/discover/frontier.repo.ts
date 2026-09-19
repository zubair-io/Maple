/**
 * The discover sweep frontier — the queue of directories still to visit, so a
 * walk's memory is O(one directory) rather than O(tree). A claim is atomic and
 * carries a lease, so a crashed sweeper's directory is retaken rather than
 * stranded.
 *
 * The bodies moved to `db/repos/discover-frontier.repo.ts` at the
 * cutover (#3787); this module is the import path `sweeper.ts` and `index.ts`
 * already use, kept so the move is one file rather than every call site.
 *
 * Each name is re-exported explicitly rather than with `export *`: a name whose
 * shape changed on the SQLite side then fails to compile here instead of being
 * swapped silently. `FrontierDir._id` is exactly such a change — it is the
 * frontier row's integer primary key now, not an `ObjectId`, because no caller
 * ever does anything with the value except hand it back to `completeDir`.
 */
export {
  claimNextDir,
  completeDir,
  enqueueDirs,
  remainingForGen,
  seedRoot,
} from '../../db/repos/discover-frontier.repo.ts';
export type { FrontierDir } from '../../db/repos/discover-frontier.repo.ts';
