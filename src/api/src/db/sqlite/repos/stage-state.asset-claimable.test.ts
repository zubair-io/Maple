/**
 * `stage_state.asset_claimable` — the mirror the backlog counts read, and the
 * two triggers that own it (#3804).
 *
 * Nothing in the codebase writes this column, for the reason
 * `assets.live_location_count` is written the same way: a call site that has to
 * remember eventually forgets, and #2177 is what that looks like. So these
 * tests are about the one thing that can go wrong — the mirror falling out of
 * step with `assets` — and in particular about the path that is easiest to get
 * wrong, where the column is two triggers away from the write that changed the
 * answer.
 *
 * A location going missing is that path. Nothing updates `assets` directly:
 * `asset_locations_count_au` recomputes `live_location_count`, and only then
 * does `assets_claimable_stage_state_au` see a claimability flip. SQLite fires
 * triggers from inside trigger bodies even with `recursive_triggers` off, which
 * is what makes the chain work — and is worth a test, because it is not the
 * behaviour the pragma's name suggests.
 *
 * Unlike `media_kind`, a stale value here cannot strand an asset: the claim
 * still asks `assets` itself, so the worst case is a wrong number on a settings
 * page. That is why the recompute exists and why it is checked here too.
 */

import { beforeEach, afterEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { STAGE_STATE_ASSET_CLAIMABLE_RECOMPUTE_SQL } from '../ddl/stage-state.ts';
import {
  createTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
  testSqliteDb,
  type TestDatabase,
} from '../test-sqlite.test-helpers.ts';
import { insertStageState } from './assets.test-helpers.ts';
import { registerStage, seedStageRows } from './stage-state.repo.ts';

const NOW = '2026-06-01T12:00:00.000Z';
const STAGES = ['exif', 'thumb'];

function claimableFlags(db: Database, assetId: string): number[] {
  return (
    db
      .query(`SELECT asset_claimable FROM stage_state WHERE asset_id = ? ORDER BY stage`)
      .all(assetId) as Array<{ asset_claimable: number }>
  ).map((row) => row.asset_claimable);
}

describe('stage_state.asset_claimable', () => {
  let handle: TestDatabase;
  let db: Database;
  let libraryId: string;

  beforeEach(async () => {
    handle = await createTestDatabase();
    db = handle.db;
    libraryId = insertFolder(db);
  });
  afterEach(() => handle.close());

  /** A live asset whose stage rows are seeded after its location exists. */
  async function seedLiveAsset(): Promise<string> {
    const assetId = insertAsset(db);
    insertLocation(db, { assetId, libraryId });
    await seedStageRows(assetId, STAGES, testSqliteDb(db));
    return assetId;
  }

  test('a row seeded for a live asset reads claimable', async () => {
    expect(claimableFlags(db, await seedLiveAsset())).toEqual([1, 1]);
  });

  test('a row seeded for an asset with no live location does not', async () => {
    const assetId = insertAsset(db);
    insertLocation(db, { assetId, libraryId, missingSince: NOW });
    await seedStageRows(assetId, STAGES, testSqliteDb(db));
    expect(claimableFlags(db, assetId)).toEqual([0, 0]);
  });

  test('soft-deleting the asset parks every one of its stage rows', async () => {
    const assetId = await seedLiveAsset();
    run(db, `UPDATE assets SET deleted_at = ? WHERE id = ?`, NOW, assetId);
    expect(claimableFlags(db, assetId)).toEqual([0, 0]);
    run(db, `UPDATE assets SET deleted_at = NULL WHERE id = ?`, assetId);
    expect(claimableFlags(db, assetId)).toEqual([1, 1]);
  });

  test('tagging the asset damaged parks them, and clearing the tag lifts it', async () => {
    const assetId = await seedLiveAsset();
    run(db, `UPDATE assets SET damaged_since = ? WHERE id = ?`, NOW, assetId);
    expect(claimableFlags(db, assetId)).toEqual([0, 0]);
    run(db, `UPDATE assets SET damaged_since = NULL WHERE id = ?`, assetId);
    expect(claimableFlags(db, assetId)).toEqual([1, 1]);
  });

  test('a location going missing reaches the column through two triggers', async () => {
    const assetId = await seedLiveAsset();
    run(db, `UPDATE asset_locations SET missing_since = ? WHERE asset_id = ?`, NOW, assetId);
    expect(claimableFlags(db, assetId)).toEqual([0, 0]);
    run(db, `UPDATE asset_locations SET missing_since = NULL WHERE asset_id = ?`, assetId);
    expect(claimableFlags(db, assetId)).toEqual([1, 1]);
  });

  test('a second live location keeps the asset claimable when the first goes', async () => {
    const assetId = await seedLiveAsset();
    insertLocation(db, { assetId, libraryId, ordinal: 1, filename: 'second.dng' });
    run(
      db,
      `UPDATE asset_locations SET missing_since = ? WHERE asset_id = ? AND ordinal = 0`,
      NOW,
      assetId,
    );
    expect(claimableFlags(db, assetId)).toEqual([1, 1]);
  });

  test('registering a stage across existing assets stamps each row correctly', async () => {
    const live = await seedLiveAsset();
    const trashed = await seedLiveAsset();
    run(db, `UPDATE assets SET deleted_at = ? WHERE id = ?`, NOW, trashed);

    await registerStage('describe', testSqliteDb(db));

    const stampFor = (assetId: string): number =>
      (
        db
          .query(
            `SELECT asset_claimable FROM stage_state WHERE asset_id = ? AND stage = 'describe'`,
          )
          .get(assetId) as { asset_claimable: number }
      ).asset_claimable;
    expect(stampFor(live)).toBe(1);
    expect(stampFor(trashed)).toBe(0);
  });

  test('the recompute repairs a column that has been corrupted by hand', async () => {
    const live = await seedLiveAsset();
    const trashed = insertAsset(db);
    insertLocation(db, { assetId: trashed, libraryId });
    insertStageState(db, trashed, 'exif', {});
    run(db, `UPDATE assets SET deleted_at = ? WHERE id = ?`, NOW, trashed);

    // What a triggerless bulk load, or a dropped trigger, would leave behind.
    run(db, `UPDATE stage_state SET asset_claimable = 1 - asset_claimable`);
    expect(claimableFlags(db, live)).toEqual([0, 0]);

    db.exec(STAGE_STATE_ASSET_CLAIMABLE_RECOMPUTE_SQL);
    expect(claimableFlags(db, live)).toEqual([1, 1]);
    expect(claimableFlags(db, trashed)).toEqual([0]);
  });
});
