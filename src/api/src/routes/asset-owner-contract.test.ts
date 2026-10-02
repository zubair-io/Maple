import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';
import {
  createTempLibrary,
  insertAsset,
  insertLocation,
  run,
  testSqliteDb,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { ObjectId } from '../db/object-id.ts';
import { findDetailsByIds } from '../db/repos/assets.repo.ts';
import type { SqliteDb } from '../db/repos/db-handle.ts';
import type { SqlParams } from '../db/sqlite/protocol.ts';
import {
  setMeilisearchClientForTests,
  type MeilisearchClient,
} from '../enrichment/meilisearch-client.ts';
import { writeFile } from '../fs/mirrored.ts';
import { assetsRoutes } from './assets/index.ts';
import { assetsListRoutes } from './assets-list.ts';
import { foldersRoutes } from './folders.ts';
import { searchRoutes, _resetCacheForTests, _resetBucketsCacheForTests } from './search/index.ts';
import { makeTotalCacheKey } from './search/total-cache.ts';
import { mapRoutes } from './map/index.ts';

const ownerId = '1'.repeat(24);
const emailFreeId = '2'.repeat(24);
interface OwnedDto {
  owner_id?: string | null;
  owner?: { id: string; email: string | null } | null;
}

async function fixture() {
  const library = await createTempLibrary('maple-owner-contract-');
  try {
    _resetCacheForTests();
    _resetBucketsCacheForTests();
    run(library.db, 'UPDATE folders SET slug = ? WHERE id = ?', 'owner-contract', library.folderId);
    run(
      library.db,
      'INSERT INTO users (id, email, email_key, role, created_at) VALUES (?, ?, ?, ?, ?)',
      ownerId,
      'member@maple.local',
      'member@maple.local',
      'member',
      'created',
    );
    run(
      library.db,
      'INSERT INTO users (id, role, created_at) VALUES (?, ?, ?)',
      emailFreeId,
      'member',
      'created',
    );
    const ids = [];
    for (const [index, principal] of [ownerId, emailFreeId, null].entries()) {
      const filename = `${index}.dng`;
      const id = insertAsset(library.db, {
        exif: JSON.stringify({
          captured_at: index === 1 ? '2025-01-01' : '2026-01-01',
          captured_year: index === 1 ? 2025 : 2026,
          captured_month: 1,
          gps: { lat: index + 1, lng: index + 1 },
        }),
      });
      insertLocation(library.db, { assetId: id, libraryId: library.folderId, path: '', filename });
      run(library.db, 'UPDATE assets SET owner_id = ? WHERE id = ?', principal, id);
      await writeFile(`${library.root}/${filename}`, new Uint8Array([1, 2, 3]));
      ids.push(id);
    }
    const app = new Elysia()
      .use(fakeAuth({ sub: ownerId, role: 'member' }))
      .use(assetsListRoutes)
      .use(assetsRoutes)
      .use(foldersRoutes)
      .use(searchRoutes)
      .use(mapRoutes);
    return { ...library, ids, app };
  } catch (error) {
    library[Symbol.dispose]();
    throw error;
  }
}

function expected(principal: string | null) {
  return principal === null
    ? null
    : { id: principal, email: principal === ownerId ? 'member@maple.local' : null };
}

test('detail by id, address and path and batch metadata return real owner summaries', async () => {
  using f = await fixture();
  for (const [index, principal] of [ownerId, emailFreeId, null].entries()) {
    for (const url of [
      `/api/assets/${f.ids[index]}`,
      `/api/assets/by-address?address=${encodeURIComponent(`owner-contract:${index}.dng`)}`,
      `/api/assets/by-fspath?path=${encodeURIComponent(`${f.root}/${index}.dng`)}`,
    ]) {
      const response = await f.app.handle(new Request(`http://localhost${url}`));
      expect(response.status).toBe(200);
      const dto = (await response.json()) as OwnedDto;
      expect(dto.owner_id).toBe(principal);
      expect(dto.owner).toEqual(expected(principal));
    }
  }
  const response = await f.app.handle(
    new Request('http://localhost/api/assets/batch-meta', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: f.ids }),
    }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { assets: OwnedDto[] };
  expect(
    body.assets.map((dto) => dto.owner).sort((a, b) => String(a?.id).localeCompare(String(b?.id))),
  ).toEqual([expected(ownerId), expected(emailFreeId), null]);
});

test('working-set, folder and Search pages return populated owners and email-free users', async () => {
  using f = await fixture();
  for (const url of ['/api/assets', `/api/folders/${f.folderId}/assets`, '/api/search']) {
    const response = await f.app.handle(new Request(`http://localhost${url}`));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { assets?: OwnedDto[]; results?: OwnedDto[] };
    const rows = body.assets ?? body.results!;
    expect(rows).toHaveLength(3);
    for (const principal of [ownerId, emailFreeId, null]) {
      const row = rows.find((dto) => dto.owner_id === principal);
      expect(row).toBeDefined();
      expect(row?.owner).toEqual(expected(principal));
    }
  }
});

test('owner wire alias filters Search, counts and facets across distinct users', async () => {
  using f = await fixture();
  for (const principal of [ownerId, emailFreeId]) {
    const response = await f.app.handle(
      new Request(`http://localhost/api/search?owner=${principal}`),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { total: number; results: OwnedDto[] };
    expect(body.total).toBe(1);
    expect(body.results.map((dto) => dto.owner_id)).toEqual([principal]);
    const workingSet = await f.app.handle(
      new Request(`http://localhost/api/assets?owner=${principal}`),
    );
    expect(workingSet.status).toBe(200);
    expect((await workingSet.json()).assets.map((dto: OwnedDto) => dto.owner_id)).toEqual([
      principal,
    ]);
    const facets = await f.app.handle(
      new Request(`http://localhost/api/search/facets?owner=${principal}`),
    );
    expect(facets.status).toBe(200);
    expect((await facets.json()).total).toBe(1);
    const buckets = await f.app.handle(
      new Request(`http://localhost/api/search/buckets?owner=${principal}`),
    );
    expect(buckets.status).toBe(200);
    expect((await buckets.json()).buckets).toEqual([
      { year: principal === ownerId ? 2026 : 2025, month: 1, count: 1 },
    ]);
    const map = await f.app.handle(
      new Request(`http://localhost/api/map/clusters?bbox=0,0,4,4&zoom=10&owner=${principal}`),
    );
    expect(map.status).toBe(200);
    const cells = (await map.json()).cells as { count: number; representativeAssetId: string }[];
    expect(cells).toHaveLength(1);
    expect(cells[0]?.count).toBe(1);
    expect(cells[0]?.representativeAssetId).toBe(principal === ownerId ? f.ids[0] : f.ids[1]);
  }
  const invalid = await f.app.handle(new Request('http://localhost/api/search?owner=invalid'));
  expect(invalid.status).toBe(400);
  const invalidWorkingSet = await f.app.handle(
    new Request('http://localhost/api/assets?owner=invalid'),
  );
  expect(invalidWorkingSet.status).toBe(400);
  expect(makeTotalCacheKey({ owner: ownerId })).toBe(makeTotalCacheKey({ ownerId }));
  expect(makeTotalCacheKey({ owner: ownerId })).not.toBe(makeTotalCacheKey({ owner: emailFreeId }));
});

test('account deletion removes attribution while the asset remains readable', async () => {
  using f = await fixture();
  run(f.db, 'DELETE FROM users WHERE id = ?', emailFreeId);
  const response = await f.app.handle(new Request(`http://localhost/api/assets/${f.ids[1]}`));
  expect(response.status).toBe(200);
  const dto = (await response.json()) as OwnedDto;
  expect(dto.owner_id).toBeNull();
  expect(dto.owner).toBeNull();
});

test('Trash pages retain account summaries for the asset being restored', async () => {
  using f = await fixture();
  run(
    f.db,
    'UPDATE assets SET deleted_at = ?, original_path = ? WHERE id = ?',
    '2026-01-01T00:00:00Z',
    `${f.root}/original.dng`,
    f.ids[0]!,
  );
  const response = await f.app.handle(
    new Request(`http://localhost/api/folders/${f.folderId}/trash`),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { items: OwnedDto[] };
  expect(body.items).toHaveLength(1);
  expect(body.items[0]?.owner_id).toBe(ownerId);
  expect(body.items[0]?.owner).toEqual(expected(ownerId));
});

test('batch metadata deduplicates owners into one real user query per page', async () => {
  using f = await fixture();
  const repeatedOwnerIds = Array.from({ length: 10 }, () => {
    const id = insertAsset(f.db);
    run(f.db, 'UPDATE assets SET owner_id = ? WHERE id = ?', ownerId, id);
    return id;
  });
  const db = testSqliteDb(f.db);
  const ownerReads: SqlParams[] = [];
  const observed: SqliteDb = {
    read: async <T>(sql: string, params?: SqlParams): Promise<T[]> => {
      if (sql.includes('FROM users')) ownerReads.push(params ?? []);
      return db.read<T>(sql, params);
    },
    write: (sql, params) => db.write(sql, params),
    transaction: (statements) => db.transaction(statements),
  };
  const rows = await findDetailsByIds(
    [...f.ids, ...repeatedOwnerIds].map((id) => new ObjectId(id)),
    observed,
  );
  expect(rows).toHaveLength(13);
  expect(ownerReads).toHaveLength(1);
  expect(new Set(ownerReads[0] as readonly string[])).toEqual(new Set([ownerId, emailFreeId]));
  expect(rows.filter((row) => row.owner?.id === ownerId)).toHaveLength(11);
});

test('Meilisearch result pages resolve owners from the same live catalog', async () => {
  using f = await fixture();
  for (const id of f.ids)
    run(f.db, 'UPDATE assets SET maple_id = ? WHERE id = ?', `maple-${id}`, id);
  const client: MeilisearchClient = {
    isConfigured: () => true,
    semanticConfigured: () => false,
    health: async () => true,
    ensureIndex: async () => {},
    upsert: async () => {},
    upsertOrThrow: async () => {},
    tombstone: async () => {},
    search: async () => ({ ids: f.ids.map((id) => `maple-${id}`), estimatedTotal: f.ids.length }),
  };
  setMeilisearchClientForTests(client);
  try {
    const response = await f.app.handle(
      new Request('http://localhost/api/search?placeQuery=harbour'),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { total: number; results: OwnedDto[] };
    expect(body.total).toBe(3);
    for (const principal of [ownerId, emailFreeId, null]) {
      expect(body.results.find((row) => row.owner_id === principal)?.owner).toEqual(
        expected(principal),
      );
    }
  } finally {
    setMeilisearchClientForTests(null);
  }
});
