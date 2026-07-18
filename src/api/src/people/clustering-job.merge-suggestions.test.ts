/**
 * Merge-suggestion tests for the clustering job — real Mongo, skip-pass when
 * unreachable. Split out from `clustering-job.test.ts` to keep both files
 * within the 600-LOC file-budget gate, mirroring the `people-merge.repo.ts` /
 * `people-cover.repo.ts` split already used elsewhere in this package.
 */

import { describe, it, expect } from 'bun:test';
import { setupMongoHarness } from './people-repo.test-helpers.ts';

const TEST_DB = `maple_test_clustering_merge_suggestions_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;

const h = setupMongoHarness(TEST_DB);

describe('prepareClusteringPass — merge suggestions', () => {
  it('suggests the best-matching other live, non-hidden person above threshold', async () => {
    if (!h.mongoReachable) return;
    const { createPerson } = await import('./people.repo.ts');
    const { prepareClusteringPass, EMBEDDING_DIM } = await import('./cluster-load.ts');
    const { peopleCollection } = await import('../db/client.ts');
    const peopleC = await peopleCollection();

    const a = await createPerson('Person A');
    const b = await createPerson('Person B');
    const centroid = new Array(EMBEDDING_DIM).fill(0);
    centroid[0] = 1;
    await peopleC.updateOne({ _id: a._id }, { $set: { centroid, centroid_face_count: 5 } });
    await peopleC.updateOne({ _id: b._id }, { $set: { centroid, centroid_face_count: 5 } });

    const pass = await prepareClusteringPass();
    const forA = pass.mergeSuggestions.find((s) => s.personIdHex === a._id.toHexString());
    expect(forA?.suggestedPersonIdHex).toBe(b._id.toHexString());
    expect(forA?.score).toBeCloseTo(1, 5);
  });

  it('excludes a hidden person from suggestions', async () => {
    if (!h.mongoReachable) return;
    const { createPerson } = await import('./people.repo.ts');
    const { prepareClusteringPass, EMBEDDING_DIM } = await import('./cluster-load.ts');
    const { peopleCollection } = await import('../db/client.ts');
    const peopleC = await peopleCollection();

    const a = await createPerson('Person C');
    const hiddenB = await createPerson('Person D');
    const centroid = new Array(EMBEDDING_DIM).fill(0);
    centroid[0] = 1;
    await peopleC.updateOne({ _id: a._id }, { $set: { centroid, centroid_face_count: 5 } });
    await peopleC.updateOne(
      { _id: hiddenB._id },
      { $set: { centroid, centroid_face_count: 5, hidden: true } },
    );

    const pass = await prepareClusteringPass();
    const forA = pass.mergeSuggestions.find((s) => s.personIdHex === a._id.toHexString());
    expect(forA).toBeUndefined();
  });

  it('excludes a dismissed pair', async () => {
    if (!h.mongoReachable) return;
    const { createPerson } = await import('./people.repo.ts');
    const { prepareClusteringPass, EMBEDDING_DIM } = await import('./cluster-load.ts');
    const { peopleCollection, personMergeDismissalsCollection } = await import('../db/client.ts');
    const { sortedPairKey } = await import('./people-merge-suggestions.ts');
    const peopleC = await peopleCollection();

    const a = await createPerson('Person E');
    const b = await createPerson('Person F');
    const centroid = new Array(EMBEDDING_DIM).fill(0);
    centroid[0] = 1;
    await peopleC.updateOne({ _id: a._id }, { $set: { centroid, centroid_face_count: 5 } });
    await peopleC.updateOne({ _id: b._id }, { $set: { centroid, centroid_face_count: 5 } });

    const dismissalsC = await personMergeDismissalsCollection();
    await dismissalsC.insertOne({
      pair: sortedPairKey(a._id.toHexString(), b._id.toHexString()),
      created_at: new Date().toISOString(),
    });

    const pass = await prepareClusteringPass();
    const forA = pass.mergeSuggestions.find((s) => s.personIdHex === a._id.toHexString());
    expect(forA).toBeUndefined();
  });
});

describe('runOnlineClustering — merge suggestion persistence', () => {
  it('writes suggested_merge_person_id/score for a qualifying pair, and self-heals to null once the match is hidden', async () => {
    if (!h.mongoReachable) return;
    const { createPerson } = await import('./people.repo.ts');
    const { peopleCollection } = await import('../db/client.ts');
    const { runOnlineClustering, EMBEDDING_DIM } = await import('./clustering-job.ts');
    const peopleC = await peopleCollection();

    const a = await createPerson('Person G');
    const b = await createPerson('Person H');
    const c = await createPerson('Person I');
    const matching = new Array(EMBEDDING_DIM).fill(0);
    matching[0] = 1;
    const distinct = new Array(EMBEDDING_DIM).fill(0);
    distinct[1] = 1;
    await peopleC.updateOne(
      { _id: a._id },
      { $set: { centroid: matching, centroid_face_count: 5 } },
    );
    await peopleC.updateOne(
      { _id: b._id },
      { $set: { centroid: matching, centroid_face_count: 5 } },
    );
    await peopleC.updateOne(
      { _id: c._id },
      { $set: { centroid: distinct, centroid_face_count: 5 } },
    );

    // No unassigned faces this run — purely exercises the merge-suggestion
    // write side against the manually-seeded centroids above. (Two people
    // scoring above the merge-suggestion threshold, while still being
    // separate people, is only reachable in practice via centroid drift
    // across many faces — setting centroids directly is the deterministic
    // way to exercise the write-side wiring in isolation; Task 3 already
    // covers the compute side the same way.)
    await runOnlineClustering();

    const freshA = await peopleC.findOne({ _id: a._id });
    const freshB = await peopleC.findOne({ _id: b._id });
    const freshC = await peopleC.findOne({ _id: c._id });
    expect(freshA?.suggested_merge_person_id?.toHexString()).toBe(b._id.toHexString());
    expect(freshA?.suggested_merge_score).toBeCloseTo(1, 5);
    expect(freshB?.suggested_merge_person_id?.toHexString()).toBe(a._id.toHexString());
    expect(freshC?.suggested_merge_person_id ?? null).toBeNull();

    // Hide B, re-run: A's suggestion self-heals to null (its only
    // qualifying match is now excluded from the pass).
    await peopleC.updateOne({ _id: b._id }, { $set: { hidden: true } });
    await runOnlineClustering();
    const afterHide = await peopleC.findOne({ _id: a._id });
    expect(afterHide?.suggested_merge_person_id ?? null).toBeNull();
    expect(afterHide?.suggested_merge_score ?? null).toBeNull();
  });

  it('drops a suggestion whose pair was dismissed after the prepare-time snapshot', async () => {
    if (!h.mongoReachable) return;
    const { createPerson } = await import('./people.repo.ts');
    const { peopleCollection, personMergeDismissalsCollection } = await import('../db/client.ts');
    const { _internals } = await import('./clustering-job.ts');
    const { sortedPairKey } = await import('./people-merge-suggestions.ts');
    const peopleC = await peopleCollection();

    const a = await createPerson('Person J');
    const b = await createPerson('Person K');
    const aHex = a._id.toHexString();
    const bHex = b._id.toHexString();

    // Simulate a "Not the same person" dismiss landing while the clustering
    // run is in flight: the compute pass produced a suggestion for the pair
    // (its dismissal snapshot predates the dismiss), but by persist time the
    // dismissal exists — the persist-side re-load must drop it, clearing
    // both sides to null instead of resurrecting the suggestion.
    const dismissalsC = await personMergeDismissalsCollection();
    await dismissalsC.insertOne({
      pair: sortedPairKey(aHex, bHex),
      created_at: new Date().toISOString(),
    });
    await _internals.persistMergeSuggestions(
      [aHex, bHex],
      [
        { personIdHex: aHex, suggestedPersonIdHex: bHex, score: 0.9 },
        { personIdHex: bHex, suggestedPersonIdHex: aHex, score: 0.9 },
      ],
    );

    const freshA = await peopleC.findOne({ _id: a._id });
    const freshB = await peopleC.findOne({ _id: b._id });
    expect(freshA?.suggested_merge_person_id ?? null).toBeNull();
    expect(freshB?.suggested_merge_person_id ?? null).toBeNull();
  });
});
