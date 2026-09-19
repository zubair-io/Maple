/**
 * "The import finished" and "the import is correct" are different claims with
 * different evidence. This module produces the second one.
 *
 * Four pieces of evidence, and each covers a failure the others cannot see:
 *
 *  1. **Row counts, per table, against the source.** The source side is an
 *    aggregation rather than a document count wherever one document fans out —
 *    `asset_locations` is the sum of the `fileinfo` array lengths, `stage_state`
 *    the union of the canonical stage names with whatever the document carries.
 *    This catches a whole batch lost to a rolled-back transaction, and a mapper
 *    that quietly skips a row shape.
 *  2. **Row presence, per sampled document.** Every row the mapper produces for
 *    a sampled document is looked up with null-safe equality on all of its
 *    columns, so the row has to be present verbatim. This catches a misaligned
 *    column list, a value SQLite coerced on the way in, and a row that landed
 *    in the right table with the wrong contents.
 *  3. **Field-level probes on sampled assets**, stated independently of the
 *    mapper. See `verify-assets.ts` — a check that uses the mapper as its own
 *    definition of correctness cannot catch a mapper that is wrong.
 *  4. **`PRAGMA foreign_key_check` and the reject list.** The first confirms
 *    the destination is safe to open with foreign keys on; the second is the
 *    list of documents that could not be written at all, and a single entry is
 *    enough to fail the verdict.
 */

import type { Database } from 'bun:sqlite';
import type { Db, Document, Filter } from 'mongodb';
import { ALL_STAGE_NAMES } from '../../../workers/stages/stage-names.ts';
import { derivedRestored, readMeta, readRejects } from './bookkeeping.ts';
import { releasedTo, type LocationEntry } from './location-holder.ts';
import { IMPORT_PLAN } from './plan/index.ts';
import {
  foreignKeyViolations,
  NULLABLE_FOREIGN_KEYS,
  REPAIR_META_KEY,
  REQUIRED_FOREIGN_KEYS,
  type RepairResult,
} from './repair.ts';
import type {
  CollectionPlan,
  CountCheck,
  FieldCheck,
  ImportOptions,
  MapContext,
  Row,
  TableRows,
  VerifyReport,
} from './types.ts';
import { verifyAssetFields } from './verify-assets.ts';

/**
 * A context that discards notes — verification does not re-count them.
 *
 * It also maps as though NOTHING had been released, which is deliberate: handing
 * the verifier the importer's own released set would make every check agree with
 * the importer by construction. The mapper therefore produces the full set of
 * location rows here, and each one the destination does not hold has to be
 * justified against the destination instead — see `absentByDesign`.
 */
const VERIFY_CONTEXT: MapContext = {
  stageNames: ALL_STAGE_NAMES,
  note: () => {},
  releasedLocation: () => false,
};

/** Reads back the filter a plan's import actually used. */
function storedFilter(sqlite: Database, plan: CollectionPlan): Filter<Document> {
  if (plan.bound === undefined) return {};
  const remembered = readMeta(sqlite, `bound:${plan.source}`);
  return remembered === null ? {} : (JSON.parse(remembered) as Filter<Document>);
}

/**
 * Rows the repair pass dropped, per table.
 *
 * A location under a library root the operator unregistered is a row the source
 * counts and the destination correctly does not hold, so the expected count has
 * to be the source count minus what was dropped. Without this the count check
 * would report a failure for a library that is in fact imported exactly right.
 */
function droppedByTable(sqlite: Database): Record<string, number> {
  const stored = readMeta(sqlite, REPAIR_META_KEY);
  if (stored === null) return {};
  const repair = JSON.parse(stored) as RepairResult;
  const out: Record<string, number> = {};
  for (const [key, count] of Object.entries(repair.dropped ?? {})) {
    const table = key.split('.')[0] ?? key;
    out[table] = (out[table] ?? 0) + count;
  }
  return out;
}

function rowCount(sqlite: Database, table: string): number {
  const row = sqlite.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

/** Per-table row counts, source against destination. */
async function verifyCounts(
  mongo: Db,
  sqlite: Database,
  plans: readonly CollectionPlan[] = IMPORT_PLAN,
): Promise<CountCheck[]> {
  const dropped = droppedByTable(sqlite);
  const out: CountCheck[] = [];
  for (const plan of plans) {
    const filter = storedFilter(sqlite, plan);
    const expected = await plan.expected(mongo, filter, VERIFY_CONTEXT);
    for (const table of plan.tables) {
      const want = (expected[table] ?? 0) - (dropped[table] ?? 0);
      const got = rowCount(sqlite, table);
      out.push({ table, expected: want, actual: got, ok: want === got });
    }
  }
  return out;
}

/**
 * Null-safe exact lookup: every column of a mapped row has to match, with `IS`
 * rather than `=` so a null column compares equal to a null column instead of
 * to nothing at all.
 */
function rowPresent(
  sqlite: Database,
  table: string,
  columns: readonly string[],
  row: Row,
): boolean {
  const predicate = columns.map((column) => `${column} IS ?`).join(' AND ');
  const found = sqlite
    .query(`SELECT 1 AS present FROM ${table} WHERE ${predicate} LIMIT 1`)
    .get(...(row as never[])) as { present: number } | null;
  return found !== null;
}

/** True when `value` names a row that exists in `parent`. */
function resolves(sqlite: Database, parent: string, key: string, value: Row[number]): boolean {
  return (
    sqlite
      .query(`SELECT 1 AS present FROM ${parent} WHERE ${key} IS ? LIMIT 1`)
      .get(value as never) !== null
  );
}

/**
 * The mapped row as the database should hold it, after the repair pass.
 *
 * A nullable foreign key pointing at a row the source no longer has is nulled
 * on import, because that is what the column's own `ON DELETE SET NULL`
 * declares — a face assigned to a person who was deleted, say. Comparing the
 * mapper's output to the stored row without applying the same rule would
 * report a mismatch on a library that imported exactly right.
 */
function afterRepair(sqlite: Database, table: string, columns: readonly string[], row: Row): Row {
  const repaired = [...row];
  for (const fk of NULLABLE_FOREIGN_KEYS) {
    if (fk.table !== table) continue;
    const index = columns.indexOf(fk.column);
    if (index < 0) continue;
    const value = repaired[index];
    if (value === null || value === undefined) continue;
    if (!resolves(sqlite, fk.parent, fk.parentKey, value)) repaired[index] = null;
  }
  return repaired;
}

/** A mapped `asset_locations` row, read back by column name. */
function locationEntry(columns: readonly string[], row: Row): LocationEntry {
  const at = (column: string): unknown => row[columns.indexOf(column)] ?? null;
  const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  return {
    assetId: String(at('asset_id')),
    ordinal: Number(at('ordinal')),
    libraryId: String(at('library_id')),
    path: String(at('path')),
    filename: String(at('filename')),
    deletedAt: text(at('deleted_at')),
    missingSince: text(at('missing_since')),
  };
}

/**
 * Why a mapped row is legitimately absent, or null when it should be there.
 *
 * Two things make a row's absence correct rather than a failure, and both are
 * confirmed by re-asking the question the importer asked rather than by
 * trusting that it asked it:
 *
 *  - the repair pass drops a row whose NOT NULL foreign key does not resolve —
 *    a location under a library root that was unregistered, say;
 *  - a location entry that lost its address to a better claim is released, and
 *    `releasedTo` re-runs the ranking against the row that holds it, so an
 *    importer that kept the wrong side of a contest fails here.
 */
function absentByDesign(
  sqlite: Database,
  table: string,
  columns: readonly string[],
  row: Row,
): string | null {
  if (table === 'asset_locations') {
    const released = releasedTo(sqlite, locationEntry(columns, row));
    if (released !== null) return released;
  }
  for (const fk of REQUIRED_FOREIGN_KEYS) {
    if (fk.table !== table) continue;
    const index = columns.indexOf(fk.column);
    if (index < 0) continue;
    const value = row[index];
    if (value === null || value === undefined) continue;
    if (!resolves(sqlite, fk.parent, fk.parentKey, value)) {
      return `dropped: ${fk.column} does not resolve`;
    }
  }
  return null;
}

/**
 * Every row one sampled document should have produced, checked for presence.
 *
 * A document the mapper refuses is skipped rather than reported: it is already
 * on the reject list, which fails the verdict on its own, and reporting it a
 * second time here would only add noise to the failure output.
 */
function checkDocument(
  sqlite: Database,
  plan: CollectionPlan,
  doc: Record<string, unknown>,
): FieldCheck[] {
  const sourceId = String(doc._id);
  const batches = mapQuietly(plan, doc);
  return batches.flatMap((batch) =>
    batch.rows.map((raw, index) => {
      const row = afterRepair(sqlite, batch.table, batch.columns, raw);
      const present = rowPresent(sqlite, batch.table, batch.columns, row);
      const excuse = present ? null : absentByDesign(sqlite, batch.table, batch.columns, row);
      return {
        source: plan.source,
        sourceId,
        field: `${batch.table}[${index}]`,
        expected: 'present',
        actual: present ? 'present' : (excuse ?? 'missing'),
        ok: present || excuse !== null,
      };
    }),
  );
}

/** The rows a document maps to, or none when the mapper refuses it. */
function mapQuietly(plan: CollectionPlan, doc: Record<string, unknown>): TableRows[] {
  try {
    return plan.map(doc, VERIFY_CONTEXT);
  } catch {
    return [];
  }
}

/**
 * Re-maps a sample of every collection and confirms each produced row is
 * present verbatim.
 */
async function verifyRowsPresent(
  mongo: Db,
  sqlite: Database,
  sample: number,
  plans: readonly CollectionPlan[] = IMPORT_PLAN,
): Promise<FieldCheck[]> {
  const out: FieldCheck[] = [];
  for (const plan of plans) {
    const docs = await mongo
      .collection(plan.source)
      .find(storedFilter(sqlite, plan), { sort: { _id: 1 }, limit: sample })
      .toArray();
    // Sampled documents are hydrated exactly as the load hydrated them.
    // Without this a plan that gathers its rows from a second collection maps
    // to nothing here, `mapQuietly` swallows the refusal, and the collection
    // quietly contributes no field checks at all — so the one plan whose bytes
    // are worth re-deriving would be the one plan never checked.
    const source =
      (await plan.hydrate?.(mongo, docs as unknown as Record<string, unknown>[])) ?? docs;
    for (const doc of source) {
      out.push(...checkDocument(sqlite, plan, doc as unknown as Record<string, unknown>));
    }
  }
  return out;
}

/** Runs every check and returns the verdict. */
export async function verifyImport(
  mongo: Db,
  sqlite: Database,
  options: Pick<ImportOptions, 'verifySample'>,
): Promise<VerifyReport> {
  const counts = await verifyCounts(mongo, sqlite);
  const rows = await verifyRowsPresent(mongo, sqlite, options.verifySample);
  const assetFields = await verifyAssetFields(mongo, sqlite, options.verifySample);
  const violations = foreignKeyViolations(sqlite);
  const rejects = readRejects(sqlite);
  const fields = [...rows, ...assetFields];
  // A file whose derived triggers are still dropped answers every query here
  // correctly and would still be the wrong file to start a server against, so
  // it is part of the verdict rather than a footnote to it.
  const derived = derivedRestored(sqlite);

  return {
    counts,
    fields,
    foreignKeyViolations: violations,
    rejects,
    derivedRestored: derived,
    ok:
      counts.every((entry) => entry.ok) &&
      fields.every((entry) => entry.ok) &&
      Object.keys(violations).length === 0 &&
      rejects.length === 0 &&
      derived,
  };
}
