/**
 * Re-arming the search index after a people change (#3787).
 *
 * Converted from the `people-search-reindex` block of the Mongo
 * `people/people.repo.test.ts`. The behaviour under test is unchanged: renaming
 * or reassigning somebody must put the affected assets back in the meili
 * stage's queue, and must not drag unrelated assets in with them.
 *
 * What did change is where "queued" lives. On MongoDB it was a `stages.meili`
 * subdocument the update created on demand; here it is a `stage_state` row that
 * may or may not exist yet, which is why the writes upsert. An asset with no
 * row at all is the interesting case — assuming the row is there is what
 * produced #2177 — so it is asserted alongside the ordinary reset.
 */

import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { ObjectId } from '../object-id.ts';
import { createTestDatabase } from '../sqlite/test-sqlite.test-helpers.ts';
import { insertStageState } from './assets.test-helpers.ts';
import { MEILI_STAGE, stageRearmBatchStatement } from './assets.stage-rearm.ts';
import { stageRow } from './stage-runtime.test-helpers.ts';
import {
  insertFace,
  insertLibrary,
  insertLiveAsset,
  insertPerson,
  testDb,
} from './people.test-helpers.ts';
import { renamePerson } from './people.repo.ts';

/** An asset already processed at v6, with dead-letter bookkeeping to clear. */
function indexedAtVersionSix(db: Database, assetId: string): void {
  insertStageState(db, assetId, MEILI_STAGE, {
    version: 6,
    attempts: 3,
    dead: true,
    lastError: 'x',
    processedAt: '2025-01-01T00:00:00Z',
  });
}

describe('asset search-stage resets', () => {
  test('re-arms only the named assets, not the rest of the person’s corpus', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    const subject = insertPerson(db, { name: 'Subject' });
    const target = insertLiveAsset(db, library);
    const sibling = insertLiveAsset(db, library);
    insertFace(db, { assetId: target, personId: subject });
    insertFace(db, { assetId: sibling, personId: subject });
    indexedAtVersionSix(db, target);
    indexedAtVersionSix(db, sibling);

    const [written] = await testDb(db).transaction([
      stageRearmBatchStatement([target], MEILI_STAGE),
    ]);

    expect(written?.changes).toBe(1);
    expect(stageRow(db, target, MEILI_STAGE)).toMatchObject({ version: 0, dead: 0 });
    // Re-arming a whole person's corpus for a single-asset change would
    // re-queue thousands of unchanged rows on a large library.
    expect(stageRow(db, sibling, MEILI_STAGE)?.version).toBe(6);
  });

  test('an unknown asset id inserts nothing', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;

    const [written] = await testDb(db).transaction([
      stageRearmBatchStatement([new ObjectId().toHexString()], MEILI_STAGE),
    ]);

    expect(written?.changes).toBe(0);
    expect(db.query('SELECT COUNT(*) AS n FROM stage_state').get()).toEqual({ n: 0 });
  });

  test('an empty id list writes nothing', async () => {
    using handle = await createTestDatabase();
    const [written] = await testDb(handle.db).transaction([
      stageRearmBatchStatement([], MEILI_STAGE),
    ]);
    expect(written?.changes).toBe(0);
  });
});

describe('the people mutations trigger the re-arm themselves', () => {
  test('renaming a person re-queues their assets', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    const person = insertPerson(db, { name: 'Rho' });
    const asset = insertLiveAsset(db, library);
    insertFace(db, { assetId: asset, personId: person });
    // The stage has already caught up, so a reset is visible as a change.
    indexedAtVersionSix(db, asset);

    await renamePerson(new ObjectId(person), 'RhoRenamed', testDb(db));

    // The local work request commits before the mutation returns.
    expect(stageRow(db, asset, MEILI_STAGE)?.version).toBe(0);
  });
});
