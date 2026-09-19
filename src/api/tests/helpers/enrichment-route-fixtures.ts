/**
 * The `enrichment` settings document, for the route suites that used to seed
 * and read it as a MongoDB `app_settings` collection (#3787).
 *
 * `app_settings` stores one JSON document per settings domain in a single
 * `doc` column, so "insert a saved config" and "assert what the save
 * persisted" are one `INSERT`/`SELECT` rather than a collection call. Both
 * halves live here because three suites — `enrichment-route`,
 * `enrichment-route-meilisearch` and `enrichment-semantic-validation` — do
 * exactly this and nothing else with the table.
 *
 * The nesting is the shape `enrichment-config.repo.ts` reads: the document is
 * `{ config: … }`, and every dotted `$set` it writes is `config.<field>`.
 */

import type { Database } from 'bun:sqlite';
import { run } from '../../src/db/sqlite/test-sqlite.test-helpers.ts';

/** The settings id the enrichment page, route and repo all share. */
const DOC_ID = 'enrichment';

/** Whatever the enrichment page can store — read back as JSON, never typed
 * further, because each assertion looks at one or two fields of its own. */
export type EnrichmentSettings = Record<string, unknown>;

/** Seed a saved enrichment config, as an operator's earlier save would leave it. */
export function seedEnrichmentConfig(db: Database, config: EnrichmentSettings): void {
  run(
    db,
    `INSERT INTO app_settings (id, doc) VALUES (?, ?)
     ON CONFLICT (id) DO UPDATE SET doc = excluded.doc`,
    DOC_ID,
    JSON.stringify({ config }),
  );
}

/**
 * The persisted config, or `null` when no save has happened.
 *
 * `null` is the assertion a rejected write makes — the route returned an
 * error, so nothing may have reached the table.
 */
export function readEnrichmentConfig(db: Database): EnrichmentSettings | null {
  const row = db.query(`SELECT doc FROM app_settings WHERE id = ?`).get(DOC_ID) as {
    doc: string;
  } | null;
  if (row === null) return null;
  return (JSON.parse(row.doc) as { config?: EnrichmentSettings }).config ?? {};
}
