/**
 * Tests for `dismissMergeSuggestion` — the write path behind the person-page
 * merge-suggestion banner's "Not the same person" button.
 */
import { describe, it, expect } from 'bun:test';
import { setupMongoHarness } from './people-repo.test-helpers.ts';

const TEST_DB = `maple_test_people_merge_suggestions_repo_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;

const h = setupMongoHarness(TEST_DB);

describe('dismissMergeSuggestion', () => {
  it('clears both sides and records the dismissal when otherId matches the live suggestion', async () => {
    if (!h.mongoReachable) return;
    const { createPerson } = await import('./people.repo.ts');
    const { peopleCollection, personMergeDismissalsCollection } = await import('../db/client.ts');
    const { dismissMergeSuggestion } = await import('./people-merge-suggestions.repo.ts');
    const peopleC = await peopleCollection();

    const a = await createPerson('Person A1');
    const b = await createPerson('Person B1');
    await peopleC.updateOne(
      { _id: a._id },
      { $set: { suggested_merge_person_id: b._id, suggested_merge_score: 0.9 } },
    );
    await peopleC.updateOne(
      { _id: b._id },
      { $set: { suggested_merge_person_id: a._id, suggested_merge_score: 0.9 } },
    );

    const result = await dismissMergeSuggestion(a._id, b._id);
    expect(result).toBe('dismissed');

    const freshA = await peopleC.findOne({ _id: a._id });
    const freshB = await peopleC.findOne({ _id: b._id });
    expect(freshA?.suggested_merge_person_id ?? null).toBeNull();
    expect(freshB?.suggested_merge_person_id ?? null).toBeNull();

    const dismissalsC = await personMergeDismissalsCollection();
    const stored = await dismissalsC.findOne({});
    expect(stored?.pair).toBe([a._id.toHexString(), b._id.toHexString()].sort().join(':'));
  });

  it('is idempotent — re-dismissing an already-dismissed pair does not throw', async () => {
    if (!h.mongoReachable) return;
    const { createPerson } = await import('./people.repo.ts');
    const { peopleCollection } = await import('../db/client.ts');
    const { dismissMergeSuggestion } = await import('./people-merge-suggestions.repo.ts');
    const peopleC = await peopleCollection();

    const a = await createPerson('Person X1');
    const b = await createPerson('Person Y1');
    await peopleC.updateOne(
      { _id: a._id },
      { $set: { suggested_merge_person_id: b._id, suggested_merge_score: 0.9 } },
    );
    await dismissMergeSuggestion(a._id, b._id);

    // Re-set the suggestion (as the next clustering run would try to) and
    // dismiss again — must not throw a duplicate-key error.
    await peopleC.updateOne(
      { _id: a._id },
      { $set: { suggested_merge_person_id: b._id, suggested_merge_score: 0.9 } },
    );
    await expect(dismissMergeSuggestion(a._id, b._id)).resolves.toBe('dismissed');
  });

  it('returns "stale" without writing anything when otherId does not match the live suggestion', async () => {
    if (!h.mongoReachable) return;
    const { createPerson } = await import('./people.repo.ts');
    const { dismissMergeSuggestion } = await import('./people-merge-suggestions.repo.ts');

    const a = await createPerson('Person M1');
    const b = await createPerson('Person N1');
    // a has no suggestion at all.
    const result = await dismissMergeSuggestion(a._id, b._id);
    expect(result).toBe('stale');
  });

  it("does not clear the other side's suggestion if it points elsewhere", async () => {
    if (!h.mongoReachable) return;
    const { createPerson } = await import('./people.repo.ts');
    const { peopleCollection } = await import('../db/client.ts');
    const { dismissMergeSuggestion } = await import('./people-merge-suggestions.repo.ts');
    const peopleC = await peopleCollection();

    const a = await createPerson('Person P1');
    const b = await createPerson('Person Q1');
    const c = await createPerson('Person R1');
    await peopleC.updateOne(
      { _id: a._id },
      { $set: { suggested_merge_person_id: b._id, suggested_merge_score: 0.9 } },
    );
    // b's OWN best match is c, not a — asymmetric, allowed by the design.
    await peopleC.updateOne(
      { _id: b._id },
      { $set: { suggested_merge_person_id: c._id, suggested_merge_score: 0.95 } },
    );

    await dismissMergeSuggestion(a._id, b._id);

    const freshB = await peopleC.findOne({ _id: b._id });
    expect(freshB?.suggested_merge_person_id?.toHexString()).toBe(c._id.toHexString());
  });
});
