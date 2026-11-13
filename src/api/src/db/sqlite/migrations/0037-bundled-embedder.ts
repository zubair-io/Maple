import type { Migration, MigrationDb } from '../migrate.ts';

const RETIRED_KEYS = [
  '$.config.embedder_url',
  '$.config.embedder_model',
  '$.config.ai_connections.assignments."semantic-search"',
] as const;

/**
 * 0037 — semantic search embeds with the bundled bge-m3 (#5445), so the `embed` stage's endpoint
 * and model settings and the Semantic search AI assignment are dropped from the enrichment
 * settings. Stored vectors are untouched: a `bge-m3` row stays current whoever wrote it.
 */
export const bundledEmbedderMigration: Migration = {
  id: '0037-bundled-embedder',
  async up(db: MigrationDb): Promise<void> {
    await db.exec(`UPDATE app_settings
      SET doc = json_remove(doc, ${RETIRED_KEYS.map((key) => `'${key}'`).join(', ')})
      WHERE id = 'enrichment' AND json_valid(doc);`);
  },
};
