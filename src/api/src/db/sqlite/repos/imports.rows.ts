/**
 * The rows the `imports` and `import_files` queries return, and the conversion
 * from a row to the document shape the routes and the import worker already
 * consume.
 *
 * Three column-level disagreements between the document and the table, all of
 * them resolved here rather than in the repository:
 *
 *  - **The nested counters are flat columns.** `progress.{current,total}` and
 *    `counts.{copied,skipped,failed}` were subdocuments; they are five plain
 *    INTEGER columns now, because every one of them is written individually by
 *    the worker and a JSON blob would have to be read, parsed and rewritten to
 *    move one number. {@link toImportDoc} folds them back into the two objects
 *    the DTO declares.
 *  - **Booleans are 0/1.** `scan_pending` and `cancel_requested` are
 *    `INTEGER CHECK (x IN (0, 1))`, so they come back as numbers.
 *  - **`files` is gone.** `ImportDoc.files` is the pre-split inline array,
 *    documented as legacy-only and never written by new code. There is no
 *    column for it, so a row can never carry one — see
 *    {@link toImportDoc}.
 */

import type { ObjectId } from '../../object-id.ts';
import type {
  ImportFileEntry,
  ImportFileKind,
  ImportFileState,
  ImportStatus,
  ImportWithId,
} from '../../schema.ts';
import { toBool, toObjectId } from './values.ts';

/**
 * An import file entry plus its stable position in the import. Returned by
 * `getImportFiles` so callers (the worker) can target a single row's progress
 * update by `(import_id, idx)`.
 */
export type ImportFileEntryWithIdx = ImportFileEntry & { idx: number };

/** The `imports` columns, exactly as the table declares them. */
export interface ImportRow {
  id: string;
  status: ImportStatus;
  source_root: string;
  library_id: string;
  library_root: string;
  scan_pending: number;
  progress_current: number;
  progress_total: number;
  count_copied: number;
  count_skipped: number;
  count_failed: number;
  error: string | null;
  locked_by: string | null;
  lease_expires_at: string | null;
  cancel_requested: number;
  created_at: string;
  updated_at: string;
}

/** The `import_files` columns a caller ever reads. The rowid stays internal. */
export interface ImportFileRow {
  idx: number;
  src: string;
  dest: string;
  size: number;
  mtime: number;
  kind: ImportFileKind;
  state: ImportFileState;
  error: string | null;
}

/**
 * One `imports` row as the document the routes serialise.
 *
 * `files` is deliberately absent rather than an empty array. The field is
 * documented on `ImportDoc` as legacy-only — the entries moved to their own
 * collection when a folder of tens of thousands of files pushed a single
 * import document past MongoDB's 16 MiB ceiling — and the route that renders
 * an import's detail reads the file list from `getImportFiles`, never from
 * here. An empty array would be a claim ("this import has no files") the
 * absent key does not make.
 */
export function toImportDoc(row: ImportRow): ImportWithId {
  return {
    _id: toObjectId(row.id),
    status: row.status,
    source_root: row.source_root,
    library_id: toObjectId(row.library_id),
    library_root: row.library_root,
    scan_pending: toBool(row.scan_pending),
    progress: { current: row.progress_current, total: row.progress_total },
    counts: {
      copied: row.count_copied,
      skipped: row.count_skipped,
      failed: row.count_failed,
    },
    error: row.error,
    locked_by: row.locked_by,
    lease_expires_at: row.lease_expires_at,
    cancel_requested: toBool(row.cancel_requested),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** One `import_files` row as the worker's per-file entry. */
export function toImportFileEntry(row: ImportFileRow): ImportFileEntryWithIdx {
  return {
    src: row.src,
    dest: row.dest,
    size: row.size,
    mtime: row.mtime,
    kind: row.kind,
    state: row.state,
    error: row.error,
    idx: row.idx,
  };
}

/** The bound values one `import_files` row contributes to a bulk insert. */
export function importFileParams(
  importId: string,
  entry: ImportFileEntry,
  idx: number,
): Array<string | number | null> {
  return [
    importId,
    idx,
    entry.src,
    entry.dest,
    entry.size,
    entry.mtime,
    entry.kind,
    entry.state,
    entry.error,
  ];
}

/**
 * The snapshot {@link toClaimedImport} hands a worker — enough to run the
 * import without re-querying the row.
 */
export interface ClaimedImport {
  _id: ObjectId;
  source_root: string;
  library_id: ObjectId;
  library_root: string;
  scan_pending: boolean;
}

/** A claimed import, as the snapshot the worker runs from. */
export function toClaimedImport(row: ImportRow): ClaimedImport {
  return {
    _id: toObjectId(row.id),
    source_root: row.source_root,
    library_id: toObjectId(row.library_id),
    library_root: row.library_root,
    scan_pending: toBool(row.scan_pending),
  };
}
