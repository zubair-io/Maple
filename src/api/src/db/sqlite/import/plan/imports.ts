/**
 * Imports and their per-file rows.
 *
 * Their own module because `import_files` is filled from two places: its own
 * collection, and the inline array older `imports` documents still carry. Both
 * the mapping and the expected count have to know that, and keeping the pair
 * together is what stops one of them being changed without the other.
 */

import type { Db } from 'mongodb';
import type { CollectionPlan, Row } from '../types.ts';
import {
  asArray,
  asRecord,
  intOr,
  requireIdHex,
  toBit,
  toEnum,
  toIso,
  toText,
  textOr,
} from '../values.ts';
import { docId, onePerDocument } from './shared.ts';

const IMPORT_STATUSES = ['pending', 'running', 'done', 'failed', 'cancelled'] as const;
const IMPORT_FILE_KINDS = ['image', 'sidecar', 'movie'] as const;
const IMPORT_FILE_STATES = ['pending', 'copied', 'skipped_duplicate', 'failed'] as const;

const EPOCH = new Date(0).toISOString();

/**
 * The columns an `import_files` row carries, whether it came from the
 * collection or from the legacy array inside its `imports` document.
 */
const IMPORT_FILE_COLUMNS = [
  'import_id',
  'idx',
  'src',
  'dest',
  'size',
  'mtime',
  'kind',
  'state',
  'error',
] as const;

/** One file entry to its row, from either of the two places one can live. */
function importFileRow(entry: Record<string, unknown>, importId: string, idx: number): Row {
  const kind = toEnum(entry.kind, IMPORT_FILE_KINDS);
  const state = toEnum(entry.state, IMPORT_FILE_STATES);
  if (kind === null) throw new Error(`unknown import file kind ${String(entry.kind)}`);
  if (state === null) throw new Error(`unknown import file state ${String(entry.state)}`);
  return [
    importId,
    idx,
    textOr(entry.src, ''),
    textOr(entry.dest, ''),
    intOr(entry.size, 0),
    intOr(entry.mtime, 0),
    kind,
    state,
    toText(entry.error),
  ];
}

const importsBasePlan = onePerDocument({
  source: 'imports',
  table: 'imports',
  columns: [
    'id',
    'status',
    'source_root',
    'library_id',
    'library_root',
    'scan_pending',
    'progress_current',
    'progress_total',
    'count_copied',
    'count_skipped',
    'count_failed',
    'error',
    'locked_by',
    'lease_expires_at',
    'cancel_requested',
    'created_at',
    'updated_at',
  ],
  values: (doc) => {
    const status = toEnum(doc.status, IMPORT_STATUSES);
    if (status === null) throw new Error(`unknown import status ${String(doc.status)}`);
    const progress = asRecord(doc.progress);
    const counts = asRecord(doc.counts);
    return [
      docId(doc),
      status,
      textOr(doc.source_root, ''),
      requireIdHex(doc.library_id, 'library_id'),
      textOr(doc.library_root, ''),
      toBit(doc.scan_pending),
      intOr(progress.current, 0),
      intOr(progress.total, 0),
      intOr(counts.copied, 0),
      intOr(counts.skipped, 0),
      intOr(counts.failed, 0),
      toText(doc.error),
      toText(doc.locked_by),
      toIso(doc.lease_expires_at),
      toBit(doc.cancel_requested),
      toIso(doc.created_at) ?? EPOCH,
      toIso(doc.updated_at) ?? EPOCH,
    ];
  },
});

/**
 * An import, plus the per-file entries the older ones still hold inline.
 *
 * `ImportDoc.files` is the array the per-file rows lived in before they were
 * moved into their own collection, because a folder of tens of thousands of
 * files pushed a single `imports` document past MongoDB's 16 MiB ceiling. New
 * imports never write it, and `schema.ts` says it is still read best-effort so
 * the detail view of a pre-migration import keeps working — which makes it
 * exactly the shape of the `description_meta` bug this branch already fixed: a
 * field that exists on production documents, is read at runtime, and was in
 * neither the column list nor the list of things deliberately discarded. An
 * operator who cut over would have found those imports rendering with no files
 * at all.
 *
 * The entries become ordinary `import_files` rows, positioned by their index
 * in the array, which is what the collection's own `idx` means. A document
 * carrying both is not a shape the application produces; if one existed, the
 * two would collide on `UNIQUE (import_id, idx)` and land on the reject list
 * rather than merging into something nobody designed.
 */
export const importsPlan: CollectionPlan = {
  ...importsBasePlan,
  map(doc, ctx) {
    const importId = docId(doc);
    return [
      ...importsBasePlan.map(doc, ctx),
      {
        table: 'import_files',
        columns: IMPORT_FILE_COLUMNS,
        rows: asArray(doc.files).map((raw, idx) => importFileRow(asRecord(raw), importId, idx)),
      },
    ];
  },
};

const importFilesBasePlan = onePerDocument({
  source: 'import_files',
  table: 'import_files',
  columns: IMPORT_FILE_COLUMNS,
  values: (doc) => importFileRow(doc, requireIdHex(doc.import_id, 'import_id'), intOr(doc.idx, 0)),
});

/**
 * The `import_files` table is filled from two collections, so its expected
 * count is the sum of both: the documents of its own collection, and the
 * entries of every legacy inline array.
 */
export const importFilesPlan: CollectionPlan = {
  ...importFilesBasePlan,
  async expected(db, filter, ctx) {
    const [own, legacy] = await Promise.all([
      importFilesBasePlan.expected(db, filter, ctx),
      legacyImportFileCount(db),
    ]);
    return { import_files: (own.import_files ?? 0) + legacy };
  },
};

/** How many per-file entries still live inside an `imports` document. */
async function legacyImportFileCount(db: Db): Promise<number> {
  const rows = await db
    .collection('imports')
    .aggregate<{ total: number }>([
      { $project: { n: { $size: { $ifNull: ['$files', []] } } } },
      { $group: { _id: null, total: { $sum: '$n' } } },
    ])
    .toArray();
  return rows[0]?.total ?? 0;
}
