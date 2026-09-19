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
  /**
   * True when this `fileinfo` entry lost its `(library_id, path, filename)` to
   * a better claim and must not become a row.
   *
   * Decided for the whole collection before any document is mapped, because the
   * conflict is between documents and a mapper only ever sees one — see
   * `plan/contested-locations.ts`. A mapper still takes no database and stays a
   * pure function of one document plus this context.
   */
  releasedLocation(assetId: string, ordinal: number): boolean;
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
   * Further source collections this plan consumes, which the coverage check
   * counts as covered.
   *
   * Only the lens-profile bucket needs it: GridFS splits one file across
   * `lens_profiles.files` and `lens_profiles.chunks`, and the chunks are read
   * and written rather than left behind — so naming them in
   * `SKIPPED_COLLECTIONS` would assert something false.
   */
  alsoReads?: readonly string[];
  /**
   * Narrows the source set. Only the change log uses it; the bound it returns
   * is persisted on first use so a resumed run reads exactly the same set even
   * when the source has moved on.
   */
  bound?(db: Db, options: ImportOptions): Promise<Filter<Document> | null>;
  /**
   * Fetches whatever a document needs from outside its own collection, once per
   * batch, and returns the documents {@link map} will see.
   *
   * `map` is synchronous and takes no database, which is what keeps a plan a
   * pure function of one document — and is right for every collection whose
   * rows come from the document alone. A GridFS file is the exception: its bytes
   * live in another collection entirely, so they have to be gathered before
   * mapping. Returning new documents rather than mutating the driver's keeps
   * `map` pure either way.
   *
   * Throwing here fails the run rather than rejecting one document: a batch-wide
   * read that fails says nothing about any single document in it.
   */
  hydrate?(db: Db, docs: readonly Record<string, unknown>[]): Promise<Record<string, unknown>[]>;
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

/** A `--changes-window` this run asked for and a resumed bound overrode. */
export interface WindowOverride {
  source: string;
  requested: string;
  inEffect: string;
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
  /**
   * Location entries that lost their address to a better claim, by the rule
   * that decided it, and how many addresses were contested at all.
   *
   * Counted from the resolution rather than from the mapping, so a resumed run
   * reports the same numbers as the run it continues: the decision is a
   * property of the source, not of how far the import got.
   */
  locationsReleased: Record<string, number>;
  contestedAddresses: number;
  /** Stage names found on assets that are not in the canonical list. */
  unknownStages: string[];
  /** The change-log cursor floor actually imported, or null for a full import. */
  changesCursorFloor: number | null;
  /** Flags this run asked for that a resumed bound ignored. */
  windowOverrides: WindowOverride[];
  /**
   * False when the run did not reach the end: the derived triggers and the
   * FTS5 index are not in place, so the file is not one to point a server at.
   */
  derivedRestored: boolean;
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
  /** False when the load's dropped triggers were never put back. */
  derivedRestored: boolean;
  ok: boolean;
}
