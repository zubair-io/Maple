import { describe, expect, test } from 'bun:test';
import { createTestDatabase } from '../sqlite/test-sqlite.test-helpers.ts';
import { insertFace, insertLibrary, insertLiveAsset, insertPerson } from './people.test-helpers.ts';
import { insertStageState } from './assets.test-helpers.ts';
import { stageRow } from './stage-runtime.test-helpers.ts';

const SEARCH_STAGES = ['meili', 'embed'] as const;

async function indexedAsset() {
  const handle = await createTestDatabase();
  const library = insertLibrary(handle.db);
  const person = insertPerson(handle.db, { name: 'Zoe' });
  const asset = insertLiveAsset(handle.db, library);
  insertFace(handle.db, { assetId: asset, personId: person });
  SEARCH_STAGES.forEach((stage) =>
    insertStageState(handle.db, asset, stage, {
      version: 8,
      attempts: 2,
      dead: true,
      nextAttemptAt: '2026-10-09T00:10:00.000Z',
    }),
  );
  return { handle, library, person, asset };
}

function versions(handle: { db: Parameters<typeof stageRow>[0] }, asset: string) {
  return SEARCH_STAGES.map((stage) => stageRow(handle.db, asset, stage)?.version);
}

describe('search-text triggers on faces', () => {
  test('deleting an assigned face re-arms both stages and revokes the claim', async () => {
    const { handle, asset } = await indexedAsset();
    using _ = handle;

    handle.db.run(`DELETE FROM faces WHERE asset_id = ?`, [asset]);

    expect(versions(handle, asset)).toEqual([0, 0]);
    expect(stageRow(handle.db, asset, 'embed')).toMatchObject({
      attempts: 0,
      dead: 0,
      next_attempt_at: null,
    });
  });

  test('a detector re-run that replaces an assigned face with an unassigned one re-arms', async () => {
    const { handle, asset } = await indexedAsset();
    using _ = handle;

    handle.db.run(`DELETE FROM faces WHERE asset_id = ?`, [asset]);
    insertFace(handle.db, { assetId: asset });

    expect(versions(handle, asset)).toEqual([0, 0]);
  });

  test('assigning, unassigning and inserting an assigned face each re-arm', async () => {
    const { handle, library, person } = await indexedAsset();
    using _ = handle;
    const other = insertLiveAsset(handle.db, library);
    SEARCH_STAGES.forEach((stage) => insertStageState(handle.db, other, stage, { version: 8 }));
    insertFace(handle.db, { assetId: other });
    expect(versions(handle, other)).toEqual([8, 8]);

    handle.db.run(`UPDATE faces SET person_id = ? WHERE asset_id = ?`, [person, other]);
    expect(versions(handle, other)).toEqual([0, 0]);

    SEARCH_STAGES.forEach((stage) =>
      handle.db.run(`UPDATE stage_state SET version = 8 WHERE asset_id = ? AND stage = ?`, [
        other,
        stage,
      ]),
    );
    handle.db.run(`UPDATE faces SET person_id = NULL WHERE asset_id = ?`, [other]);
    expect(versions(handle, other)).toEqual([0, 0]);
  });

  test('inserting an unassigned face and updating its bbox re-arm nothing', async () => {
    const { handle, library } = await indexedAsset();
    using _ = handle;
    const other = insertLiveAsset(handle.db, library);
    SEARCH_STAGES.forEach((stage) => insertStageState(handle.db, other, stage, { version: 8 }));

    insertFace(handle.db, { assetId: other });
    handle.db.run(`UPDATE faces SET bbox_x = 0.5, confidence = 0.5 WHERE asset_id = ?`, [other]);

    expect(versions(handle, other)).toEqual([8, 8]);
  });
});

describe('search-text triggers on people', () => {
  test('renaming, hiding, excluding or merging a person re-arms their assets', async () => {
    for (const change of [
      `name = 'Zoe Renamed', name_key = 'zoe renamed'`,
      `hidden = 1`,
      `excluded = 1`,
    ]) {
      const { handle, person, asset } = await indexedAsset();
      using _ = handle;

      handle.db.run(`UPDATE people SET ${change} WHERE id = ?`, [person]);

      expect(versions(handle, asset)).toEqual([0, 0]);
    }
  });

  test('changing only the cover re-arms nothing', async () => {
    const { handle, person, asset } = await indexedAsset();
    using _ = handle;

    handle.db.run(`UPDATE people SET cover_bbox_x = 0.2, updated_at = 'later' WHERE id = ?`, [
      person,
    ]);

    expect(versions(handle, asset)).toEqual([8, 8]);
  });

  test('a person with no faces on an asset leaves that asset alone', async () => {
    const { handle, library } = await indexedAsset();
    using _ = handle;
    const stranger = insertPerson(handle.db, { name: 'Stranger' });
    const other = insertLiveAsset(handle.db, library);
    SEARCH_STAGES.forEach((stage) => insertStageState(handle.db, other, stage, { version: 8 }));

    handle.db.run(`UPDATE people SET hidden = 1 WHERE id = ?`, [stranger]);

    expect(versions(handle, other)).toEqual([8, 8]);
  });
});
