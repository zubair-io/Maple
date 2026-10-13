import { SEARCH_TEXT_TRIGGER_DDL } from '../ddl/asset-vectors.ts';
import { LOCATION_SEARCH_TRIGGER_DDL } from '../ddl/location-search-triggers.ts';
import type { Migration } from '../migrate.ts';

const SEARCH_TRIGGERS = [
  'faces_search_inserted',
  'faces_search_deleted',
  'faces_search_reassigned',
  'people_search_changed',
  'locations_search_inserted',
  'locations_search_changed',
  'locations_search_moved',
  'locations_search_deleted',
] as const;

const MEILISEARCH_CONFIG_KEYS = [
  'meilisearch_url',
  'meilisearch_api_key',
  'meilisearch_task_timeout_seconds',
  'meilisearch_semantic_enabled',
  'meilisearch_embedder_url',
  'meilisearch_embedder_model',
  'meilisearch_semantic_ratio',
  'search_engine',
] as const;

const SEMANTIC_MODEL_ASSIGNED = `json_extract(doc, '$.config.ai_connections.assignments."semantic-search"') IS NOT NULL`;
const SAVED_EMBEDDER_MODEL = `trim(COALESCE(json_extract(doc, '$.config.embedder_model'), ''))`;
const SAVED_MEILI_MODEL = `trim(COALESCE(json_extract(doc, '$.config.meilisearch_embedder_model'), ''))`;

/**
 * 0026 — Meilisearch is gone (#4464).
 *
 * - The `meili` stage lives on as `search-blob`, the stage that keeps the FTS5 blob current: its
 *   progress rows and worker settings carry over, minus any Meilisearch-policy pause.
 * - The faces, people and location triggers stop re-queueing `meili`; the location trigger now
 *   re-queues only `embed` (the filename is in the embedded text, not the blob).
 * - The backfill bookkeeping tables are dropped.
 * - The saved Meilisearch embedding model becomes the `embedder_model` setting when none is set
 *   and no `semantic-search` AI assignment already supplies one (an assignment outranked it, so
 *   copying it then would change the effective model). The saved embedder URL was never read, so
 *   it is dropped without being copied. The remaining `meilisearch_*` keys, the API key among
 *   them, and `search_engine` are removed from the enrichment settings.
 */
export const removeMeilisearchMigration: Migration = {
  id: '0026-remove-meilisearch',
  async up(db): Promise<void> {
    for (const trigger of SEARCH_TRIGGERS) await db.exec(`DROP TRIGGER IF EXISTS ${trigger};`);
    await db.exec(SEARCH_TEXT_TRIGGER_DDL);
    await db.exec(LOCATION_SEARCH_TRIGGER_DDL);

    await db.exec(`UPDATE OR REPLACE stage_state SET stage = 'search-blob' WHERE stage = 'meili';`);
    await db.exec(`DELETE FROM worker_config WHERE name = 'search-blob';`);
    await db.exec(`UPDATE worker_config
      SET name = 'search-blob',
          paused = CASE WHEN pause_reason IS NULL THEN paused ELSE NULL END,
          pause_reason = NULL
      WHERE name = 'meili';`);
    await db.exec(`DELETE FROM stage_handlers WHERE stage = 'meili';`);

    await db.exec(`DROP TABLE IF EXISTS meilisearch_backfill_failures;
      DROP TABLE IF EXISTS meilisearch_backfill_leases;
      DROP TABLE IF EXISTS meilisearch_backfill_state;`);

    const removals = MEILISEARCH_CONFIG_KEYS.map((key) => `'$.config.${key}'`).join(', ');
    await db.exec(`UPDATE app_settings SET doc = json_remove(
        CASE WHEN ${SAVED_EMBEDDER_MODEL} = '' AND ${SAVED_MEILI_MODEL} <> ''
              AND NOT (${SEMANTIC_MODEL_ASSIGNED})
             THEN json_set(doc, '$.config.embedder_model', ${SAVED_MEILI_MODEL})
             ELSE doc END,
        ${removals})
      WHERE id = 'enrichment';`);
  },
};
