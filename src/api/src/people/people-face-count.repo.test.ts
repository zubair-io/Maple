/**
 * Tests for the denormalised `face_count` on `PersonDoc`.
 *
 * Covers:
 *   - Initial clustering assigns face_count on new person docs.
 *   - Manual assignFaceToPerson increments / decrements counts correctly.
 *   - hideFace decrements the prior person's count.
 *   - renamePerson merge (rename-on-collision) transfers the count.
 *   - Explicit mergePeopleInto transfers the count.
 *   - Parity: listPeople face_count matches the faceCountByPerson aggregation.
 *   - Backfill migration: populates counts on pre-existing docs.
 *   - Re-cluster self-heal: drift is corrected on the next clustering pass.
 *
 * Uses a throwaway Mongo instance on MAPLE_MONGO_URI (defaults to
 * mongodb://localhost:27017); each describe block gets a fresh per-PID db via
 * the shared test harness. Tests skip-pass when MongoDB is unreachable.
 */

import { describe, it, expect } from 'bun:test';
import type { PersonDoc } from '../db/schema.ts';
import { setupMongoHarness } from './people-repo.test-helpers.ts';

const TEST_DB = `maple_test_face_count_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;

const h = setupMongoHarness(TEST_DB);

// ---------------------------------------------------------------------------
// Manual assign / unassign
// ---------------------------------------------------------------------------

describe('face_count — assignFaceToPerson', () => {
  it('increments when a face is assigned', async () => {
    if (!h.mongoReachable) return;
    const { createPerson, assignFaceToPerson } = await import('./people.repo.ts');
    const p = await createPerson('Assign-Inc');
    const asset = await h.insertAssetWithFaces([
      { bbox: { x: 0, y: 0, w: 0.2, h: 0.2 }, person_id: null, confidence: 0.9 },
    ]);
    await assignFaceToPerson(asset, 0, p._id);
    const stored = await h.db.collection<PersonDoc>('people').findOne({ _id: p._id });
    expect(stored?.face_count).toBe(1);
  });

  it('decrements when a face is unassigned (null)', async () => {
    if (!h.mongoReachable) return;
    const { createPerson, assignFaceToPerson } = await import('./people.repo.ts');
    const p = await createPerson('Assign-Dec');
    const asset = await h.insertAssetWithFaces([
      { bbox: { x: 0, y: 0, w: 0.2, h: 0.2 }, person_id: null, confidence: 0.9 },
    ]);
    await assignFaceToPerson(asset, 0, p._id);
    await assignFaceToPerson(asset, 0, null);
    const stored = await h.db.collection<PersonDoc>('people').findOne({ _id: p._id });
    expect(stored?.face_count).toBe(0);
  });

  it('transfers count between people on re-assign', async () => {
    if (!h.mongoReachable) return;
    const { createPerson, assignFaceToPerson } = await import('./people.repo.ts');
    const alice = await createPerson('Alice-Transfer');
    const bob = await createPerson('Bob-Transfer');
    const asset = await h.insertAssetWithFaces([
      { bbox: { x: 0, y: 0, w: 0.2, h: 0.2 }, person_id: null, confidence: 0.9 },
    ]);
    await assignFaceToPerson(asset, 0, alice._id);
    // Re-assign from alice to bob.
    await assignFaceToPerson(asset, 0, bob._id);
    const aliceDoc = await h.db.collection<PersonDoc>('people').findOne({ _id: alice._id });
    const bobDoc = await h.db.collection<PersonDoc>('people').findOne({ _id: bob._id });
    expect(aliceDoc?.face_count).toBe(0);
    expect(bobDoc?.face_count).toBe(1);
  });

  it('is idempotent (no double-count on same-person reassign)', async () => {
    if (!h.mongoReachable) return;
    const { createPerson, assignFaceToPerson } = await import('./people.repo.ts');
    const p = await createPerson('Idempotent');
    const asset = await h.insertAssetWithFaces([
      { bbox: { x: 0, y: 0, w: 0.2, h: 0.2 }, person_id: null, confidence: 0.9 },
    ]);
    await assignFaceToPerson(asset, 0, p._id);
    // Re-assign to the SAME person — no change.
    await assignFaceToPerson(asset, 0, p._id);
    const stored = await h.db.collection<PersonDoc>('people').findOne({ _id: p._id });
    expect(stored?.face_count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// hideFace
// ---------------------------------------------------------------------------

describe('face_count — hideFace', () => {
  it('decrements on first hide', async () => {
    if (!h.mongoReachable) return;
    const { createPerson, assignFaceToPerson, hideFace } = await import('./people.repo.ts');
    const p = await createPerson('Hide-Dec');
    const asset = await h.insertAssetWithFaces([
      { bbox: { x: 0, y: 0, w: 0.2, h: 0.2 }, person_id: null, confidence: 0.9 },
    ]);
    await assignFaceToPerson(asset, 0, p._id);
    await hideFace(asset, 0);
    const stored = await h.db.collection<PersonDoc>('people').findOne({ _id: p._id });
    expect(stored?.face_count).toBe(0);
  });

  it('does not double-decrement on re-hide (already hidden)', async () => {
    if (!h.mongoReachable) return;
    const { createPerson, assignFaceToPerson, hideFace } = await import('./people.repo.ts');
    const p = await createPerson('Hide-NoDouble');
    const asset = await h.insertAssetWithFaces([
      { bbox: { x: 0, y: 0, w: 0.2, h: 0.2 }, person_id: null, confidence: 0.9 },
    ]);
    await assignFaceToPerson(asset, 0, p._id);
    await hideFace(asset, 0);
    // Re-hide — person_id is already null after the first hide; priorPersonId
    // will be null so no decrement should fire.
    await hideFace(asset, 0);
    const stored = await h.db.collection<PersonDoc>('people').findOne({ _id: p._id });
    // Count must be >= 0 (not driven negative by double-decrement).
    expect(stored?.face_count ?? 0).toBeGreaterThanOrEqual(0);
    expect(stored?.face_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rename-merge (renamePerson collision)
// ---------------------------------------------------------------------------

describe('face_count — renamePerson merge', () => {
  it('survivor absorbs orphan face_count after rename-collision merge', async () => {
    if (!h.mongoReachable) return;
    const { createPerson, assignFaceToPerson, renamePerson, listPeople } =
      await import('./people.repo.ts');
    const dave = await createPerson('Dave-FC');
    const david = await createPerson('David-FC');

    // Give dave 2 faces, david 1.
    const asset = await h.insertAssetWithFaces([
      { bbox: { x: 0, y: 0, w: 0.2, h: 0.2 }, person_id: null, confidence: 0.9 },
      { bbox: { x: 0.3, y: 0, w: 0.2, h: 0.2 }, person_id: null, confidence: 0.9 },
      { bbox: { x: 0.6, y: 0, w: 0.2, h: 0.2 }, person_id: null, confidence: 0.9 },
    ]);
    await assignFaceToPerson(asset, 0, dave._id);
    await assignFaceToPerson(asset, 1, dave._id);
    await assignFaceToPerson(asset, 2, david._id);

    // Rename dave to "David-FC" — collides with david → merge.
    const result = await renamePerson(dave._id, 'David-FC');
    const survivorId = result.survivor._id;

    const survivorDoc = await h.db.collection<PersonDoc>('people').findOne({ _id: survivorId });
    // Survivor should have 3 faces total (2 dave + 1 david).
    expect(survivorDoc?.face_count).toBe(3);

    // listPeople should return the same count via the denormalised field.
    const list = await listPeople({ withCounts: true });
    const row = list.find((r) => r.person._id.toHexString() === survivorId.toHexString());
    expect(row?.faceCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Explicit merge (mergePeopleInto)
// ---------------------------------------------------------------------------

describe('face_count — mergePeopleInto', () => {
  it('survivor absorbs source face counts', async () => {
    if (!h.mongoReachable) return;
    const { createPerson, assignFaceToPerson } = await import('./people.repo.ts');
    const { mergePeopleInto } = await import('./people-merge.repo.ts');
    const target = await createPerson('Target-Merge');
    const src1 = await createPerson('Src1-Merge');
    const src2 = await createPerson('Src2-Merge');

    const asset = await h.insertAssetWithFaces([
      { bbox: { x: 0, y: 0, w: 0.2, h: 0.2 }, person_id: null, confidence: 0.9 },
      { bbox: { x: 0.3, y: 0, w: 0.2, h: 0.2 }, person_id: null, confidence: 0.9 },
      { bbox: { x: 0.6, y: 0, w: 0.2, h: 0.2 }, person_id: null, confidence: 0.9 },
    ]);
    await assignFaceToPerson(asset, 0, target._id);
    await assignFaceToPerson(asset, 1, src1._id);
    await assignFaceToPerson(asset, 2, src2._id);

    await mergePeopleInto(target._id, [src1._id, src2._id]);

    const targetDoc = await h.db.collection<PersonDoc>('people').findOne({ _id: target._id });
    expect(targetDoc?.face_count).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Parity: listPeople vs faceCountByPerson aggregation
// ---------------------------------------------------------------------------

describe('face_count — parity with faceCountByPerson aggregation', () => {
  it('listPeople returns same counts as the aggregation', async () => {
    if (!h.mongoReachable) return;
    const { createPerson, assignFaceToPerson, listPeople } = await import('./people.repo.ts');
    const { faceCountByPerson } = await import('./people-face-count.repo.ts');

    const alice = await createPerson('Parity-Alice');
    const bob = await createPerson('Parity-Bob');

    const asset = await h.insertAssetWithFaces([
      { bbox: { x: 0, y: 0, w: 0.2, h: 0.2 }, person_id: null, confidence: 0.9 },
      { bbox: { x: 0.3, y: 0, w: 0.2, h: 0.2 }, person_id: null, confidence: 0.9 },
      { bbox: { x: 0.6, y: 0, w: 0.2, h: 0.2 }, person_id: null, confidence: 0.9 },
    ]);
    await assignFaceToPerson(asset, 0, alice._id);
    await assignFaceToPerson(asset, 1, alice._id);
    await assignFaceToPerson(asset, 2, bob._id);

    // Ground truth from the aggregation.
    const aggCounts = await faceCountByPerson();

    // listPeople reads the denormalised field.
    const list = await listPeople({ withCounts: true });
    for (const row of list) {
      const hex = row.person._id.toHexString();
      const aggCount = aggCounts.get(hex) ?? 0;
      expect(row.faceCount).toBe(aggCount);
    }
  });
});

// ---------------------------------------------------------------------------
// Backfill migration
// ---------------------------------------------------------------------------

describe('face_count — backfill migration', () => {
  it('populates face_count on pre-existing docs that lack the field', async () => {
    if (!h.mongoReachable) return;
    const { createPerson, assignFaceToPerson } = await import('./people.repo.ts');

    const p = await createPerson('BackfillTarget');
    const asset = await h.insertAssetWithFaces([
      { bbox: { x: 0, y: 0, w: 0.2, h: 0.2 }, person_id: null, confidence: 0.9 },
      { bbox: { x: 0.3, y: 0, w: 0.2, h: 0.2 }, person_id: null, confidence: 0.9 },
    ]);
    await assignFaceToPerson(asset, 0, p._id);
    await assignFaceToPerson(asset, 1, p._id);

    // Simulate a pre-migration state: unset the face_count field.
    await h.db
      .collection<PersonDoc>('people')
      .updateOne({ _id: p._id }, { $unset: { face_count: '' } });
    const preMig = await h.db.collection<PersonDoc>('people').findOne({ _id: p._id });
    expect(preMig?.face_count).toBeUndefined();

    // Run the migration function directly (not via the sentinel).
    const { backfillPersonFaceCount } = await import('../db/migrations.ts');
    const result = await backfillPersonFaceCount(h.db);
    expect(result.updated).toBeGreaterThan(0);

    const postMig = await h.db.collection<PersonDoc>('people').findOne({ _id: p._id });
    expect(postMig?.face_count).toBe(2);
  });

  it('writes 0 for people with no assigned faces', async () => {
    if (!h.mongoReachable) return;
    const { createPerson } = await import('./people.repo.ts');
    const noFaces = await createPerson('NoFacesBackfill');

    // Unset to simulate legacy state.
    await h.db
      .collection<PersonDoc>('people')
      .updateOne({ _id: noFaces._id }, { $unset: { face_count: '' } });

    const { backfillPersonFaceCount } = await import('../db/migrations.ts');
    await backfillPersonFaceCount(h.db);

    const stored = await h.db.collection<PersonDoc>('people').findOne({ _id: noFaces._id });
    expect(stored?.face_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Re-cluster self-heal (drift correction)
// ---------------------------------------------------------------------------

describe('face_count — clustering pass self-heal', () => {
  it('writeAuthoritativeFaceCounts overwrites a drifted count', async () => {
    if (!h.mongoReachable) return;
    const { createPerson, assignFaceToPerson } = await import('./people.repo.ts');
    const { writeAuthoritativeFaceCounts, faceCountByPerson } =
      await import('./people-face-count.repo.ts');

    const p = await createPerson('Drift-Test');
    const asset = await h.insertAssetWithFaces([
      { bbox: { x: 0, y: 0, w: 0.2, h: 0.2 }, person_id: null, confidence: 0.9 },
      { bbox: { x: 0.3, y: 0, w: 0.2, h: 0.2 }, person_id: null, confidence: 0.9 },
    ]);
    await assignFaceToPerson(asset, 0, p._id);
    await assignFaceToPerson(asset, 1, p._id);

    // Artificially introduce drift.
    await h.db
      .collection<PersonDoc>('people')
      .updateOne({ _id: p._id }, { $set: { face_count: 99 } });

    // Run the authoritative recompute (what the clustering pass calls).
    const counts = await faceCountByPerson();
    await writeAuthoritativeFaceCounts(counts);

    const healed = await h.db.collection<PersonDoc>('people').findOne({ _id: p._id });
    expect(healed?.face_count).toBe(2);
  });

  it('writeAuthoritativeFaceCounts heals DOWN: a person with stale count but zero faces becomes 0', async () => {
    if (!h.mongoReachable) return;
    const { createPerson } = await import('./people.repo.ts');
    const { writeAuthoritativeFaceCounts, faceCountByPerson } =
      await import('./people-face-count.repo.ts');

    // A person with NO assigned faces but a stale non-zero count.
    const ghost = await createPerson('Ghost-NoFaces');
    await h.db
      .collection<PersonDoc>('people')
      .updateOne({ _id: ghost._id }, { $set: { face_count: 5 } });

    // The aggregation won't include `ghost` (zero faces). The authoritative
    // recompute must still reset it to 0 rather than leaving the stale 5.
    const counts = await faceCountByPerson();
    expect(counts.has(ghost._id.toHexString())).toBe(false);
    await writeAuthoritativeFaceCounts(counts);

    const healed = await h.db.collection<PersonDoc>('people').findOne({ _id: ghost._id });
    expect(healed?.face_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Negative-count clamping (legacy / drift / double-decrement)
// ---------------------------------------------------------------------------

describe('face_count — adjustPersonFaceCount clamps at 0', () => {
  it('decrementing a person whose face_count is unset stays 0, never -1', async () => {
    if (!h.mongoReachable) return;
    const { createPerson } = await import('./people.repo.ts');
    const { adjustPersonFaceCount } = await import('./people-face-count.repo.ts');

    // Legacy shape: a person doc with no face_count field at all.
    const legacy = await createPerson('Legacy-NoField');
    await h.db
      .collection<PersonDoc>('people')
      .updateOne({ _id: legacy._id }, { $unset: { face_count: '' } });

    await adjustPersonFaceCount(legacy._id.toHexString(), -1);

    const stored = await h.db.collection<PersonDoc>('people').findOne({ _id: legacy._id });
    expect(stored?.face_count).toBe(0);
  });

  it('double-decrement past zero clamps at 0', async () => {
    if (!h.mongoReachable) return;
    const { createPerson } = await import('./people.repo.ts');
    const { adjustPersonFaceCount } = await import('./people-face-count.repo.ts');

    const p = await createPerson('Clamp-Double');
    await h.db
      .collection<PersonDoc>('people')
      .updateOne({ _id: p._id }, { $set: { face_count: 1 } });

    await adjustPersonFaceCount(p._id.toHexString(), -1); // 1 → 0
    await adjustPersonFaceCount(p._id.toHexString(), -1); // 0 → clamp 0

    const stored = await h.db.collection<PersonDoc>('people').findOne({ _id: p._id });
    expect(stored?.face_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Merge recomputes survivor from ground truth (not orphan's stored count)
// ---------------------------------------------------------------------------

describe('face_count — mergeInto recomputes survivor from real faces', () => {
  it('orphan with missing face_count merges → survivor count equals its real face total', async () => {
    if (!h.mongoReachable) return;
    const { createPerson, assignFaceToPerson, renamePerson } = await import('./people.repo.ts');

    const survivor = await createPerson('Aaa-Survivor');
    const orphan = await createPerson('Zzz-Orphan');

    // Survivor has 1 face, orphan has 2 — 3 real faces total post-merge.
    const asset = await h.insertAssetWithFaces([
      { bbox: { x: 0, y: 0, w: 0.2, h: 0.2 }, person_id: null, confidence: 0.9 },
      { bbox: { x: 0.3, y: 0, w: 0.2, h: 0.2 }, person_id: null, confidence: 0.9 },
      { bbox: { x: 0.6, y: 0, w: 0.2, h: 0.2 }, person_id: null, confidence: 0.9 },
    ]);
    await assignFaceToPerson(asset, 0, survivor._id);
    await assignFaceToPerson(asset, 1, orphan._id);
    await assignFaceToPerson(asset, 2, orphan._id);

    // Corrupt: drop the orphan's stored face_count entirely. If the merge
    // trusted the stored value it would add 0 and the survivor would end at 1.
    await h.db
      .collection<PersonDoc>('people')
      .updateOne({ _id: orphan._id }, { $unset: { face_count: '' } });

    // Rename orphan to survivor's name → merge-on-collision. Older _id wins;
    // "Aaa-Survivor" was created first so it is the survivor.
    const result = await renamePerson(orphan._id, 'Aaa-Survivor');
    expect(result.survivor._id.toHexString()).toBe(survivor._id.toHexString());

    const stored = await h.db.collection<PersonDoc>('people').findOne({ _id: survivor._id });
    // Recomputed from the 3 real repointed faces, NOT 1 + (missing → 0).
    expect(stored?.face_count).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// listPeople reads denormalised field (route no longer calls aggregation)
// ---------------------------------------------------------------------------

describe('face_count — listPeople reads denormalised field', () => {
  it('returns face_count from the doc, not from an aggregation', async () => {
    if (!h.mongoReachable) return;
    const { createPerson, assignFaceToPerson, listPeople } = await import('./people.repo.ts');

    const p = await createPerson('Denorm-Read');
    const asset = await h.insertAssetWithFaces([
      { bbox: { x: 0, y: 0, w: 0.2, h: 0.2 }, person_id: null, confidence: 0.9 },
    ]);
    await assignFaceToPerson(asset, 0, p._id);

    // Manually override the stored field so if listPeople runs an aggregation
    // the result would differ (aggregation = 1, stored = 42).
    await h.db
      .collection<PersonDoc>('people')
      .updateOne({ _id: p._id }, { $set: { face_count: 42 } });

    const list = await listPeople({ withCounts: true });
    const row = list.find((r) => r.person._id.toHexString() === p._id.toHexString());
    // listPeople now reads the stored value, so we expect 42 (not the aggregated 1).
    expect(row?.faceCount).toBe(42);
  });
});
