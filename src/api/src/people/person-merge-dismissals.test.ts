/**
 * Tests for the `person_merge_dismissals` collection: the accessor and its
 * unique index on `pair`. Backing store for the person-page merge-suggestion
 * "not a match" dismiss action (`people-merge-suggestions.repo.ts`).
 */
import { describe, it, expect } from 'bun:test';
import { setupMongoHarness } from './people-repo.test-helpers.ts';

const TEST_DB = `maple_test_person_merge_dismissals_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;

const h = setupMongoHarness(TEST_DB);

describe('personMergeDismissalsCollection', () => {
  it('round-trips a dismissal doc', async () => {
    if (!h.mongoReachable) return;
    const { personMergeDismissalsCollection } = await import('../db/client.ts');
    const coll = await personMergeDismissalsCollection();
    await coll.insertOne({ pair: 'aaa:bbb', created_at: new Date().toISOString() });
    const found = await coll.findOne({ pair: 'aaa:bbb' });
    expect(found?.pair).toBe('aaa:bbb');
  });

  it('rejects a duplicate pair via the unique index', async () => {
    if (!h.mongoReachable) return;
    const { personMergeDismissalsCollection } = await import('../db/client.ts');
    const coll = await personMergeDismissalsCollection();
    await coll.insertOne({ pair: 'ccc:ddd', created_at: new Date().toISOString() });
    await expect(
      coll.insertOne({ pair: 'ccc:ddd', created_at: new Date().toISOString() }),
    ).rejects.toThrow();
  });
});
