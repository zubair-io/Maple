/**
 * #3563 — the path-keyed sidecar routes (the ones the web editor writes
 * through) must leave the same trail the id-keyed `PUT/DELETE
 * /api/assets/:id/xmp` do: `has_xmp` / `sidecar_ver` on the asset and an
 * `update` row on the change feed, so the File Provider extensions learn
 * that a mounted folder's `.xmp` changed on the server.
 *
 * Runs against SQLite (#3787): a private in-memory database per test,
 * installed as the process-wide handle, so the route's own `sqliteDb()` calls
 * reach it. Nothing skips — there is no external service to be unreachable.
 *
 * Note on the change-feed vocabulary: the cursor is allocated by the insert
 * itself now (`asset_changes.cursor` is an INTEGER PRIMARY KEY, hence a rowid
 * alias), so there is no separate allocation step to assert on — the rows
 * `listChangesSince` returns are the whole record.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { callNative } from 'maple';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { xmpPathRoutes } from './xmp.ts';
import {
  __resetChangeFolderPathCacheForTests,
  listChangesSince,
} from '../db/repos/changes.repo.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import { registerLibrary, seedRouteAsset } from '../../tests/helpers/assets-route-fixtures.ts';
import {
  createLiveTestDatabase,
  run,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';

let live: LiveTestDatabase;
let tmp: string;
let libraryId: string;
let originalMapleRoots: string | undefined;

const app = new Elysia().use(xmpPathRoutes);

beforeEach(async () => {
  live = await createLiveTestDatabase();
  // realpath: on macOS os.tmpdir() sits under the /var → /private/var symlink,
  // and the write jail realpaths before its root check.
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'maple-xmp-path-changes-')));
  // Captured inside the hook, not at module scope: bun runs every module body
  // before any hook, so a module-scope read would see whatever an earlier test
  // file left in the environment.
  originalMapleRoots = process.env.MAPLE_ROOTS;
  process.env.MAPLE_ROOTS = tmp;
  libraryId = registerLibrary(live.db, tmp);
});

afterEach(async () => {
  if (originalMapleRoots === undefined) delete process.env.MAPLE_ROOTS;
  else process.env.MAPLE_ROOTS = originalMapleRoots;
  invalidateLibraryRoots();
  // The change feed memoises folder id → root path for the life of the
  // process; each test registers its own library, so the cache is dropped with
  // the database that backed it.
  __resetChangeFolderPathCacheForTests();
  live.close();
  await rm(tmp, { recursive: true, force: true });
});

/** One indexed asset at the library root, optionally already carrying a sidecar. */
function seedIndexedAsset(filename: string, hasXmp: boolean): string {
  const assetId = seedRouteAsset(live.db, { libraryId, path: '', filename, size: 8 });
  if (hasXmp) run(live.db, `UPDATE assets SET has_xmp = 1 WHERE id = ?`, assetId);
  return assetId;
}

/** The two sidecar columns the route maintains. */
function sidecarState(assetId: string): { has_xmp: number; sidecar_ver: number } | null {
  return (live.db.query(`SELECT has_xmp, sidecar_ver FROM assets WHERE id = ?`).get(assetId) ??
    null) as { has_xmp: number; sidecar_ver: number } | null;
}

const workflowXml =
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="0.25"/></rdf:RDF></x:xmpmeta>';
async function checkpoint(xml: string): Promise<string> {
  const result = await callNative('workflowCheckpointXmp', [xml]);
  if (!result.ok) throw Error(result.error);
  return result.value;
}
function workflowRequest(rawPath: string, operation: string, body: unknown, variantId = 'primary') {
  return app.handle(
    new Request(
      `http://localhost/api/xmp/variant/${operation}?path=${encodeURIComponent(rawPath)}&variantId=${variantId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    ),
  );
}
async function commit(rawPath: string, expectedXmp: string | null, xml: string) {
  const response = await workflowRequest(rawPath, 'commit', {
    expectedXmp,
    xmp: xml,
    entry: {
      id: crypto.randomUUID(),
      createdAtMs: 1,
      action: 'adjustment',
      label: 'Exposure',
      adjustmentXmp: await checkpoint(xml),
    },
  });
  expect(response.status).toBe(200);
  return response.text();
}

describe('path-keyed XMP routes — change emission (#3563)', () => {
  it('primary snapshot and restore notify indexing, while named writes and failed commits do not', async () => {
    const rawPath = join(tmp, 'restore.dng');
    await writeFile(rawPath, Buffer.alloc(8));
    const assetId = seedIndexedAsset('restore.dng', false);
    const first = await commit(rawPath, null, workflowXml);
    const originalCheckpoint = await checkpoint(first);
    const snapshot = {
      id: crypto.randomUUID(),
      name: 'Original',
      createdAtMs: 2,
      adjustmentXmp: originalCheckpoint,
    };
    const captured = await workflowRequest(rawPath, 'snapshot', { expectedXmp: first, snapshot });
    expect(captured.status).toBe(200);
    const saved = await captured.text();
    expect(sidecarState(assetId)).toEqual({ has_xmp: 1, sidecar_ver: 2 });
    const edited = await commit(rawPath, saved, workflowXml.replace('0.25', '1.25'));
    const restored = await workflowRequest(rawPath, 'restore', {
      expectedXmp: edited,
      entry: {
        id: crypto.randomUUID(),
        createdAtMs: 4,
        action: 'snapshot-restore',
        label: 'Restore Original',
        adjustmentXmp: originalCheckpoint,
      },
    });
    expect(restored.status).toBe(200);
    const final = await restored.text();
    expect(await checkpoint(final)).toBe(originalCheckpoint);
    expect(sidecarState(assetId)).toEqual({ has_xmp: 1, sidecar_ver: 4 });
    expect(await listChangesSince(live.handle, { since: 0, limit: 10 })).toHaveLength(4);
    const stale = await workflowRequest(rawPath, 'commit', {
      expectedXmp: first,
      xmp: workflowXml,
      entry: {
        id: crypto.randomUUID(),
        createdAtMs: 5,
        action: 'adjustment',
        label: 'Stale',
        adjustmentXmp: await checkpoint(workflowXml),
      },
    });
    expect(stale.status).toBe(409);
    const id = crypto.randomUUID();
    const create = await app.handle(
      new Request(`http://localhost/api/xmp/variants?path=${encodeURIComponent(rawPath)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: 1,
          variantId: id,
          variantName: 'Alternate',
          snapshots: [],
          history: [],
        }),
      }),
    );
    expect(create.status).toBe(201);
    const read = await app.handle(
      new Request(
        `http://localhost/api/xmp/variant?path=${encodeURIComponent(rawPath)}&variantId=${id}`,
      ),
    );
    const named = await read.text();
    const branch = await workflowRequest(
      rawPath,
      'commit',
      {
        expectedXmp: named,
        xmp: named,
        entry: {
          id: crypto.randomUUID(),
          createdAtMs: 6,
          action: 'adjustment',
          label: 'Named',
          adjustmentXmp: await checkpoint(named),
        },
      },
      id,
    );
    expect(branch.status).toBe(200);
    expect(sidecarState(assetId)).toEqual({ has_xmp: 1, sidecar_ver: 4 });
    expect(await listChangesSince(live.handle, { since: 0, limit: 10 })).toHaveLength(4);
    expect(await readFile(join(tmp, 'restore.xmp'), 'utf8')).toBe(final);
    expect(await readFile(rawPath)).toEqual(Buffer.alloc(8));
  });

  it('ordinary POST returns the actual published XML with newer history retained', async () => {
    const rawPath = join(tmp, 'cached.dng');
    await writeFile(rawPath, Buffer.alloc(8));
    const assetId = seedIndexedAsset('cached.dng', false);
    const first = await commit(rawPath, null, workflowXml);
    await commit(rawPath, first, workflowXml.replace('0.25', '0.75'));
    const response = await app.handle(
      new Request(`http://localhost/api/xmp?path=${encodeURIComponent(rawPath)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/xml' },
        body: first.replace('0.25', '1.25'),
      }),
    );
    expect(response.status).toBe(200);
    const published = await response.text();
    expect(published).toBe(await readFile(join(tmp, 'cached.xmp'), 'utf8'));
    const read = await callNative('workflowReadXmp', [published]);
    if (!read.ok) throw Error(read.error);
    expect(JSON.parse(read.value).history).toHaveLength(2);
    expect(sidecarState(assetId)).toEqual({ has_xmp: 1, sidecar_ver: 3 });
    expect(await listChangesSince(live.handle, { since: 0, limit: 10 })).toHaveLength(3);
  });

  it('a selected-primary semantic commit publishes the real library flags and change feed', async () => {
    const rawPath = join(tmp, 'semantic.dng');
    await writeFile(rawPath, Buffer.alloc(8));
    const assetId = seedIndexedAsset('semantic.dng', false);
    const xml =
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="0.25"/></rdf:RDF></x:xmpmeta>';
    const captured = await checkpoint(xml);
    const res = await app.handle(
      new Request(
        `http://localhost/api/xmp/variant/commit?path=${encodeURIComponent(rawPath)}&variantId=primary`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            expectedXmp: null,
            xmp: xml,
            entry: {
              id: crypto.randomUUID(),
              createdAtMs: 1,
              action: 'adjustment',
              label: 'Exposure',
              adjustmentXmp: captured,
            },
          }),
        },
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(await readFile(join(tmp, 'semantic.xmp'), 'utf8'));
    expect(sidecarState(assetId)).toEqual({ has_xmp: 1, sidecar_ver: 1 });
    const changes = await listChangesSince(live.handle, { since: 0, limit: 10 });
    expect(changes).toHaveLength(1);
    expect(changes[0]?.asset_id?.toHexString()).toBe(assetId);
  });

  it('POST /api/xmp?path= records the edit and emits an update row', async () => {
    const rawPath = join(tmp, 'a.dng');
    await writeFile(rawPath, Buffer.alloc(8));
    const assetId = seedIndexedAsset('a.dng', false);

    const res = await app.handle(
      new Request(`http://localhost/api/xmp?path=${encodeURIComponent(rawPath)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/xml' },
        body: '<x:xmpmeta />',
      }),
    );
    expect(res.status).toBe(200);
    expect(await readFile(join(tmp, 'a.xmp'), 'utf8')).toBe('<x:xmpmeta />');

    const changes = await listChangesSince(live.handle, { since: 0, limit: 10 });
    expect(changes.length).toBe(1);
    expect(changes[0]?.asset_id?.toHexString()).toBe(assetId);
    expect(changes[0]?.kind).toBe('update');
    expect(changes[0]?.relative_path).toBe('a.dng');

    expect(sidecarState(assetId)).toEqual({ has_xmp: 1, sidecar_ver: 1 });
  });

  it('DELETE /api/xmp?path= clears has_xmp and emits an update row', async () => {
    const rawPath = join(tmp, 'b.dng');
    await writeFile(rawPath, Buffer.alloc(8));
    await writeFile(join(tmp, 'b.xmp'), '<x:xmpmeta />');
    const assetId = seedIndexedAsset('b.dng', true);

    const res = await app.handle(
      new Request(`http://localhost/api/xmp?path=${encodeURIComponent(rawPath)}`, {
        method: 'DELETE',
      }),
    );
    expect(res.status).toBe(204);

    const changes = await listChangesSince(live.handle, { since: 0, limit: 10 });
    expect(changes.length).toBe(1);
    expect(changes[0]?.asset_id?.toHexString()).toBe(assetId);

    expect(sidecarState(assetId)?.has_xmp).toBe(0);
  });

  it('POST for an unindexed path still writes and emits nothing', async () => {
    const rawPath = join(tmp, 'unindexed.dng');
    await writeFile(rawPath, Buffer.alloc(8));
    seedIndexedAsset('other.dng', false);

    const res = await app.handle(
      new Request(`http://localhost/api/xmp?path=${encodeURIComponent(rawPath)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/xml' },
        body: '<x:xmpmeta />',
      }),
    );
    expect(res.status).toBe(200);
    expect(await listChangesSince(live.handle, { since: 0, limit: 10 })).toHaveLength(0);
  });
});
