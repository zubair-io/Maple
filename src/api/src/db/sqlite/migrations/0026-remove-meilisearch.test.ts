import { expect, test } from 'bun:test';
import { runMigrations } from '../migrate.ts';
import { ALL_MIGRATIONS } from './index.ts';
import {
  createBlankTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  type TestDatabase,
} from '../test-sqlite.test-helpers.ts';

const ID = '0026-remove-meilisearch';

async function migratedUpTo25(): Promise<TestDatabase> {
  const handle = createBlankTestDatabase('file');
  await runMigrations(
    handle.migrationDb,
    ALL_MIGRATIONS.filter((migration) => migration.id < ID),
  );
  return handle;
}

function enrichmentDoc(handle: TestDatabase, config: Record<string, unknown>): void {
  handle.db.run(`INSERT INTO app_settings (id, doc) VALUES ('enrichment', ?)`, [
    JSON.stringify({ config }),
  ]);
}

function savedConfig(handle: TestDatabase): Record<string, unknown> {
  const row = handle.db.query(`SELECT doc FROM app_settings WHERE id = 'enrichment'`).get() as {
    doc: string;
  };
  return (JSON.parse(row.doc) as { config: Record<string, unknown> }).config;
}

test('the meili stage becomes search-blob with its progress and settings', async () => {
  using handle = await migratedUpTo25();
  const asset = insertAsset(handle.db);
  handle.db.run(
    `INSERT INTO stage_state (asset_id, stage, version, processed_at) VALUES (?, 'meili', 10, 'then')`,
    [asset],
  );
  handle.db.run(
    `INSERT INTO worker_config (name, concurrency, paused, pause_reason)
     VALUES ('meili', 4, 1, 'Meilisearch rejects the embedding server address')`,
  );

  const result = await runMigrations(handle.migrationDb, ALL_MIGRATIONS);

  expect(result.applied).toContain(ID);
  expect(
    handle.db.query(`SELECT stage, version FROM stage_state WHERE asset_id = ?`).all(asset),
  ).toEqual(expect.arrayContaining([{ stage: 'search-blob', version: 10 }]));
  expect(handle.db.query(`SELECT 1 FROM stage_state WHERE stage = 'meili'`).get()).toBeNull();
  expect(
    handle.db.query(`SELECT * FROM worker_config WHERE name = 'search-blob'`).get(),
  ).toMatchObject({
    concurrency: 4,
    paused: null,
    pause_reason: null,
  });
  expect(handle.db.query(`SELECT 1 FROM worker_config WHERE name = 'meili'`).get()).toBeNull();
});

test('a location change re-queues embed alone', async () => {
  using handle = await migratedUpTo25();
  const library = insertFolder(handle.db);
  const asset = insertAsset(handle.db);
  insertLocation(handle.db, { assetId: asset, libraryId: library });
  for (const stage of ['meili', 'embed']) {
    handle.db.run(
      `INSERT INTO stage_state (asset_id, stage, version) VALUES (?, ?, 8)
       ON CONFLICT (asset_id, stage) DO UPDATE SET version = 8`,
      [asset, stage],
    );
  }
  await runMigrations(handle.migrationDb, ALL_MIGRATIONS);
  const versions = () =>
    handle.db
      .query(`SELECT stage, version FROM stage_state WHERE asset_id = ? ORDER BY stage`)
      .all(asset);

  handle.db.run(`UPDATE asset_locations SET filename = 'renamed.dng' WHERE asset_id = ?`, [asset]);

  expect(versions()).toEqual([
    { stage: 'embed', version: 0 },
    { stage: 'search-blob', version: 8 },
  ]);
});

test('the saved Meilisearch embedding model becomes the embedder model and the rest is dropped', async () => {
  using handle = await migratedUpTo25();
  enrichmentDoc(handle, {
    describe_model: 'qwen2.5vl',
    meilisearch_url: 'http://meili:7700',
    meilisearch_api_key: 'secret-key',
    meilisearch_task_timeout_seconds: 900,
    meilisearch_semantic_enabled: true,
    meilisearch_embedder_url: 'http://stale:11434',
    meilisearch_embedder_model: ' snowflake-arctic-embed2 ',
    meilisearch_semantic_ratio: 0.7,
    search_engine: 'in-process',
  });

  await runMigrations(handle.migrationDb, ALL_MIGRATIONS);

  expect(savedConfig(handle)).toEqual({
    describe_model: 'qwen2.5vl',
    embedder_model: 'snowflake-arctic-embed2',
  });
});

test('an embedder model that is already set, or a semantic-search assignment, is left as it is', async () => {
  using explicit = await migratedUpTo25();
  enrichmentDoc(explicit, { embedder_model: 'mine', meilisearch_embedder_model: 'theirs' });
  using assigned = await migratedUpTo25();
  enrichmentDoc(assigned, {
    meilisearch_embedder_model: 'theirs',
    ai_connections: {
      connections: [],
      assignments: { 'semantic-search': { connection_ids: ['a'], model: 'assigned-model' } },
    },
  });

  await runMigrations(explicit.migrationDb, ALL_MIGRATIONS);
  await runMigrations(assigned.migrationDb, ALL_MIGRATIONS);

  expect(savedConfig(explicit)).toEqual({ embedder_model: 'mine' });
  expect(savedConfig(assigned).embedder_model).toBeUndefined();
});

test('the backfill bookkeeping tables are dropped', async () => {
  using handle = await migratedUpTo25();

  await runMigrations(handle.migrationDb, ALL_MIGRATIONS);

  expect(
    handle.db.query(`SELECT name FROM sqlite_master WHERE name LIKE 'meilisearch_backfill%'`).all(),
  ).toEqual([]);
});
