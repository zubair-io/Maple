/**
 * The one-shot MongoDB → SQLite importer.
 *
 * `scripts/mongo-to-sqlite.ts` is the operator's entry point; this is the
 * surface it and the tests drive.
 */

export { DEFAULT_CHANGES_WINDOW, IMPORT_PLAN, SKIPPED_COLLECTIONS } from './plan/index.ts';
export {
  closeImportSession,
  openImportSession,
  runImport,
  runImportOn,
  type ImportSession,
} from './run.ts';
export { foreignKeyViolations, repairForeignKeys, type RepairResult } from './repair.ts';
export { readCheckpoint, readRejects, BOOKKEEPING_TABLES } from './bookkeeping.ts';
export { verifyCounts, verifyImport, verifyRowsPresent } from './verify.ts';
export { verifyAssetFields } from './verify-assets.ts';
export { mapAsset } from './plan/assets.ts';
export type {
  CollectionPlan,
  CollectionResult,
  CountCheck,
  FieldCheck,
  ImportOptions,
  ImportProgress,
  ImportReject,
  ImportReport,
  MapContext,
  VerifyReport,
} from './types.ts';
