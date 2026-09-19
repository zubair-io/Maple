/**
 * Assets repository — the import surface every `/api/assets/*` route uses.
 *
 * At the cutover (#3787) this stopped being an implementation and became the
 * seam. The bodies live in `db/sqlite/repos/`, split by responsibility:
 *
 *   - `sqlite/repos/assets.repo.ts`       reads (detail, list, core info)
 *   - `sqlite/repos/assets.mutations.ts`  non-trash writes
 *   - `sqlite/repos/assets.trash.ts`      soft-delete / hard-delete / restore
 *   - `sqlite/repos/assets.dto.ts`        row → wire-DTO transforms
 *
 * The DTO *shapes* stay in `assets.transform.ts`, which never touched Mongo —
 * it is the wire contract, and both sides of the port already read it.
 *
 * Kept as a file rather than deleted and its ~40 call sites rewritten, because
 * the merge that performs the cutover has to be revertible as a unit (#3752):
 * reverting it puts the Mongo bodies back here and nothing else moves. The
 * removal slice (#3785) is what collapses this file into its twin.
 *
 * **Every re-export below is named on purpose.** `export * from` would have
 * been shorter and is the wrong tool: it forwards whatever the other module
 * happens to export today, so a function whose parameters or return type
 * changed on the SQLite side would be swapped in silently and the call sites
 * would keep compiling against a different contract. Naming each one means the
 * swap is a compile error when the shapes stop agreeing. `isChangeCursorTooOld`
 * in `changes.repo.ts` is the case that made this concrete — see #3784.
 *
 * The one deliberate signature change across the whole surface: the optional
 * `dbOverride` tail parameter is a `SqliteDb` rather than a Mongo `Db`. No
 * production call site passes it; tests do, and they pass
 * `testSqliteDb(handle.db)` now.
 */

export type { AssetDetailDto, AssetListItemDto, AssetCoreInfo } from './assets.transform.ts';

export type { SqliteDb } from './sqlite/repos/db-handle.ts';

export {
  parseAssetId,
  findDetailById,
  findDetailsByIds,
  findDetailByAddress,
  findCoreInfoById,
  findListItems,
  type ListFilter,
} from './sqlite/repos/assets.repo.ts';

export {
  setHasXmp,
  recordSidecarEdit,
  setPlaceOverride,
  setDescriptionOverride,
  requeueEnrichmentStage,
} from './sqlite/repos/assets.mutations.ts';

export { hardDelete } from './assets.trash.ts';
