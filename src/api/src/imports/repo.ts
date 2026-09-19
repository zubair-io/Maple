/**
 * Accessor for the `imports` table (ticket #742).
 *
 * The `imports` row IS the work queue — claim and lease live on it — so this
 * mirrors `job-runner/jobs.repo.ts` in shape as well as in purpose: a thin typed
 * surface with no business logic, so the routes, the worker and the tests share
 * one set of names and cannot drift on them.
 *
 * Every operation moved to `db/repos/imports.repo.ts` at the cutover
 * (#3787), which was written function-for-function against this module — same
 * names, same parameters, same return types, plus the optional trailing
 * `dbOverride` every repository in that directory takes and no caller here
 * passes. So this file is now the import path and nothing else.
 *
 * The named re-export is deliberate rather than `export *`: it is what makes a
 * function that quietly disappears from the repository a compile error here
 * instead of an undefined import at the call site.
 *
 * One behaviour is gone rather than ported, and the repository's own doc
 * explains it: `getImportFiles` used to fall back to a legacy inline
 * `ImportDoc.files` array and hydrate the per-file rows from it on first
 * read. The table has no `files` column — the Mongo-to-SQLite import writes
 * those legacy entries out as rows — so the fallback has nothing to read.
 */

export {
  assetExistsForHash,
  claimImport,
  completeImport,
  createImport,
  failImport,
  getImport,
  getImportFiles,
  isImportCancelRequested,
  listImports,
  markImportCancelled,
  renewImportLease,
  requestImportCancel,
  setImportFiles,
  updateImportProgress,
} from '../db/repos/imports.repo.ts';

export type { ClaimedImport } from '../db/repos/imports.repo.ts';
