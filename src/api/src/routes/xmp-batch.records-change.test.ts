/**
 * #4468 — `POST /api/xmp/batch` must leave the same trail as the single-file
 * path-keyed saves (#3563): one `update` row on the change feed per sidecar
 * whose bytes actually changed, which the File Provider extensions then read
 * back through `GET /api/changes`. Real sidecar files in a temp library, a
 * private SQLite database per test.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { xmpBatchRoutes } from './xmp-batch.ts';
import { changesRoutes } from './changes.ts';
import { __resetChangeFolderPathCacheForTests } from '../db/repos/changes.repo.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import { parseXmpMetadata } from '../xmp/metadata-parser.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';
import { registerLibrary, seedRouteAsset } from '../../tests/helpers/assets-route-fixtures.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';

const SLUG = 'xmp-batch-changes';

let live: LiveTestDatabase;
let tmp: string;
let libraryId: string;
let originalMapleRoots: string | undefined;

const app = new Elysia().use(fakeAuth()).use(xmpBatchRoutes).use(changesRoutes);

beforeEach(async () => {
  live = await createLiveTestDatabase();
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'maple-xmp-batch-changes-')));
  originalMapleRoots = process.env.MAPLE_ROOTS;
  process.env.MAPLE_ROOTS = tmp;
  libraryId = registerLibrary(live.db, tmp, SLUG);
});

afterEach(async () => {
  if (originalMapleRoots === undefined) delete process.env.MAPLE_ROOTS;
  else process.env.MAPLE_ROOTS = originalMapleRoots;
  invalidateLibraryRoots();
  __resetChangeFolderPathCacheForTests();
  live.close();
  await rm(tmp, { recursive: true, force: true });
});

async function seedPhoto(filename: string): Promise<string> {
  await writeFile(join(tmp, filename), Buffer.alloc(8));
  return seedRouteAsset(live.db, { libraryId, path: '', filename, size: 8 });
}

async function batch(entries: Array<{ address: string; metadata: Record<string, unknown> }>) {
  return app.handle(
    new Request('http://localhost/api/xmp/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries }),
    }),
  );
}

interface FeedRow {
  cursor: number;
  asset_id: string | null;
  kind: string;
  relative_path: string | null;
}

async function feedSince(since: number): Promise<FeedRow[]> {
  const res = await app.handle(new Request(`http://localhost/api/changes?since=${since}`));
  expect(res.status).toBe(200);
  return ((await res.json()) as { changes: FeedRow[] }).changes;
}

function sidecarVer(assetId: string): number {
  const row = live.db.query(`SELECT sidecar_ver FROM assets WHERE id = ?`).get(assetId) as {
    sidecar_ver: number;
  };
  return row.sidecar_ver;
}

describe('POST /api/xmp/batch — change emission (#4468)', () => {
  it('records exactly one update row per changed sidecar, which GET /api/changes returns', async () => {
    const ids = {
      'a.dng': await seedPhoto('a.dng'),
      'b.dng': await seedPhoto('b.dng'),
      'c.dng': await seedPhoto('c.dng'),
    };

    const res = await batch([
      { address: `${SLUG}:a.dng`, metadata: { city: 'Paris' } },
      { address: `${SLUG}:b.dng`, metadata: { title: 'Bridge', rating: 4 } },
      { address: `${SLUG}:c.dng`, metadata: { city: 'Rome' } },
      { address: `${SLUG}:a.dng`, metadata: { rating: 2 } },
      { address: 'no-such-slug:z.dng', metadata: { city: 'Nowhere' } },
    ]);
    expect(res.status).toBe(207);

    const rows = await feedSince(0);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.kind === 'update')).toBe(true);
    expect(Object.fromEntries(rows.map((row) => [row.relative_path, row.asset_id]))).toEqual(ids);
    for (const assetId of Object.values(ids)) expect(sidecarVer(assetId)).toBe(1);
    expect(parseXmpMetadata(await readFile(join(tmp, 'a.xmp'), 'utf8'))).toMatchObject({
      city: 'Paris',
      rating: 2,
    });
  });

  it('records no row and leaves the file alone when the batch changes nothing', async () => {
    const assetId = await seedPhoto('same.dng');
    const sidecar = join(tmp, 'same.xmp');
    expect(
      (await batch([{ address: `${SLUG}:same.dng`, metadata: { city: 'Oslo' } }])).status,
    ).toBe(200);
    const [first] = await feedSince(0);
    expect(first?.asset_id).toBe(assetId);
    const before = { xml: await readFile(sidecar, 'utf8'), mtimeMs: (await stat(sidecar)).mtimeMs };

    await Bun.sleep(20);
    expect(
      (await batch([{ address: `${SLUG}:same.dng`, metadata: { city: 'Oslo' } }])).status,
    ).toBe(200);
    expect(await feedSince(first!.cursor)).toHaveLength(0);
    expect(sidecarVer(assetId)).toBe(1);
    expect({
      xml: await readFile(sidecar, 'utf8'),
      mtimeMs: (await stat(sidecar)).mtimeMs,
    }).toEqual(before);

    expect(
      (await batch([{ address: `${SLUG}:same.dng`, metadata: { city: 'Bergen' } }])).status,
    ).toBe(200);
    const next = await feedSince(first!.cursor);
    expect(next.map((row) => row.asset_id)).toEqual([assetId]);
    expect(sidecarVer(assetId)).toBe(2);
  });
});
