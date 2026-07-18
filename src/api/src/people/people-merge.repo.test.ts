/**
 * Tests for `people-merge.repo.ts` — the explicit multi-source merge path.
 * Extracted from `people.repo.test.ts` to keep both files within the 600-LOC
 * file-budget gate (#1303).
 */

import { describe, it, expect } from 'bun:test';
import { ObjectId } from 'mongodb';
import { setupMongoHarness } from './people-repo.test-helpers.ts';

const TEST_DB = `maple_test_people_merge_repo_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;

const h = setupMongoHarness(TEST_DB);

describe('people.repo — mergePeopleInto', () => {
  it('folds sources into the target: target survives, faces repointed, sources merged', async () => {
    if (!h.mongoReachable) return;
    const { createPerson, getPerson } = await import('./people.repo.ts');
    const { mergePeopleInto } = await import('./people-merge.repo.ts');
    const target = await createPerson('Alice');
    const srcA = await createPerson('Person 1');
    const srcB = await createPerson('Person 2');
    const bbox = { x: 0, y: 0, w: 10, h: 10 };
    await h.insertAssetWithFaces([{ bbox, person_id: target._id.toHexString(), confidence: 0.9 }]);
    await h.insertAssetWithFaces([{ bbox, person_id: srcA._id.toHexString(), confidence: 0.9 }]);
    await h.insertAssetWithFaces([{ bbox, person_id: srcB._id.toHexString(), confidence: 0.9 }]);

    const result = await mergePeopleInto(target._id, [srcA._id, srcB._id]);

    expect(result.survivor._id.toHexString()).toBe(target._id.toHexString());
    expect(result.survivor.name).toBe('Alice');
    expect(result.mergedCount).toBe(2);

    // All three faces now resolve under the target.
    const detail = await getPerson(target._id);
    expect(detail?.faces.length).toBe(3);
    // Sources are tombstoned (getPerson returns null for merged rows).
    expect(await getPerson(srcA._id)).toBeNull();
    expect(await getPerson(srcB._id)).toBeNull();
  });

  it('skips self / already-merged / missing sources (idempotent)', async () => {
    if (!h.mongoReachable) return;
    const { createPerson } = await import('./people.repo.ts');
    const { mergePeopleInto } = await import('./people-merge.repo.ts');
    const target = await createPerson('Alice');
    const src = await createPerson('Person 1');

    // target listed as a source is skipped; src merges.
    const first = await mergePeopleInto(target._id, [src._id, target._id]);
    expect(first.mergedCount).toBe(1);

    // Re-merging the now-merged src + a random missing id is a no-op.
    const second = await mergePeopleInto(target._id, [src._id, new ObjectId()]);
    expect(second.mergedCount).toBe(0);
    expect(second.survivor._id.toHexString()).toBe(target._id.toHexString());
  });

  it('clears merge suggestions pointing at a merged-away source — survivor and third parties', async () => {
    if (!h.mongoReachable) return;
    const { createPerson } = await import('./people.repo.ts');
    const { mergePeopleInto } = await import('./people-merge.repo.ts');
    const { peopleCollection } = await import('../db/client.ts');
    const peopleC = await peopleCollection();

    const target = await createPerson('Survivor');
    const src = await createPerson('Duplicate');
    const bystander = await createPerson('Bystander');
    // The banner flow: the survivor's live suggestion IS the person being
    // merged in; a third person's best match also happens to be the source.
    await peopleC.updateOne(
      { _id: target._id },
      { $set: { suggested_merge_person_id: src._id, suggested_merge_score: 0.9 } },
    );
    await peopleC.updateOne(
      { _id: bystander._id },
      { $set: { suggested_merge_person_id: src._id, suggested_merge_score: 0.8 } },
    );

    await mergePeopleInto(target._id, [src._id]);

    // Without the clear, the survivor's list badge would stay "possible
    // duplicate" until the next clustering run.
    const freshTarget = await peopleC.findOne({ _id: target._id });
    const freshBystander = await peopleC.findOne({ _id: bystander._id });
    const freshSrc = await peopleC.findOne({ _id: src._id });
    expect(freshTarget?.suggested_merge_person_id ?? null).toBeNull();
    expect(freshTarget?.suggested_merge_score ?? null).toBeNull();
    expect(freshBystander?.suggested_merge_person_id ?? null).toBeNull();
    expect(freshSrc?.suggested_merge_person_id ?? null).toBeNull();
  });

  it('throws when the target is missing or already merged', async () => {
    if (!h.mongoReachable) return;
    const { createPerson } = await import('./people.repo.ts');
    const { mergePeopleInto } = await import('./people-merge.repo.ts');
    await expect(mergePeopleInto(new ObjectId(), [new ObjectId()])).rejects.toThrow(
      /person not found/,
    );
    // Merge a source into a target, then try to use that source as a new target.
    const target = await createPerson('Alice');
    const src = await createPerson('Person 1');
    await mergePeopleInto(target._id, [src._id]);
    await expect(mergePeopleInto(src._id, [target._id])).rejects.toThrow(/person already merged/);
  });
});
