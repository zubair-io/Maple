/**
 * A clustering pass end to end against SQLite (#3749): faces in, people and
 * assignments out.
 *
 * `people.cluster-load.parity.test.ts` proves the compute half agrees with
 * MongoDB. This file is about what the write half leaves in the database.
 */

import { describe, expect, test } from 'bun:test';
import { createTestDatabase } from '../test-sqlite.test-helpers.ts';
import type { SqliteDb } from './db-handle.ts';
import { MEILI_STAGE } from './assets.stage-rearm.ts';
import { insertStageState } from './assets.test-helpers.ts';
import { backfillCoverAssets, runOnlineClustering } from './people.clustering-job.ts';
import { faceCountByPerson } from './people.face-count.ts';
import { stageRow } from './stage-runtime.test-helpers.ts';
import {
  insertFace,
  insertLibrary,
  insertLiveAsset,
  insertPerson,
  nearAxis,
  testDb,
} from './people.test-helpers.ts';

interface PersonRowShape {
  id: string;
  name: string;
  centroid_face_count: number | null;
  cover_asset_id: string | null;
  cover_bbox_x: number | null;
}

function people(handle: Awaited<ReturnType<typeof createTestDatabase>>): PersonRowShape[] {
  return handle.db
    .query(
      'SELECT id, name, centroid_face_count, cover_asset_id, cover_bbox_x FROM people ORDER BY name',
    )
    .all() as PersonRowShape[];
}

describe('runOnlineClustering', () => {
  test('a cold library gets one person per distinct face, auto-named from one', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    const first = insertLiveAsset(db, library);
    const second = insertLiveAsset(db, library);
    insertFace(db, { assetId: first, faceIndex: 0, embedding: nearAxis(0, 0.05) });
    insertFace(db, { assetId: first, faceIndex: 1, embedding: nearAxis(80, 0.05) });
    insertFace(db, { assetId: second, faceIndex: 0, embedding: nearAxis(0, 0.1) });

    const result = await runOnlineClustering({}, testDb(db));

    expect(result).toEqual({ assigned: 3, newPeople: 2, scanned: 3 });
    expect(people(handle).map((row) => row.name)).toEqual(['Person 1', 'Person 2']);
  });

  test('is idempotent — a second pass finds nothing unassigned', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    insertFace(db, { assetId: insertLiveAsset(db, library), embedding: nearAxis(0, 0.05) });
    const dbHandle = testDb(db);

    const first = await runOnlineClustering({}, dbHandle);
    const second = await runOnlineClustering({}, dbHandle);

    expect(first.assigned).toBe(1);
    expect(second).toEqual({ assigned: 0, newPeople: 0, scanned: 0 });
    expect(people(handle)).toHaveLength(1);
  });

  test('an existing person absorbs a matching face and keeps their name', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    const ada = insertPerson(db, {
      name: 'Ada',
      centroid: nearAxis(0, 0.02),
      centroidFaceCount: 4,
    });
    const asset = insertLiveAsset(db, library);
    insertFace(db, { assetId: asset, embedding: nearAxis(0, 0.08) });

    const result = await runOnlineClustering({}, testDb(db));

    expect(result).toEqual({ assigned: 1, newPeople: 0, scanned: 1 });
    expect(db.query('SELECT person_id FROM faces WHERE asset_id = ?').get(asset)).toEqual({
      person_id: ada,
    });
    // The centroid was refreshed to account for the face it just took on.
    expect(db.query('SELECT centroid_face_count AS n FROM people WHERE id = ?').get(ada)).toEqual({
      n: 5,
    });
  });

  test('new auto-names extend the existing run rather than colliding', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    insertPerson(db, { name: 'Person 7', centroid: nearAxis(0, 0.02), centroidFaceCount: 1 });
    insertFace(db, { assetId: insertLiveAsset(db, library), embedding: nearAxis(90, 0.05) });

    await runOnlineClustering({}, testDb(db));

    expect(
      people(handle)
        .map((row) => row.name)
        .sort(),
    ).toEqual(['Person 7', 'Person 8']);
  });

  test('a new person is covered by the face that opened their cluster', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    const asset = insertLiveAsset(db, library);
    insertFace(db, {
      assetId: asset,
      embedding: nearAxis(0, 0.05),
      bbox: { x: 0.25, y: 0.35, w: 0.1, h: 0.2 },
    });

    await runOnlineClustering({}, testDb(db));

    const created = people(handle)[0]!;
    expect(created.cover_asset_id).toBe(asset);
    expect(created.cover_bbox_x).toBe(0.25);
  });

  test('the face counts that come out are derived from the rows just written', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    for (const jitter of [0.03, 0.06, 0.09]) {
      insertFace(db, { assetId: insertLiveAsset(db, library), embedding: nearAxis(0, jitter) });
    }
    const dbHandle = testDb(db);

    await runOnlineClustering({}, dbHandle);
    const counts = await faceCountByPerson(undefined, dbHandle);

    // The Mongo pass ends by recounting every person and rewriting a stored
    // counter, precisely to heal drift. Nothing does that here.
    expect([...counts.values()]).toEqual([3]);
  });

  test('a new person and the face that opened it commit together', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    insertFace(db, { assetId: insertLiveAsset(db, library), embedding: nearAxis(0, 0.05) });
    insertFace(db, { assetId: insertLiveAsset(db, library), embedding: nearAxis(80, 0.05) });

    const inner = testDb(db);
    const batches: string[][] = [];
    const recording: SqliteDb = {
      read: (sql, params) => inner.read(sql, params),
      write: (sql, params) => inner.write(sql, params),
      transaction: (statements) => {
        batches.push(statements.map((statement) => statement.sql));
        return inner.transaction(statements);
      },
    };

    await runOnlineClustering({}, recording);

    // A person row alone in its transaction is a person that exists for a
    // while with a centroid, a cover crop and no faces — and if the pass dies
    // there, permanently. Every insert must share a transaction with the
    // assignment that justifies it.
    const inserts = batches.filter((batch) =>
      batch.some((sql) => sql.includes('INSERT INTO people')),
    );
    expect(inserts.length).toBeGreaterThan(0);
    for (const batch of inserts) {
      expect(batch.some((sql) => sql.includes('UPDATE faces SET person_id'))).toBe(true);
    }
  });

  test('a hidden face is neither clustered nor given a person', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    const asset = insertLiveAsset(db, library);
    insertFace(db, { assetId: asset, embedding: nearAxis(0, 0.05), hidden: true });

    const result = await runOnlineClustering({}, testDb(db));

    expect(result.scanned).toBe(0);
    expect(db.query('SELECT person_id FROM faces WHERE asset_id = ?').get(asset)).toEqual({
      person_id: null,
    });
  });

  test('persists a merge suggestion between two near-identical people', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    const ada = insertPerson(db, {
      name: 'Ada',
      centroid: nearAxis(0, 0.02),
      centroidFaceCount: 3,
    });
    const twin = insertPerson(db, {
      name: 'Twin',
      centroid: nearAxis(0, 0.03),
      centroidFaceCount: 2,
    });
    insertFace(db, { assetId: insertLiveAsset(db, library), embedding: nearAxis(0, 0.04) });

    await runOnlineClustering({}, testDb(db));

    const row = db
      .query(
        'SELECT suggested_merge_person_id AS head, suggested_merges AS ranked FROM people WHERE id = ?',
      )
      .get(ada) as { head: string | null; ranked: string | null };
    expect(row.head).toBe(twin);
    expect(JSON.parse(row.ranked!)).toEqual([{ person_id: twin, score: expect.any(Number) }]);
  });

  test('clears a suggestion that no longer qualifies', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    const stranger = insertPerson(db, {
      name: 'Stranger',
      centroid: nearAxis(200, 0.02),
      centroidFaceCount: 1,
    });
    const ada = insertPerson(db, {
      name: 'Ada',
      centroid: nearAxis(0, 0.02),
      centroidFaceCount: 3,
      suggestedMergeHead: { person_id: stranger, score: 0.99 },
      suggestedMerges: [{ person_id: stranger, score: 0.99 }],
    });
    insertFace(db, { assetId: insertLiveAsset(db, library), embedding: nearAxis(0, 0.04) });

    await runOnlineClustering({}, testDb(db));

    // Everyone the pass considered is written, not just those with a match, so
    // a stale suggestion heals on the very next run.
    expect(
      db
        .query(
          'SELECT suggested_merge_person_id AS head, suggested_merges AS ranked FROM people WHERE id = ?',
        )
        .get(ada),
    ).toEqual({ head: null, ranked: null });
  });

  test('re-queues the assets it assigned for the search index', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    const assigned = insertLiveAsset(db, library);
    const untouched = insertLiveAsset(db, library);
    insertFace(db, { assetId: assigned, embedding: nearAxis(0, 0.05) });
    // Both look already-indexed, so only a genuine re-arm shows as a change.
    insertStageState(db, assigned, MEILI_STAGE, { version: 6 });
    insertStageState(db, untouched, MEILI_STAGE, { version: 6 });

    await runOnlineClustering({}, testDb(db));

    // Fire-and-forget: a search-index hiccup must not fail the pass.
    await waitFor(() => stageRow(db, assigned, MEILI_STAGE)?.version === 0);
    expect(stageRow(db, assigned, MEILI_STAGE)?.version).toBe(0);
    // An asset the pass did not touch keeps its place in the queue — re-arming
    // every asset of every touched person would re-queue an entire library.
    expect(stageRow(db, untouched, MEILI_STAGE)?.version).toBe(6);
  });
});

/** Poll a condition for up to half a second. */
async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('backfillCoverAssets', () => {
  test('gives an uncovered person their highest-confidence face', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    const ada = insertPerson(db, { name: 'Ada' });
    const weak = insertLiveAsset(db, library);
    const strong = insertLiveAsset(db, library);
    insertFace(db, { assetId: weak, personId: ada, confidence: 0.4 });
    insertFace(db, {
      assetId: strong,
      personId: ada,
      confidence: 0.99,
      bbox: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 },
    });

    await backfillCoverAssets(testDb(db));

    const covered = people(handle)[0]!;
    expect(covered.cover_asset_id).toBe(strong);
    expect(covered.cover_bbox_x).toBe(0.5);
  });

  test('heals a row that has a cover asset but no crop', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    const asset = insertLiveAsset(db, library);
    const ada = insertPerson(db, { name: 'Ada', coverAssetId: asset });
    insertFace(db, { assetId: asset, personId: ada, bbox: { x: 0.2, y: 0, w: 1, h: 1 } });

    await backfillCoverAssets(testDb(db));

    // Rows written before the cover crop landed carry an asset id and no bbox.
    expect(people(handle)[0]!.cover_bbox_x).toBe(0.2);
  });

  test('never picks a hidden face as a cover', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    const ada = insertPerson(db, { name: 'Ada' });
    const visible = insertLiveAsset(db, library);
    const hidden = insertLiveAsset(db, library);
    insertFace(db, { assetId: visible, personId: ada, confidence: 0.3 });
    insertFace(db, { assetId: hidden, personId: ada, confidence: 0.99, hidden: true });

    await backfillCoverAssets(testDb(db));

    expect(people(handle)[0]!.cover_asset_id).toBe(visible);
  });

  test('is a no-op when everybody already has a cover', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    const asset = insertLiveAsset(db, library);
    const ada = insertPerson(db, { name: 'Ada', coverAssetId: asset });
    db.run(
      'UPDATE people SET cover_bbox_x = 0, cover_bbox_y = 0, cover_bbox_w = 1, cover_bbox_h = 1 WHERE id = ?',
      [ada],
    );
    const before = handle.db.query('SELECT updated_at FROM people WHERE id = ?').get(ada);

    await backfillCoverAssets(testDb(db));

    expect(handle.db.query('SELECT updated_at FROM people WHERE id = ?').get(ada)).toEqual(before!);
  });
});
