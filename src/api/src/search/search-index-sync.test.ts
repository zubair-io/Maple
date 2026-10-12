import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { seedSearchAsset } from '../db/repos/search.test-helpers.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { CHANGE_OVERLAP_MS, isoBefore } from './search-change-feed.ts';
import {
  loadAllVectors,
  rebuildText,
  RECONCILE_INTERVAL_MS,
  VectorFollower,
  type FollowerWatermarks,
} from './search-index-sync.ts';
import { RecordingEngine, storeVector } from './search.test-helpers.ts';
import { countSkippedVectors } from '../db/repos/asset-vectors.search.ts';

function watermarks(since: string): FollowerWatermarks {
  return { textWatermark: since, blobWatermark: since };
}

let live: LiveTestDatabase;
let libraryId: string;

beforeEach(async () => {
  live = await createLiveTestDatabase();
  libraryId = insertFolder(live.db, { slug: 'sync', path: '/lib' });
  seedSearchAsset(live.db, libraryId, {
    filename: 'harbour.dng',
    mapleId: 'harbour',
    description: 'a quiet harbour at dawn',
    searchBlob: 'at dawn harbour quiet sailboat',
  });
  seedSearchAsset(live.db, libraryId, {
    filename: 'kitchen.mov',
    mapleId: 'kitchen',
    description: 'bread cooling on a counter',
  });
  storeVector(live.db, 'harbour', 0, '2026-10-10T10:00:00.000Z');
  storeVector(live.db, 'kitchen', 1, '2026-10-10T10:00:01.000Z');
});

afterEach(() => live.close());

describe('boot', () => {
  test('loads every vector in one call and renders the embedder template as text', async () => {
    const engine = new RecordingEngine();
    const held = await loadAllVectors(engine, 'bge-m3');
    await rebuildText(engine, [...held]);

    expect([...held].sort()).toEqual(['harbour', 'kitchen']);
    expect(Object.fromEntries(engine.vectors)).toEqual({ harbour: 0, kitchen: 1 });
    expect(engine.texts.get('harbour')?.template).toContain('Filename: harbour.dng');
    expect(engine.texts.get('harbour')?.template).toContain(
      'Visual description: a quiet harbour at dawn',
    );
    expect(engine.texts.get('kitchen')?.template).toContain('Media type: video');
    expect(engine.texts.get('harbour')?.blob).toBe('at dawn harbour quiet sailboat');
    expect(engine.texts.get('kitchen')?.blob).toBe('');
  });

  test('skips vectors of another dimension', async () => {
    live.db.run(
      `INSERT INTO asset_vectors (maple_id, version, model, endpoint, dims, vector, embedded_at)
       VALUES ('tiny', 8, 'other', 'http://gpu', 2, x'0000803f00000000', '2026-10-10T10:00:00.000Z')`,
    );
    const engine = new RecordingEngine();
    expect([...(await loadAllVectors(engine, 'bge-m3'))].sort()).toEqual(['harbour', 'kitchen']);
  });
});

describe('the configured embedding model', () => {
  test('loads and follows only its vectors, whatever endpoint wrote them', async () => {
    seedSearchAsset(live.db, libraryId, { filename: 'lantern.dng', mapleId: 'lantern' });
    storeVector(live.db, 'lantern', 2, '2026-10-10T10:00:02.000Z', 'nomic-embed-text');
    live.db.run(`UPDATE asset_vectors SET endpoint = 'fastembed' WHERE maple_id = 'kitchen'`);
    const engine = new RecordingEngine();
    const held = await loadAllVectors(engine, 'bge-m3');
    const follower = new VectorFollower(
      engine,
      held,
      watermarks('2026-10-10T11:00:00.000Z'),
      'bge-m3',
    );

    expect([...held].sort()).toEqual(['harbour', 'kitchen']);
    expect(await countSkippedVectors('bge-m3')).toBe(1);

    storeVector(live.db, 'lantern', 5, '2026-10-10T12:00:00.000Z', 'bge-m3');
    storeVector(live.db, 'harbour', 6, '2026-10-10T12:00:01.000Z', 'nomic-embed-text');
    await follower.poll();

    expect(Object.fromEntries(engine.vectors)).toEqual({ kitchen: 1, lantern: 5 });
    expect(await countSkippedVectors('bge-m3')).toBe(1);
  });
});

describe("Ollama's implicit :latest tag", () => {
  test.each([
    ['bge-m3:latest', 'bge-m3'],
    ['bge-m3', 'bge-m3:latest'],
  ])('rows tagged %s load and follow for the setting %s', async (stored, setting) => {
    live.db.run(`UPDATE asset_vectors SET model = ?`, [stored]);
    const engine = new RecordingEngine();
    const held = await loadAllVectors(engine, setting);
    const follower = new VectorFollower(
      engine,
      held,
      watermarks('2026-10-10T11:00:00.000Z'),
      setting,
    );
    storeVector(live.db, 'harbour', 8, '2026-10-10T12:00:00.000Z', stored);
    await follower.poll();

    expect(Object.fromEntries(engine.vectors)).toEqual({ harbour: 8, kitchen: 1 });
    expect(await countSkippedVectors(setting)).toBe(0);
  });

  test('another tag of the same name is still another model', async () => {
    live.db.run(`UPDATE asset_vectors SET model = 'bge-m3:567m'`);
    expect([...(await loadAllVectors(new RecordingEngine(), 'bge-m3'))]).toEqual([]);
    expect(await countSkippedVectors('bge-m3:latest')).toBe(2);
  });
});

describe('VectorFollower', () => {
  async function bootedFollower(since: string, now: () => number = () => 0) {
    const engine = new RecordingEngine();
    const held = await loadAllVectors(engine, 'bge-m3');
    await rebuildText(engine, [...held]);
    return { engine, follower: new VectorFollower(engine, held, watermarks(since), 'bge-m3', now) };
  }

  test('picks up a re-embedded asset with its new text, once', async () => {
    const { engine, follower } = await bootedFollower('2026-10-10T10:00:05.000Z');
    live.db.run(`UPDATE asset_detail SET description = 'a busy harbour at noon'`);
    storeVector(live.db, 'harbour', 7, '2026-10-10T10:02:00.000Z');

    expect(await follower.poll()).toBe(1);
    expect(engine.vectors.get('harbour')).toBe(7);
    expect(engine.texts.get('harbour')?.template).toContain('a busy harbour at noon');
    expect(await follower.poll()).toBe(0);
    expect(follower.watermarks).toEqual({
      textWatermark: isoBefore('2026-10-10T10:02:00.000Z', CHANGE_OVERLAP_MS),
      blobWatermark: '2026-10-10T10:00:05.000Z',
    });
  });

  test('catches a row committed late with an older stamp inside the overlap', async () => {
    const { engine, follower } = await bootedFollower('2026-10-10T10:00:05.000Z');
    storeVector(live.db, 'harbour', 3, '2026-10-10T10:02:00.000Z');
    await follower.poll();
    storeVector(live.db, 'kitchen', 4, '2026-10-10T10:01:30.000Z');

    expect(await follower.poll()).toBe(1);
    expect(engine.vectors.get('kitchen')).toBe(4);
  });

  test('drops a vector whose row was deleted and adds one it never saw', async () => {
    let now = 0;
    const { engine, follower } = await bootedFollower('2026-10-10T11:00:00.000Z', () => now);
    live.db.run(`DELETE FROM asset_vectors WHERE maple_id = 'kitchen'`);
    seedSearchAsset(live.db, libraryId, { filename: 'lantern.dng', mapleId: 'lantern' });
    storeVector(live.db, 'lantern', 9, '2026-10-10T09:00:00.000Z');
    live.db.run(`DELETE FROM asset_vectors WHERE maple_id = 'harbour'`);

    expect(await follower.poll()).toBe(3);
    expect([...engine.vectors.keys()]).toEqual(['lantern']);
    expect([...engine.texts.keys()]).toEqual(['lantern']);

    storeVector(live.db, 'harbour', 0, '2026-10-10T09:00:00.000Z');
    expect(await follower.poll()).toBe(0);
    now += RECONCILE_INTERVAL_MS;
    expect(await follower.poll()).toBe(1);
    expect(engine.vectors.get('harbour')).toBe(0);
  });

  test('a search_blob rewrite reaches the text on the next poll and leaves the vector alone', async () => {
    const { engine, follower } = await bootedFollower('2026-10-10T10:00:05.000Z');
    const vectorBefore = storedVectorRow('harbour');
    const writesBefore = engine.vectorWrites;
    live.db.run(
      `UPDATE asset_search SET search_blob = 'athlete dawn harbour lacrosse'
        WHERE asset_id = (SELECT id FROM assets WHERE maple_id = 'harbour')`,
    );

    expect(await follower.poll()).toBe(1);
    expect(engine.texts.get('harbour')?.blob).toBe('athlete dawn harbour lacrosse');
    expect(engine.texts.get('harbour')?.template).toContain('a quiet harbour at dawn');
    expect(engine.vectorWrites).toBe(writesBefore);
    expect(storedVectorRow('harbour')).toEqual(vectorBefore);
    expect(await follower.poll()).toBe(0);
  });

  test('a blob written for an asset with no vector waits for the vector', async () => {
    const { engine, follower } = await bootedFollower('2026-10-10T10:00:05.000Z');
    seedSearchAsset(live.db, libraryId, {
      filename: 'lantern.dng',
      mapleId: 'lantern',
      searchBlob: 'lanterns paper',
    });

    expect(await follower.poll()).toBe(0);
    storeVector(live.db, 'lantern', 4, '2026-10-10T10:03:00.000Z');
    expect(await follower.poll()).toBe(1);
    expect(engine.texts.get('lantern')?.blob).toBe('lanterns paper');
  });

  test('an emptied blob clears the indexed tags', async () => {
    const { engine, follower } = await bootedFollower('2026-10-10T10:00:05.000Z');
    live.db.run(
      `DELETE FROM asset_search WHERE asset_id = (SELECT id FROM assets WHERE maple_id = 'harbour')`,
    );

    expect(await follower.poll()).toBe(1);
    expect(engine.texts.get('harbour')?.blob).toBe('');
  });
});

function storedVectorRow(mapleId: string): unknown {
  return live.db
    .query(`SELECT vector, embedded_at FROM asset_vectors WHERE maple_id = ?`)
    .get(mapleId);
}
