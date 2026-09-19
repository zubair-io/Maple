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
import { ObjectId } from '../../object-id.ts';
import { createTestDatabase } from '../test-sqlite.test-helpers.ts';
import { insertStageState } from './assets.test-helpers.ts';
import { MEILI_STAGE } from './assets.stage-rearm.ts';
import { markAssetIdsForMeiliReindex, markAssetsForMeiliReindex } from './people.search-reindex.ts';
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

describe('markAssetsForMeiliReindex', () => {
  test('re-arms every asset carrying one of these people, and nothing else', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    const subject = insertPerson(db, { name: 'Subject' });
    const other = insertPerson(db, { name: 'Other' });
    const matching = insertLiveAsset(db, library);
    const unrelated = insertLiveAsset(db, library);
    insertFace(db, { assetId: matching, personId: subject });
    insertFace(db, { assetId: unrelated, personId: other });
    indexedAtVersionSix(db, matching);
    indexedAtVersionSix(db, unrelated);

    const written = await markAssetsForMeiliReindex([new ObjectId(subject)], testDb(db));

    expect(written).toBe(1);
    // Back below the stage's target version, with the dead-letter and
    // last-processed bookkeeping cleared so the retry starts clean.
    expect(stageRow(db, matching, MEILI_STAGE)).toMatchObject({
      version: 0,
      attempts: 0,
      dead: 0,
      last_error: null,
      processed_at: null,
    });
    expect(stageRow(db, unrelated, MEILI_STAGE)?.version).toBe(6);
  });

  test('re-arms an asset that has no stage row yet', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    const subject = insertPerson(db, { name: 'Subject' });
    const asset = insertLiveAsset(db, library);
    insertFace(db, { assetId: asset, personId: subject });

    // No `insertStageState` — the row is absent, which on Mongo the `$set`
    // created for free and here has to be an upsert.
    await markAssetsForMeiliReindex([subject], testDb(db));

    expect(stageRow(db, asset, MEILI_STAGE)?.version).toBe(0);
  });

  test('an empty id list writes nothing', async () => {
    using handle = await createTestDatabase();
    expect(await markAssetsForMeiliReindex([], testDb(handle.db))).toBe(0);
  });
});

describe('markAssetIdsForMeiliReindex', () => {
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

    const written = await markAssetIdsForMeiliReindex([new ObjectId(target)], testDb(db));

    expect(written).toBe(1);
    expect(stageRow(db, target, MEILI_STAGE)).toMatchObject({ version: 0, dead: 0 });
    // Re-arming a whole person's corpus for a single-asset change would
    // re-queue thousands of unchanged rows on a large library.
    expect(stageRow(db, sibling, MEILI_STAGE)?.version).toBe(6);
  });

  test('an unknown asset id inserts nothing', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;

    const written = await markAssetIdsForMeiliReindex([new ObjectId()], testDb(db));

    expect(written).toBe(0);
    expect(db.query('SELECT COUNT(*) AS n FROM stage_state').get()).toEqual({ n: 0 });
  });

  test('an empty id list writes nothing', async () => {
    using handle = await createTestDatabase();
    expect(await markAssetIdsForMeiliReindex([], testDb(handle.db))).toBe(0);
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

    // The re-index is fire-and-forget — a search-index hiccup must never fail
    // the rename — so poll briefly for it to land.
    await waitFor(() => stageRow(db, asset, MEILI_STAGE)?.version === 0);
    expect(stageRow(db, asset, MEILI_STAGE)?.version).toBe(0);
  });
});

/** Poll a condition for up to half a second. */
async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
