/**
 * Regression test for #2103 — getPerson must apply the file-resolvability
 * filter BEFORE the DB `$skip`/`$limit`, not after.
 *
 * The bug: `getPerson` paginated in the aggregation (sort by captured_at →
 * skip → limit) but dropped faces whose asset doesn't resolve
 * (`assetAbsPath` null → all `fileinfo` entries deleted/missing) in
 * JavaScript AFTER the limit. A page window that landed entirely on
 * unresolvable faces came back empty even though thousands of resolvable
 * faces sat on later pages — the DB `$limit` was blind to the JS filter.
 *
 * Real Mongo, skip-pass when unreachable (mirrors the other people tests).
 */
import { describe, it, expect } from 'bun:test';
import { ObjectId } from 'mongodb';
import { setupMongoHarness } from './people-repo.test-helpers.ts';

const TEST_DB = `maple_test_people_detail_pagination_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;

const h = setupMongoHarness(TEST_DB);

describe('getPerson — resolvability filter precedes pagination (#2103)', () => {
  it('returns resolvable faces when the most-recent page window is entirely missing', async () => {
    if (!h.mongoReachable) return;
    const { createPerson, getPerson } = await import('./people.repo.ts');
    const { invalidateLibraryRoots } = await import('../indexer/libraries.cache.ts');

    // One registered library everything lives in (so assetAbsPath resolves
    // for the live faces).
    const libraryId = new ObjectId();
    await h.db
      .collection('folders')
      .insertOne({ _id: libraryId, path: '/srv/photos', slug: 'photos', label: 't' } as never);
    invalidateLibraryRoots();

    const person = await createPerson('Bigcluster');
    const pid = person._id.toHexString();
    const bbox = { x: 0, y: 0, w: 10, h: 10 };

    // Insert one asset carrying a single face → person, with a controllable
    // capture time and liveness. A "missing" asset has its only fileinfo
    // entry flagged `missing_since` → assetAbsPath returns null for it.
    const insert = async (capturedAt: string, live: boolean): Promise<void> => {
      await h.db.collection('assets').insertOne({
        fileinfo: [
          {
            path: '',
            filename: `${Math.random().toString(36).slice(2)}.jpg`,
            library_id: libraryId,
            deleted_at: null,
            missing_since: live ? null : new Date().toISOString(),
          },
        ],
        exif: { captured_at: capturedAt },
        faces: [{ bbox, person_id: pid, confidence: 0.9, embedding: [] }],
      } as never);
    };

    // The three MOST-RECENT faces are on a currently-missing source; the two
    // older ones are live and resolvable.
    await insert('2026-07-19T10:00:00Z', false);
    await insert('2026-07-19T09:00:00Z', false);
    await insert('2026-07-19T08:00:00Z', false);
    await insert('2026-05-01T10:00:00Z', true);
    await insert('2026-05-01T09:00:00Z', true);

    // First page of 3, sorted most-recent-first. Pre-fix: the DB window is the
    // three missing faces, all JS-filtered → []. Post-fix: the missing faces
    // are excluded before the limit, so the page is the two live faces.
    const detail = await getPerson(person._id, 0, 3);
    expect(detail).not.toBeNull();
    expect(detail!.faces.length).toBe(2);
    expect(detail!.faces.every((f) => f.abs_path.startsWith('/srv/photos'))).toBe(true);
  });
});
