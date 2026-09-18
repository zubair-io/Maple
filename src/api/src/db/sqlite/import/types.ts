/**
 * The shared vocabulary of the MongoDB → SQLite importer.
 *
 * The importer is a plan of {@link CollectionPlan}s, one per source
 * collection, executed in a fixed order. A plan knows three things and nothing
 * else: where its documents come from, what rows one document becomes, and how
 * many rows the source says there should be. Everything about batching,
 * transactions, resumption and verification is the driver's business, which is
 * what keeps a new collection to a single small declaration.
 */

import type { Db, Document, Filter } from 'mongodb';
import type { SqlValue } from '../migrate.ts';

/** One row of bound parameters, in the column order its table declares. */
export type Row = SqlValue[];

/** Rows destined for one table, sharing one column list. */
export interface TableRows {
  table: string;
  columns: readonly string[];
  rows: Row[];
}

/**
 * Everything a mapper needs beyond the document itself. Kept explicit rather
 * than read from module state so a mapper is a pure function and can be tested
 * on a literal document.
 */
export interface MapContext {
  /** The canonical per-asset stage names, seeded densely onto every asset. */
  stageNames: readonly string[];
  /** Recorded whenever a mapper had to substitute a value to satisfy a CHECK. */
  note(kind: string): void;
}

/** How a collection's `_id` sorts, which is also how a resume cursor is read back. */
export type IdKind = 'objectid' | 'string';

/** One source collection and the rows it becomes. */
export interface CollectionPlan {
  /** MongoDB collection name. */
  source: string;
  /**
   * Every SQLite table this plan writes into. The verifier asks for an
   * expected count per entry, so a table listed here without a count is a
   * mistake the verifier catches rather than a silent gap.
   */
  tables: readonly string[];
  idKind: IdKind;
  /**
   * Narrows the source set. Only the change log uses it; the bound it returns
   * is persisted on first use so a resumed run reads exactly the same set even
   * when the source has moved on.
   */
  bound?(db: Db, options: ImportOptions): Promise<Filter<Document> | null>;
  /** One document to its rows. Throwing rejects the document, with the reason. */
  map(doc: Record<string, unknown>, ctx: MapContext): TableRows[];
  /** How many rows the SOURCE says each table should hold, after `bound`. */
  expected(db: Db, filter: Filter<Document>, ctx: MapContext): Promise<Record<string, number>>;
}

/** What the operator asked for. */
export interface ImportOptions {
  /** MongoDB connection string. */
  mongoUri: string;
  /** Source database name. */
  mongoDb: string;
  /** Destination SQLite file. */
  sqlitePath: string;
  /** Documents read and written per transaction. */
  batchSize: number;
  /**
   * How many of the newest change-log rows to carry over, or `'all'`. See the
   * module comment on `plan/library.ts` for why the default is a window.
   */
  changesWindow: number | 'all';
  /** Documents sampled per collection for the field-level comparison. */
  verifySample: number;
  /** Discards any previous progress and imports from scratch. */
  restart: boolean;
  /** Called after each committed batch. */
  onProgress?(progress: ImportProgress): void;
}

/** Progress after one committed batch. */
export interface ImportProgress {
  source: string;
  documentsDone: number;
  documentsTotal: number;
  rejected: number;
  elapsedMs: number;
}

/** One document the importer could not turn into rows. */
export interface ImportReject {
  source: string;
  sourceId: string;
  reason: string;
}

/** Per-collection outcome of a run. */
export interface CollectionResult {
  source: string;
  documents: number;
  rejected: number;
  /** Zero when the collection was already complete before this run started. */
  elapsedMs: number;
  skipped: boolean;
}

/** What {@link runImport} did. */
export interface ImportReport {
  collections: CollectionResult[];
  rejects: ImportReject[];
  /** Nullable foreign keys that pointed at a row the source no longer held. */
  danglingNulled: Record<string, number>;
  /** Rows dropped because a NOT NULL foreign key pointed at a missing row. */
  danglingDropped: Record<string, number>;
  /** Values substituted to satisfy a CHECK constraint, by kind. */
  substitutions: Record<string, number>;
  /** Stage names found on assets that are not in the canonical list. */
  unknownStages: string[];
  /** The change-log cursor floor actually imported, or null for a full import. */
  changesCursorFloor: number | null;
  totalElapsedMs: number;
}

/** One table's row count, source against destination. */
export interface CountCheck {
  table: string;
  expected: number;
  actual: number;
  ok: boolean;
}

/** One sampled document compared field by field. */
export interface FieldCheck {
  source: string;
  sourceId: string;
  field: string;
  expected: string;
  actual: string;
  ok: boolean;
}

/** What {@link verifyImport} found. */
export interface VerifyReport {
  counts: CountCheck[];
  fields: FieldCheck[];
  /** Surviving `PRAGMA foreign_key_check` rows, as `table → count`. */
  foreignKeyViolations: Record<string, number>;
  rejects: ImportReject[];
  ok: boolean;
}
