/**
 * The Workers page's operator surface: the two lists, the two clear buttons,
 * and the four badge counts.
 *
 * Two behaviours here are worth more than the rest. The damaged clear has to
 * reset the tagging stages and drop the tag as one transaction, in that order,
 * or a cleared file is un-parked for reads and permanently ignored by the
 * pipeline. And both counts have to be live-aware: an asset whose second
 * location is tombstoned is not a duplicate the worker can act on (#1290), so
 * a badge that counted it could never reach zero.
 */

import { describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import {
  createTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  testSqliteDb,
} from '../test-sqlite.test-helpers.ts';
import {
  clearDamagedAssets,
  countDamagedAssets,
  countDuplicateAssets,
  countMissingTaggedAssets,
  countNewlyHiddenAssets,
  listDamagedAssets,
  listDeadAssets,
  retryDeadStage,
} from './worker-admin.repo.ts';

const TAGGING_STAGES = ['exif', 'thumb', 'preview'] as const;

interface SeedOptions {
  libraryId: string;
  filename?: string;
  live?: number;
  missing?: number;
  deleted?: number;
}

/** One asset with the locations a test asks for. Returns its id. */
function seedAsset(db: Database, options: SeedOptions): string {
  const assetId = insertAsset(db);
  let ordinal = 0;
  const add = (_extra: { missingSince?: string; deletedAt?: string } = {}): void => {
    insertLocation(db, {
      assetId,
      libraryId: options.libraryId,
      ordinal,
      // `(library_id, path, filename)` is unique, so each location needs its
      // own directory — the same thing two copies on disk would have.
      path: `dir-${ordinal++}`,
      filename: options.filename ?? `${assetId}.dng`,
    });
  };
  for (let i = 0; i < (options.live ?? 1); i++) add();
  for (let i = 0; i < (options.missing ?? 0); i++) {
    insertLocation(db, {
      assetId,
      libraryId: options.libraryId,
      ordinal,
      path: `dir-${ordinal++}`,
      filename: options.filename ?? `${assetId}.dng`,
      missingSince: '2026-01-01T00:00:00Z',
    });
  }
  for (let i = 0; i < (options.deleted ?? 0); i++) {
    insertLocation(db, {
      assetId,
      libraryId: options.libraryId,
      ordinal,
      path: `dir-${ordinal++}`,
      filename: options.filename ?? `${assetId}.dng`,
      deletedAt: '2026-01-01T00:00:00Z',
    });
  }
  return assetId;
}

function tagDamaged(db: Database, assetId: string, stage: string, reason: string): void {
  db.run(
    `UPDATE assets SET damaged_since = '2026-01-01T00:00:00Z', damaged_stage = ?,
            damaged_reason = ? WHERE id = ?`,
    [stage, reason, assetId],
  );
}

function addStageRow(
  db: Database,
  assetId: string,
  stage: string,
  overrides: { dead?: number; attempts?: number; lastError?: string; processedAt?: string } = {},
): void {
  db.run(
    `INSERT INTO stage_state (asset_id, stage, attempts, dead, last_error, processed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      assetId,
      stage,
      overrides.attempts ?? 0,
      overrides.dead ?? 0,
      overrides.lastError ?? null,
      overrides.processedAt ?? null,
    ],
  );
}

describe('the badge counts', () => {
  it('count damaged, newly hidden, missing-tagged and duplicate assets', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db);

    tagDamaged(handle.db, seedAsset(handle.db, { libraryId }), 'exif', 'bad bytes');
    const hidden = seedAsset(handle.db, { libraryId });
    handle.db.run(
      `UPDATE assets SET hidden = 1, hidden_ack = 0, hidden_reason = 'nudity' WHERE id = ?`,
      [hidden],
    );
    // Acknowledged, so no longer "newly" hidden.
    const acked = seedAsset(handle.db, { libraryId });
    handle.db.run(
      `UPDATE assets SET hidden = 1, hidden_ack = 1, hidden_reason = 'nudity' WHERE id = ?`,
      [acked],
    );
    seedAsset(handle.db, { libraryId, live: 1, missing: 1 });
    seedAsset(handle.db, { libraryId, live: 2 });

    expect(await countDamagedAssets(db)).toBe(1);
    expect(await countNewlyHiddenAssets(db)).toBe(1);
    expect(await countMissingTaggedAssets(db)).toBe(1);
    expect(await countDuplicateAssets(db)).toBe(1);
  });

  it('do not count a tombstoned second location as a duplicate (#1290)', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db);
    seedAsset(handle.db, { libraryId, live: 1, missing: 1 });
    seedAsset(handle.db, { libraryId, live: 1, deleted: 1 });

    // Neither is something the deduplicate worker can act on, so a badge that
    // counted them could never reach zero.
    expect(await countDuplicateAssets(db)).toBe(0);
  });

  it('count an asset with several missing locations once', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db);
    seedAsset(handle.db, { libraryId, live: 1, missing: 2 });

    expect(await countMissingTaggedAssets(db)).toBe(1);
  });
});

describe('the dead-letter list', () => {
  it('lists a stage’s parked assets with their absolute paths', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db, { path: '/lib' });
    const assetId = insertAsset(handle.db);
    insertLocation(handle.db, { assetId, libraryId, path: 'a/b', filename: 'broken.dng' });
    addStageRow(handle.db, assetId, 'exif', {
      dead: 1,
      attempts: 3,
      lastError: 'Unknown file format',
      processedAt: '2026-01-01T00:00:00Z',
    });
    // A live row for the same stage, and a dead row for a different one.
    addStageRow(handle.db, seedAsset(handle.db, { libraryId }), 'exif');
    addStageRow(handle.db, seedAsset(handle.db, { libraryId }), 'thumb', { dead: 1 });

    expect(await listDeadAssets('exif', 50, db)).toEqual([
      {
        id: assetId,
        abs_path: '/lib/a/b/broken.dng',
        last_error: 'Unknown file format',
        attempts: 3,
        processed_at: '2026-01-01T00:00:00Z',
      },
    ]);
  });

  it('honours the limit', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db);
    for (let i = 0; i < 5; i++) {
      addStageRow(handle.db, seedAsset(handle.db, { libraryId }), 'exif', { dead: 1 });
    }

    expect(await listDeadAssets('exif', 2, db)).toHaveLength(2);
  });
});

describe('retryDeadStage', () => {
  it('re-queues only that stage, and lifts the retry gate with the flag', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db);
    const assetId = seedAsset(handle.db, { libraryId });
    addStageRow(handle.db, assetId, 'exif', { dead: 1, attempts: 3, lastError: 'boom' });
    handle.db.run(
      `UPDATE stage_state SET next_attempt_at = '2099-01-01T00:00:00Z'
        WHERE asset_id = ? AND stage = 'exif'`,
      [assetId],
    );
    addStageRow(handle.db, assetId, 'thumb', { dead: 1, attempts: 3 });

    expect(await retryDeadStage('exif', db)).toBe(1);

    // Without clearing the gate, "Retry dead" looked like it had done nothing
    // for up to fifteen minutes (#2729).
    expect(
      handle.db
        .query(
          `SELECT dead, attempts, last_error, next_attempt_at FROM stage_state
                 WHERE asset_id = ? AND stage = 'exif'`,
        )
        .get(assetId),
    ).toMatchObject({ dead: 0, attempts: 0, last_error: null, next_attempt_at: null });
    expect(
      handle.db
        .query(`SELECT dead FROM stage_state WHERE asset_id = ? AND stage = 'thumb'`)
        .get(assetId),
    ).toMatchObject({ dead: 1 });
  });
});

describe('the damaged list and its clear', () => {
  it('lists tagged assets newest first, with their provenance', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db, { path: '/lib' });
    const older = insertAsset(handle.db);
    insertLocation(handle.db, { assetId: older, libraryId, path: 'a', filename: 'old.cr2' });
    handle.db.run(
      `UPDATE assets SET damaged_since = '2026-01-01T00:00:00Z', damaged_stage = 'exif',
              damaged_reason = 'old', maple_id = 'one' WHERE id = ?`,
      [older],
    );
    const newer = insertAsset(handle.db);
    insertLocation(handle.db, { assetId: newer, libraryId, path: 'b', filename: 'new.cr2' });
    handle.db.run(
      `UPDATE assets SET damaged_since = '2026-06-01T00:00:00Z', damaged_stage = 'thumb',
              damaged_reason = 'new' WHERE id = ?`,
      [newer],
    );

    const items = await listDamagedAssets(50, db);

    expect(items.map((item) => item.id)).toEqual([newer, older]);
    expect(items[1]).toEqual({
      id: older,
      maple_id: 'one',
      abs_path: '/lib/a/old.cr2',
      stage: 'exif',
      reason: 'old',
      since: '2026-01-01T00:00:00Z',
    });
  });

  it('clears one asset: the tag and every tagging stage, together', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db);
    const target = seedAsset(handle.db, { libraryId });
    const other = seedAsset(handle.db, { libraryId });
    for (const assetId of [target, other]) {
      tagDamaged(handle.db, assetId, 'exif', 'bad bytes');
      for (const stage of TAGGING_STAGES) {
        addStageRow(handle.db, assetId, stage, { dead: 1, attempts: 3, lastError: 'bad bytes' });
      }
    }

    expect(await clearDamagedAssets(target, TAGGING_STAGES, db)).toBe(1);

    const cleared = handle.db
      .query(`SELECT damaged_since, damaged_stage, damaged_reason FROM assets WHERE id = ?`)
      .get(target);
    expect(cleared).toEqual({
      damaged_since: null,
      damaged_stage: null,
      damaged_reason: null,
    });
    // Genuinely re-tried, not merely un-parked: an asset whose tag went but
    // whose stages stayed dead would be invisible to the pipeline forever.
    expect(
      handle.db
        .query(`SELECT COUNT(*) AS n FROM stage_state WHERE asset_id = ? AND dead = 1`)
        .get(target),
    ).toEqual({ n: 0 });
    // The other asset is untouched, tag and stages alike.
    expect(
      handle.db.query(`SELECT damaged_since FROM assets WHERE id = ?`).get(other),
    ).toMatchObject({ damaged_since: '2026-01-01T00:00:00Z' });
    expect(
      handle.db
        .query(`SELECT COUNT(*) AS n FROM stage_state WHERE asset_id = ? AND dead = 1`)
        .get(other),
    ).toEqual({ n: 3 });
  });

  it('clears every tagged asset when given no id', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db);
    for (let i = 0; i < 3; i++) {
      const assetId = seedAsset(handle.db, { libraryId });
      tagDamaged(handle.db, assetId, 'exif', 'bad bytes');
      addStageRow(handle.db, assetId, 'exif', { dead: 1 });
    }
    // An untagged asset with a dead exif row: not this button's business.
    const untagged = seedAsset(handle.db, { libraryId });
    addStageRow(handle.db, untagged, 'exif', { dead: 1 });

    expect(await clearDamagedAssets(null, TAGGING_STAGES, db)).toBe(3);

    expect(await countDamagedAssets(db)).toBe(0);
    expect(
      handle.db
        .query(`SELECT dead FROM stage_state WHERE asset_id = ? AND stage = 'exif'`)
        .get(untagged),
    ).toMatchObject({ dead: 1 });
  });

  it('reports zero when nothing is tagged', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    expect(await clearDamagedAssets(null, TAGGING_STAGES, db)).toBe(0);
  });
});
