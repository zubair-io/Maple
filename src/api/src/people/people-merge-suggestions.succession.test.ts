/**
 * The user-facing behaviour behind the ranked candidate list (#2141): after
 * dismissing (or merging away) the suggestion on screen, the banner must
 * immediately offer the NEXT-best candidate instead of going empty until the
 * next clustering run.
 *
 * Exercises the read path (`loadSuggestedMergeInfo`, what the detail banner
 * renders) together with the dismiss write path, against real Mongo.
 */
import { describe, it, expect } from 'bun:test';
import { setupMongoHarness } from './people-repo.test-helpers.ts';

const TEST_DB = `maple_test_people_merge_succession_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;

const h = setupMongoHarness(TEST_DB);

describe('merge-suggestion succession', () => {
  it('advances to the next-best candidate after the current one is dismissed', async () => {
    if (!h.mongoReachable) return;
    const { createPerson } = await import('./people.repo.ts');
    const { peopleCollection } = await import('../db/client.ts');
    const { loadSuggestedMergeInfo } = await import('./people-merge-suggestion-info.repo.ts');
    const { dismissMergeSuggestion } = await import('./people-merge-suggestions.repo.ts');
    const peopleC = await peopleCollection();

    const subject = await createPerson('Subject');
    const best = await createPerson('Best Match');
    const second = await createPerson('Second Match');

    await peopleC.updateOne(
      { _id: subject._id },
      {
        $set: {
          suggested_merge_person_id: best._id,
          suggested_merge_score: 0.93,
          suggested_merges: [
            { person_id: best._id, score: 0.93 },
            { person_id: second._id, score: 0.71 },
          ],
        },
      },
    );

    const before = await loadSuggestedMergeInfo(
      peopleC,
      (await peopleC.findOne({
        _id: subject._id,
      }))!,
    );
    expect(before?.name).toBe('Best Match');

    expect(await dismissMergeSuggestion(subject._id, best._id)).toBe('dismissed');

    // The banner now offers the runner-up — no clustering run in between.
    const after = await loadSuggestedMergeInfo(
      peopleC,
      (await peopleC.findOne({
        _id: subject._id,
      }))!,
    );
    expect(after?.name).toBe('Second Match');
    expect(after?.score).toBeCloseTo(0.71, 5);

    // The denormalized head advanced too, so the list-grid badge stays honest.
    const fresh = await peopleC.findOne({ _id: subject._id });
    expect(fresh?.suggested_merge_person_id?.toHexString()).toBe(second._id.toHexString());
  });

  it('goes empty only once every ranked candidate is exhausted', async () => {
    if (!h.mongoReachable) return;
    const { createPerson } = await import('./people.repo.ts');
    const { peopleCollection } = await import('../db/client.ts');
    const { loadSuggestedMergeInfo } = await import('./people-merge-suggestion-info.repo.ts');
    const { dismissMergeSuggestion } = await import('./people-merge-suggestions.repo.ts');
    const peopleC = await peopleCollection();

    const subject = await createPerson('Subject2');
    const one = await createPerson('One');
    const two = await createPerson('Two');
    await peopleC.updateOne(
      { _id: subject._id },
      {
        $set: {
          suggested_merge_person_id: one._id,
          suggested_merge_score: 0.9,
          suggested_merges: [
            { person_id: one._id, score: 0.9 },
            { person_id: two._id, score: 0.8 },
          ],
        },
      },
    );

    await dismissMergeSuggestion(subject._id, one._id);
    // Dismissing a candidate that is NOT the head still works — the banner
    // was showing it because the head had already been dismissed.
    expect(await dismissMergeSuggestion(subject._id, two._id)).toBe('dismissed');

    const after = await loadSuggestedMergeInfo(
      peopleC,
      (await peopleC.findOne({
        _id: subject._id,
      }))!,
    );
    expect(after).toBeNull();
  });

  it('skips a candidate that has since been merged away or hidden', async () => {
    if (!h.mongoReachable) return;
    const { createPerson } = await import('./people.repo.ts');
    const { peopleCollection } = await import('../db/client.ts');
    const { loadSuggestedMergeInfo } = await import('./people-merge-suggestion-info.repo.ts');
    const peopleC = await peopleCollection();

    const subject = await createPerson('Subject3');
    const mergedAway = await createPerson('Merged Away');
    const hidden = await createPerson('Hidden One');
    const live = await createPerson('Live One');

    await peopleC.updateOne({ _id: mergedAway._id }, { $set: { merged_into: subject._id } });
    await peopleC.updateOne({ _id: hidden._id }, { $set: { hidden: true } });
    await peopleC.updateOne(
      { _id: subject._id },
      {
        $set: {
          suggested_merge_person_id: mergedAway._id,
          suggested_merge_score: 0.95,
          suggested_merges: [
            { person_id: mergedAway._id, score: 0.95 },
            { person_id: hidden._id, score: 0.9 },
            { person_id: live._id, score: 0.7 },
          ],
        },
      },
    );

    // Walks past the merged-away and hidden entries to the first live one —
    // this is also what makes the banner refill right after a Merge.
    const info = await loadSuggestedMergeInfo(
      peopleC,
      (await peopleC.findOne({
        _id: subject._id,
      }))!,
    );
    expect(info?.name).toBe('Live One');
  });

  it('falls back to the head fields for rows written before the ranked list landed', async () => {
    if (!h.mongoReachable) return;
    const { createPerson } = await import('./people.repo.ts');
    const { peopleCollection } = await import('../db/client.ts');
    const { loadSuggestedMergeInfo } = await import('./people-merge-suggestion-info.repo.ts');
    const peopleC = await peopleCollection();

    const subject = await createPerson('Subject4');
    const target = await createPerson('Legacy Target');
    // No `suggested_merges` — exactly how a pre-upgrade library's rows look
    // until the next clustering run repopulates them.
    await peopleC.updateOne(
      { _id: subject._id },
      { $set: { suggested_merge_person_id: target._id, suggested_merge_score: 0.88 } },
    );

    const info = await loadSuggestedMergeInfo(
      peopleC,
      (await peopleC.findOne({
        _id: subject._id,
      }))!,
    );
    expect(info?.name).toBe('Legacy Target');
    expect(info?.score).toBeCloseTo(0.88, 5);
  });
});
