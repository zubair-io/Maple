/**
 * Assets repository — the import surface every `/api/assets/*` route uses.
 *
 * One name for a surface the implementation splits four ways. The bodies live
 * in `db/repos/`, by responsibility:
 *
 *   - `repos/assets.repo.ts`       reads (detail, list, core info)
 *   - `repos/assets.mutations.ts`  non-trash writes
 *   - `repos/assets.trash.ts`      soft-delete / hard-delete / restore
 *   - `repos/assets.dto.ts`        row → wire-DTO transforms
 *
 * That split is about file size and about keeping a reader on one concern at a
 * time; it is not a distinction the ~40 call sites care about, and forty
 * imports naming four modules by guesswork would be worse than one that says
 * "the assets repository". The DTO *shapes* stay in `assets.transform.ts`,
 * which is the wire contract rather than a data-access concern.
 *
 * **Every re-export below is named on purpose.** `export * from` would have
 * been shorter and is the wrong tool: it forwards whatever the other module
 * happens to export today, so a function whose parameters or return type
 * changed would be swapped in silently and the call sites would keep compiling
 * against a different contract. Naming each one means the swap is a compile
 * error when the shapes stop agreeing.
 */

export type { AssetCoreInfo } from './assets.transform.ts';

export {
  parseAssetId,
  findDetailById,
  findDetailsByIds,
  findDetailByAddress,
  findCoreInfoById,
  findListItems,
  type ListFilter,
} from './repos/assets.repo.ts';

export {
  setHasXmp,
  recordSidecarEdit,
  setPlaceOverride,
  setDescriptionOverride,
  requeueEnrichmentStage,
} from './repos/assets.mutations.ts';

export { hardDelete } from './assets.trash.ts';
