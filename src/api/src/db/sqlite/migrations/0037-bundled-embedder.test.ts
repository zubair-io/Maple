import { expect, test } from 'bun:test';
import { runMigrations } from '../migrate.ts';
import { ALL_MIGRATIONS } from './index.ts';
import { createBlankTestDatabase, type TestDatabase } from '../test-sqlite.test-helpers.ts';

const ID = '0037-bundled-embedder';

async function migratedBefore(): Promise<TestDatabase> {
  const handle = createBlankTestDatabase('file');
  await runMigrations(
    handle.migrationDb,
    ALL_MIGRATIONS.filter((migration) => migration.id < ID),
  );
  return handle;
}

function savedConfig(handle: TestDatabase): Record<string, unknown> {
  const row = handle.db.query(`SELECT doc FROM app_settings WHERE id = 'enrichment'`).get() as {
    doc: string;
  };
  return (JSON.parse(row.doc) as { config: Record<string, unknown> }).config;
}

test('drops the embedder settings and the semantic-search assignment, keeping the rest', async () => {
  using handle = await migratedBefore();
  const generated = { connection_ids: ['strata'], model: 'qwen3' };
  handle.db.run(`INSERT INTO app_settings (id, doc) VALUES ('enrichment', ?)`, [
    JSON.stringify({
      config: {
        describe_model: 'qwen2.5vl',
        embedder_url: 'http://192.168.0.201:11434',
        embedder_model: 'bge-m3:latest',
        ai_connections: {
          connections: [{ id: 'strata', name: 'Strata', provider: 'openai', url: '' }],
          assignments: {
            'generated-search': generated,
            'semantic-search': { connection_ids: ['strata'], model: 'bge-m3' },
          },
        },
      },
    }),
  ]);

  const result = await runMigrations(handle.migrationDb, ALL_MIGRATIONS);

  expect(result.applied).toContain(ID);
  expect(savedConfig(handle)).toEqual({
    describe_model: 'qwen2.5vl',
    ai_connections: {
      connections: [{ id: 'strata', name: 'Strata', provider: 'openai', url: '' }],
      assignments: { 'generated-search': generated },
    },
  });
});

test('a database without enrichment settings migrates cleanly', async () => {
  using handle = await migratedBefore();
  const result = await runMigrations(handle.migrationDb, ALL_MIGRATIONS);
  expect(result.applied).toContain(ID);
  expect(handle.db.query(`SELECT 1 FROM app_settings WHERE id = 'enrichment'`).get()).toBeNull();
});
