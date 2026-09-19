/**
 * The shape most collections share: one document becomes one row in one table,
 * and the expected row count is the source document count.
 *
 * Twenty-odd of the twenty-seven collections are exactly that, so they are
 * declared through {@link onePerDocument} and consist of a column list plus a
 * function from document to values. The three that are not — assets, which fans
 * out across eight tables, and the two natural-key collections whose primary
 * key is not an ObjectId — say so explicitly.
 */

import type { Db, Document, Filter } from 'mongodb';
import type { CollectionPlan, IdKind, MapContext, Row, TableRows } from '../types.ts';
import { requireIdHex } from '../values.ts';

/** Builds the `INSERT` a {@link TableRows} batch is bound to. */
export function insertSql(table: string, columns: readonly string[]): string {
  const placeholders = columns.map(() => '?').join(', ');
  return `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`;
}

/**
 * A collection that maps one document to one row of one table.
 *
 * `values` returns the row in `columns` order, or `null` to skip the document
 * deliberately — which is different from rejecting it, and the only current
 * user is the change log's already-bounded window. Throwing rejects it.
 */
export function onePerDocument(spec: {
  source: string;
  table: string;
  columns: readonly string[];
  idKind?: IdKind;
  values(doc: Record<string, unknown>, ctx: MapContext): Row | null;
  bound?(db: Db, options: never): Promise<Filter<Document> | null>;
}): CollectionPlan {
  const { source, table, columns } = spec;
  return {
    source,
    tables: [table],
    idKind: spec.idKind ?? 'objectid',
    map(doc, ctx): TableRows[] {
      const row = spec.values(doc, ctx);
      return row === null ? [] : [{ table, columns, rows: [row] }];
    },
    async expected(db: Db, filter: Filter<Document>): Promise<Record<string, number>> {
      return { [table]: await db.collection(source).countDocuments(filter) };
    },
  };
}

/**
 * The `_id` of a document whose primary key is a client-visible ObjectId,
 * as the 24-character hex the SQLite `TEXT PRIMARY KEY` holds.
 */
export function docId(doc: Record<string, unknown>): string {
  return requireIdHex(doc._id, '_id');
}

/**
 * The creation time an ObjectId carries in its first four bytes, as ISO 8601.
 *
 * It IS when the row was created, which makes it the closest true answer
 * available for the handful of the oldest production documents that predate
 * `indexed_at` — a field the destination declares NOT NULL and the contest
 * ranking reads.
 */
export function objectIdTimestamp(hex: string): string {
  return new Date(Number.parseInt(hex.slice(0, 8), 16) * 1000).toISOString();
}

/** The `_id` of a natural-key collection, which is already a string. */
export function docKey(doc: Record<string, unknown>): string {
  const value = doc._id;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`_id: expected a non-empty string key, got ${String(value)}`);
  }
  return value;
}
