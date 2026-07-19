/**
 * Regression test for #2105 — recomputeCentroids self-heals an inconsistent
 * stored centroid.
 *
 * A person with `centroid_face_count > 0` but an empty/short `centroid`
 * vector is an anomalous stuck state: recompute treats the positive count as
 * "clean" and skips the row, while loadCentroids skips it as an invalid seed.
 * So the centroid never rebuilds and any stale merge suggestion never clears.
 *
 * Real Mongo, skip-pass when unreachable (mirrors the other people tests).
 */
import { describe, it, expect } from 'bun:test';
import { ObjectId } from 'mongodb';
import { setupMongoHarness } from './people-repo.test-helpers.ts';

const TEST_DB = `maple_test_recompute_heal_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;

const h = setupMongoHarness(TEST_DB);

const DIM = 512;
function axisEmbedding(axis: number): number[] {
  const v = new Array(DIM).fill(0) as number[];
  v[axis] = 1;
  return v;
}

describe('recomputeCentroids — self-heals an inconsistent centroid (#2105)', () => {
  it('rebuilds a valid centroid when the count is positive but the stored vector is empty', async () => {
    if (!h.mongoReachable) return;
    const { recomputeCentroids } = await import('./cluster-load.ts');
    const { createPerson } = await import('./people.repo.ts');

    const person = await createPerson('Stuck');
    const pid = person._id.toHexString();

    // Two faces WITH embeddings assigned to the person.
    await h.db.collection('assets').insertOne({
      fileinfo: [{ path: '', filename: 'a.jpg', library_id: new ObjectId(), deleted_at: null }],
      faces: [
        {
          bbox: { x: 0, y: 0, w: 1, h: 1 },
          person_id: pid,
          confidence: 0.9,
          embedding: axisEmbedding(7),
        },
        {
          bbox: { x: 1, y: 0, w: 1, h: 1 },
          person_id: pid,
          confidence: 0.9,
          embedding: axisEmbedding(7),
        },
      ],
    } as never);

    // Force the anomalous stuck state: positive count, empty centroid.
    await h.db
      .collection('people')
      .updateOne({ _id: person._id }, { $set: { centroid: [], centroid_face_count: 4548 } });

    await recomputeCentroids();

    const fresh = await h.db.collection('people').findOne({ _id: person._id });
    const centroid = fresh?.centroid as number[];
    expect(Array.isArray(centroid)).toBe(true);
    expect(centroid.length).toBe(DIM);
    expect(fresh?.centroid_face_count).toBe(2);
    // Primary axis is preserved (both embeddings sit on axis 7).
    let maxIdx = -1;
    let max = -Infinity;
    centroid.forEach((v, i) => {
      if (v > max) {
        max = v;
        maxIdx = i;
      }
    });
    expect(maxIdx).toBe(7);
  });

  it('clears to the consistent empty state when the count is positive but no embeddings remain', async () => {
    if (!h.mongoReachable) return;
    const { recomputeCentroids } = await import('./cluster-load.ts');
    const { createPerson } = await import('./people.repo.ts');

    const person = await createPerson('StuckNoEmbeddings');
    const pid = person._id.toHexString();
    // A face pointing at the person but WITHOUT an embedding.
    await h.db.collection('assets').insertOne({
      fileinfo: [{ path: '', filename: 'b.jpg', library_id: new ObjectId(), deleted_at: null }],
      faces: [{ bbox: { x: 0, y: 0, w: 1, h: 1 }, person_id: pid, confidence: 0.9, embedding: [] }],
    } as never);
    await h.db
      .collection('people')
      .updateOne({ _id: person._id }, { $set: { centroid: [], centroid_face_count: 4548 } });

    await recomputeCentroids();

    const fresh = await h.db.collection('people').findOne({ _id: person._id });
    expect(fresh).not.toBeNull();
    expect(((fresh!.centroid ?? []) as number[]).length).toBe(0);
    expect(fresh!.centroid_face_count).toBe(0);
  });

  it('leaves the valid cleared state (count 0 + empty centroid) untouched', async () => {
    if (!h.mongoReachable) return;
    const { recomputeCentroids } = await import('./cluster-load.ts');
    const { createPerson } = await import('./people.repo.ts');

    const person = await createPerson('EmptyValid');
    await h.db
      .collection('people')
      .updateOne({ _id: person._id }, { $set: { centroid: [], centroid_face_count: 0 } });

    await recomputeCentroids();

    const fresh = await h.db.collection('people').findOne({ _id: person._id });
    expect(fresh).not.toBeNull();
    expect(((fresh!.centroid ?? []) as number[]).length).toBe(0);
    expect(fresh!.centroid_face_count).toBe(0);
  });
});
