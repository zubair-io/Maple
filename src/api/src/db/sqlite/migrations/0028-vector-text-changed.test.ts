import { expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { runMigrations } from '../migrate.ts';
import { ALL_MIGRATIONS } from './index.ts';
import { createBlankTestDatabase, insertFolder } from '../test-sqlite.test-helpers.ts';
import { seedSearchAsset } from '../../repos/search.test-helpers.ts';
import { storeVector } from '../../../search/search.test-helpers.ts';
import { upsertAssetVectorStatement } from '../../repos/asset-vectors.repo.ts';

const ID = '0028-vector-text-changed';

function stampOf(db: Database, mapleId: string): string | null {
  const row = db
    .query(`SELECT text_changed_at FROM asset_vectors WHERE maple_id = ?`)
    .get(mapleId) as { text_changed_at: string | null } | null;
  return row?.text_changed_at ?? null;
}

function writeBlob(db: Database, mapleId: string, blob: string | null): void {
  if (blob === null) {
    db.run(`DELETE FROM asset_search WHERE asset_id = (SELECT id FROM assets WHERE maple_id = ?)`, [
      mapleId,
    ]);
    return;
  }
  db.run(
    `INSERT INTO asset_search (asset_id, search_blob) SELECT id, ? FROM assets WHERE maple_id = ?
     ON CONFLICT (asset_id) DO UPDATE SET search_blob = excluded.search_blob`,
    [blob, mapleId],
  );
}

test('every search_blob change stamps the vector row, an identical rewrite does not', async () => {
  using handle = createBlankTestDatabase('file');
  const result = await runMigrations(handle.migrationDb, ALL_MIGRATIONS);
  expect(result.applied).toContain(ID);
  const libraryId = insertFolder(handle.db, { slug: 'stamp', path: '/lib' });
  seedSearchAsset(handle.db, libraryId, { filename: 'a.dng', mapleId: 'a' });
  seedSearchAsset(handle.db, libraryId, { filename: 'b.dng', mapleId: 'b' });
  storeVector(handle.db, 'a', 0, '2026-10-10T10:00:00.000Z');

  writeBlob(handle.db, 'b', 'no vector to stamp');
  expect(stampOf(handle.db, 'b')).toBeNull();

  writeBlob(handle.db, 'a', 'athlete lacrosse');
  const inserted = stampOf(handle.db, 'a');
  expect(inserted).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  handle.db.run(`UPDATE asset_vectors SET text_changed_at = '2000-01-01T00:00:00.000Z'`);
  writeBlob(handle.db, 'a', 'athlete lacrosse');
  expect(stampOf(handle.db, 'a')).toBe('2000-01-01T00:00:00.000Z');

  writeBlob(handle.db, 'a', 'athlete rugby');
  expect(stampOf(handle.db, 'a')! > '2000-01-01T00:00:00.000Z').toBe(true);

  handle.db.run(`UPDATE asset_vectors SET text_changed_at = '2000-01-01T00:00:00.000Z'`);
  writeBlob(handle.db, 'a', null);
  expect(stampOf(handle.db, 'a')! > '2000-01-01T00:00:00.000Z').toBe(true);
  expect(
    handle.db.query(`SELECT embedded_at FROM asset_vectors WHERE maple_id = 'a'`).get(),
  ).toEqual({ embedded_at: '2026-10-10T10:00:00.000Z' });
});

test("a re-embed keeps the row's text stamp", async () => {
  using handle = createBlankTestDatabase('file');
  await runMigrations(handle.migrationDb, ALL_MIGRATIONS);
  const libraryId = insertFolder(handle.db, { slug: 'embed', path: '/lib' });
  seedSearchAsset(handle.db, libraryId, { filename: 'a.dng', mapleId: 'a' });
  storeVector(handle.db, 'a', 0, '2026-10-10T10:00:00.000Z');
  writeBlob(handle.db, 'a', 'athlete lacrosse');
  const stamped = stampOf(handle.db, 'a');

  const vector = new Float32Array(1024);
  vector[1] = 1;
  const { sql, params } = upsertAssetVectorStatement({
    mapleId: 'a',
    version: 8,
    model: 'bge-m3',
    endpoint: 'http://gpu',
    vector,
    embeddedAt: new Date('2026-10-11T10:00:00.000Z'),
  });
  handle.db.run(sql, params as never);

  expect(stampOf(handle.db, 'a')).toBe(stamped);
});

test('the text-change poll reads the partial index alone', async () => {
  using handle = createBlankTestDatabase('file');
  await runMigrations(handle.migrationDb, ALL_MIGRATIONS);
  const plan = (
    handle.db
      .query(
        `EXPLAIN QUERY PLAN SELECT maple_id, text_changed_at FROM asset_vectors
          WHERE text_changed_at > ? AND dims = 1024 AND model IN ('bge-m3', 'bge-m3:latest')
            AND (text_changed_at, maple_id) > (?, ?)
          ORDER BY text_changed_at, maple_id LIMIT 5000`,
      )
      .all('2026-10-10', '2026-10-10', '') as Array<{ detail: string }>
  )
    .map((row) => row.detail)
    .join(' | ');

  expect(plan).toContain('COVERING INDEX asset_vectors_text_poll');
});
