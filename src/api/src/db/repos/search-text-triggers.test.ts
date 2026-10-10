import { describe, expect, test } from 'bun:test';
import {
  createTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
} from '../sqlite/test-sqlite.test-helpers.ts';
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

describe('search-text triggers on asset_locations', () => {
  async function twoLocationAsset(lowerMissing: boolean) {
    const handle = await createTestDatabase();
    const library = insertFolder(handle.db);
    const asset = insertAsset(handle.db);
    insertLocation(handle.db, {
      assetId: asset,
      libraryId: library,
      ordinal: 0,
      filename: 'IMG_LOWER.dng',
      missingSince: lowerMissing ? '2026-10-01T00:00:00.000Z' : null,
    });
    insertLocation(handle.db, {
      assetId: asset,
      libraryId: library,
      ordinal: 1,
      path: 'copy',
      filename: 'IMG_HIGHER.dng',
    });
    SEARCH_STAGES.forEach((stage) => insertStageState(handle.db, asset, stage, { version: 8 }));
    return { handle, asset };
  }

  test('rediscovering a lower-ordinal location that was missing re-arms (it becomes primary)', async () => {
    const { handle, asset } = await twoLocationAsset(true);
    using _ = handle;

    handle.db.run(
      `UPDATE asset_locations SET missing_since = NULL WHERE asset_id = ? AND ordinal = 0`,
      [asset],
    );

    expect(versions(handle, asset)).toEqual([0, 0]);
  });

  test('losing the primary location re-arms; changing a non-primary location does not', async () => {
    const { handle, asset } = await twoLocationAsset(false);
    using _ = handle;

    handle.db.run(
      `UPDATE asset_locations SET missing_since = 'x' WHERE asset_id = ? AND ordinal = 1`,
      [asset],
    );
    handle.db.run(
      `UPDATE asset_locations SET filename = 'renamed.dng' WHERE asset_id = ? AND ordinal = 1`,
      [asset],
    );
    expect(versions(handle, asset)).toEqual([8, 8]);

    handle.db.run(
      `UPDATE asset_locations SET missing_since = 'x' WHERE asset_id = ? AND ordinal = 0`,
      [asset],
    );
    expect(versions(handle, asset)).toEqual([0, 0]);
  });

  test('renaming the primary file re-arms, and adding a higher-ordinal copy does not', async () => {
    const { handle, asset } = await twoLocationAsset(false);
    using _ = handle;
    const library = (
      handle.db.query(`SELECT library_id AS id FROM asset_locations LIMIT 1`).get() as {
        id: string;
      }
    ).id;

    insertLocation(handle.db, {
      assetId: asset,
      libraryId: library,
      ordinal: 2,
      path: 'third',
      filename: 'c.dng',
    });
    expect(versions(handle, asset)).toEqual([8, 8]);

    handle.db.run(
      `UPDATE asset_locations SET filename = 'renamed.dng' WHERE asset_id = ? AND ordinal = 0`,
      [asset],
    );
    expect(versions(handle, asset)).toEqual([0, 0]);
  });

  test('a trashed asset re-arms nothing when its locations change', async () => {
    const { handle, asset } = await twoLocationAsset(false);
    using _ = handle;
    handle.db.run(`UPDATE assets SET deleted_at = '2026-10-01T00:00:00.000Z' WHERE id = ?`, [
      asset,
    ]);

    handle.db.run(
      `UPDATE asset_locations SET filename = 'renamed.dng' WHERE asset_id = ? AND ordinal = 0`,
      [asset],
    );
    handle.db.run(`DELETE FROM asset_locations WHERE asset_id = ?`, [asset]);

    expect(versions(handle, asset)).toEqual([8, 8]);
  });

  test('a live location moved onto another asset (a merge) re-arms the survivor', async () => {
    const { handle, asset } = await twoLocationAsset(true);
    using _ = handle;
    const library = (
      handle.db.query(`SELECT library_id AS id FROM asset_locations LIMIT 1`).get() as {
        id: string;
      }
    ).id;
    const condemned = insertAsset(handle.db);
    insertLocation(handle.db, {
      assetId: condemned,
      libraryId: library,
      path: 'merged',
      filename: 'moved.dng',
    });
    SEARCH_STAGES.forEach((stage) => insertStageState(handle.db, condemned, stage, { version: 8 }));
    SEARCH_STAGES.forEach((stage) =>
      handle.db.run(`UPDATE stage_state SET version = 8 WHERE asset_id = ? AND stage = ?`, [
        asset,
        stage,
      ]),
    );

    handle.db.run(`UPDATE asset_locations SET asset_id = ?, ordinal = 5 WHERE asset_id = ?`, [
      asset,
      condemned,
    ]);

    expect(versions(handle, asset)).toEqual([0, 0]);
  });

  test('moving a location onto a trashed asset re-arms nothing', async () => {
    const { handle, asset } = await twoLocationAsset(false);
    using _ = handle;
    const library = (
      handle.db.query(`SELECT library_id AS id FROM asset_locations LIMIT 1`).get() as {
        id: string;
      }
    ).id;
    const other = insertAsset(handle.db);
    insertLocation(handle.db, {
      assetId: other,
      libraryId: library,
      path: 'other',
      filename: 'o.dng',
    });
    handle.db.run(`UPDATE assets SET deleted_at = '2026-10-01T00:00:00.000Z' WHERE id = ?`, [
      asset,
    ]);

    handle.db.run(`UPDATE asset_locations SET asset_id = ?, ordinal = 5 WHERE asset_id = ?`, [
      asset,
      other,
    ]);

    expect(versions(handle, asset)).toEqual([8, 8]);
  });

  test('a live location arriving on an asset with no live location re-arms it', async () => {
    const { handle, asset } = await twoLocationAsset(false);
    using _ = handle;
    const library = (
      handle.db.query(`SELECT library_id AS id FROM asset_locations LIMIT 1`).get() as {
        id: string;
      }
    ).id;
    handle.db.run(`DELETE FROM asset_locations WHERE asset_id = ?`, [asset]);
    SEARCH_STAGES.forEach((stage) =>
      handle.db.run(`UPDATE stage_state SET version = 8 WHERE asset_id = ? AND stage = ?`, [
        asset,
        stage,
      ]),
    );
    expect(versions(handle, asset)).toEqual([8, 8]);

    insertLocation(handle.db, { assetId: asset, libraryId: library, filename: 'back.dng' });

    expect(versions(handle, asset)).toEqual([0, 0]);
  });

  test('a live location arriving where every existing one is missing re-arms it', async () => {
    const { handle, asset } = await twoLocationAsset(true);
    using _ = handle;
    const library = (
      handle.db.query(`SELECT library_id AS id FROM asset_locations LIMIT 1`).get() as {
        id: string;
      }
    ).id;
    handle.db.run(`UPDATE asset_locations SET missing_since = 'x' WHERE asset_id = ?`, [asset]);
    SEARCH_STAGES.forEach((stage) =>
      handle.db.run(`UPDATE stage_state SET version = 8 WHERE asset_id = ? AND stage = ?`, [
        asset,
        stage,
      ]),
    );

    insertLocation(handle.db, {
      assetId: asset,
      libraryId: library,
      ordinal: 2,
      path: 'new',
      filename: 'n.dng',
    });

    expect(versions(handle, asset)).toEqual([0, 0]);
  });
});
