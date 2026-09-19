/**
 * Imports and their per-file rows.
 *
 * Their own module because `import_files` is filled from two places: its own
 * collection, and the inline array older `imports` documents still carry. Both
 * the mapping and the expected count have to know that, and keeping the pair
 * together is what stops one of them being changed without the other.
 */

import { ObjectId, type Db } from 'mongodb';
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
 * at all. The owner's library has six such imports holding 14,809 file records
 * between them, so this is not a hypothetical.
 *
 * The entries become ordinary `import_files` rows, positioned by their index in
 * the array, which is what the collection's own `idx` means.
 *
 * ## An import can carry both copies, and the rows are the canonical one
 *
 * This comment used to say that a document carrying both "is not a shape the
 * application produces". That was right about the application and wrong about
 * the data (#3791): the array came first, the collection replaced it, and one
 * import was written during the changeover and kept both. The owner's library
 * has exactly one, and its 31 inline entries and 31 rows agree field for field
 * — a row is an inline entry promoted into its own collection, carrying three
 * things the entry does not (its own id, the import's id, and the ordinal).
 *
 * So where rows exist they are the copy to write, and the inline array is a
 * duplicate to skip; where they do not, the array is the only copy there is.
 * Stated that way round rather than as "they happen to match", because the
 * rule has to hold for an import whose two copies have drifted, and there the
 * collection is the one the application has been writing.
 *
 * Left unsaid, the two copies collide on `UNIQUE (import_id, idx)`: the inline
 * half is written first, the collection's rows lose, and the whole import
 * document lands on the reject list — which is what failed the production
 * verification 31 rows short.
 */
export const importsPlan: CollectionPlan = {
  ...importsBasePlan,
  /**
   * Drops the inline array of any import whose files are already rows.
   *
   * A batch-wide question rather than a per-document one, which is what
   * `hydrate` is for: one `distinct` over the batch's ids answers it for every
   * document in the batch, and `map` stays a pure function of the document it
   * is handed. The empty array it is left with is the honest input — this
   * import contributes no rows from its inline copy — and it is what the
   * verifier re-maps too, since verification hydrates the same way.
   */
  async hydrate(db, docs) {
    const ids = docs.map((doc) => doc._id).filter((id) => id instanceof ObjectId);
    if (ids.length === 0) return [...docs];
    const withRows = await db
      .collection('import_files')
      .distinct('import_id', { import_id: { $in: ids } });
    const superseded = new Set(withRows.map((id) => String(id)));
    return docs.map((doc) => (superseded.has(String(doc._id)) ? { ...doc, files: [] } : doc));
  },
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
 * entries of every legacy inline array the collection has not superseded.
 *
 * The second half has to apply the same rule the mapper does, which is the
 * whole reason these two live in one module — an import that carries both
 * copies contributes its rows and not its array, and counting the array as
 * well would expect 31 rows the destination correctly does not hold.
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

/**
 * How many per-file entries live inside an `imports` document and nowhere else.
 *
 * The imports whose files are already rows are excluded by id: there are a
 * handful of imports in a library, so naming them is cheaper and plainer than
 * a lookup, and it is the same question `hydrate` asks one batch at a time.
 */
async function legacyImportFileCount(db: Db): Promise<number> {
  const superseded = await db.collection('import_files').distinct('import_id');
  const rows = await db
    .collection('imports')
    .aggregate<{ total: number }>([
      { $match: { _id: { $nin: superseded } } },
      { $project: { n: { $size: { $ifNull: ['$files', []] } } } },
      { $group: { _id: null, total: { $sum: '$n' } } },
    ])
    .toArray();
  return rows[0]?.total ?? 0;
}
