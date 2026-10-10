import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { seedSearchAsset } from '../db/repos/search.test-helpers.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import {
  CHANGE_OVERLAP_MS,
  isoBefore,
  loadAllVectors,
  rebuildText,
  RECONCILE_INTERVAL_MS,
  VectorFollower,
} from './search-index-sync.ts';
import { RecordingEngine, storeVector } from './search.test-helpers.ts';

let live: LiveTestDatabase;
let libraryId: string;

beforeEach(async () => {
  live = await createLiveTestDatabase();
  libraryId = insertFolder(live.db, { slug: 'sync', path: '/lib' });
  seedSearchAsset(live.db, libraryId, {
    filename: 'harbour.dng',
    mapleId: 'harbour',
    description: 'a quiet harbour at dawn',
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
    const held = await loadAllVectors(engine);
    await rebuildText(engine, [...held]);

    expect([...held].sort()).toEqual(['harbour', 'kitchen']);
    expect(Object.fromEntries(engine.vectors)).toEqual({ harbour: 0, kitchen: 1 });
    expect(engine.texts.get('harbour')).toContain('Filename: harbour.dng');
    expect(engine.texts.get('harbour')).toContain('Visual description: a quiet harbour at dawn');
    expect(engine.texts.get('kitchen')).toContain('Media type: video');
  });

  test('skips vectors of another dimension', async () => {
    live.db.run(
      `INSERT INTO asset_vectors (maple_id, version, model, endpoint, dims, vector, embedded_at)
       VALUES ('tiny', 8, 'other', 'http://gpu', 2, x'0000803f00000000', '2026-10-10T10:00:00.000Z')`,
    );
    const engine = new RecordingEngine();
    expect([...(await loadAllVectors(engine))].sort()).toEqual(['harbour', 'kitchen']);
  });
});

describe('VectorFollower', () => {
  async function bootedFollower(since: string, now: () => number = () => 0) {
    const engine = new RecordingEngine();
    const held = await loadAllVectors(engine);
    await rebuildText(engine, [...held]);
    return { engine, follower: new VectorFollower(engine, held, since, now) };
  }

  test('picks up a re-embedded asset with its new text, once', async () => {
    const { engine, follower } = await bootedFollower('2026-10-10T10:00:05.000Z');
    live.db.run(`UPDATE asset_detail SET description = 'a busy harbour at noon'`);
    storeVector(live.db, 'harbour', 7, '2026-10-10T10:02:00.000Z');

    expect(await follower.poll()).toBe(1);
    expect(engine.vectors.get('harbour')).toBe(7);
    expect(engine.texts.get('harbour')).toContain('a busy harbour at noon');
    expect(await follower.poll()).toBe(0);
    expect(follower.textWatermark).toBe(isoBefore('2026-10-10T10:02:00.000Z', CHANGE_OVERLAP_MS));
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
});
