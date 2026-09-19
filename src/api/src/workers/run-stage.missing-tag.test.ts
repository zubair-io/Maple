/**
 * The runner's ENOENT path: what happens when an original-file stage cannot
 * find the file it was claimed to process.
 *
 * Confirm-before-tag (#2171) is the whole subject. A handler-level ENOENT is
 * only a CLAIM that the file is gone — it can also be a race, a stale negative
 * cache on a network share, or an unmounted library root under which every
 * child path ENOENTs. The runner therefore resolves the location against its
 * registered root, requires the root to be available (listable and non-empty,
 * because an unmounted mountpoint is a present-but-empty directory), re-stats
 * the exact path, and tags only on a confirmed absence.
 *
 * `claimRollbackStatement`'s own behaviour — the attempt given back, the lease
 * cleared — is asserted in `db/sqlite/repos/stage-writeback.test.ts`. What is
 * asserted here is the decision in front of it, which the repository cannot
 * see: whether to reach for the tag at all.
 *
 * The library roots come from the `folders` table rather than from a test-only
 * override, because that is where the runner reads them from now. One case the
 * Mongo suite covered has gone with that move: "the location names a library
 * that is not registered" is unreachable here, because `asset_locations` holds
 * a foreign key into `folders`. The runner still refuses to tag in that case —
 * the guard is unchanged — but the database can no longer produce it, and a
 * test that has to break the schema to reach a branch is asserting the schema's
 * absence rather than the runner's behaviour.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { defineStage, runOnce, type StageConfig } from './run-stage.ts';

const CONFIG = { concurrency: 1, maxAttempts: 3, paused: false, last_seen_target_version: 1 };

function enoent(filename: string): Error {
  return Object.assign(new Error(`ENOENT: no such file, stat '${filename}'`), { code: 'ENOENT' });
}

/** A file-reading stage whose handler always reports the original as gone. */
function originalFileStage(name = 'exif', tagsMissingOnEnoent = true): StageConfig {
  return defineStage({
    name,
    targetVersion: 1,
    dependsOn: [],
    tagsMissingOnEnoent,
    defaults: {
      concurrency: 1,
      maxAttempts: 3,
      paused: false,
      pausedOnFirstBoot: false,
      last_seen_target_version: 0,
    },
    handler: async () => {
      throw enoent('gone.raw');
    },
  }) as StageConfig;
}

function locationRow(db: Database, assetId: string) {
  return db
    .query(`SELECT missing_since, missing_reason FROM asset_locations WHERE asset_id = ?`)
    .get(assetId) as { missing_since: string | null; missing_reason: string | null };
}

function stageRow(db: Database, assetId: string, stage: string) {
  return db
    .query(
      `SELECT version, attempts, dead, last_error FROM stage_state WHERE asset_id = ? AND stage = ?`,
    )
    .get(assetId, stage) as
    | { version: number; attempts: number; dead: number; last_error: string | null }
    | undefined;
}

// A real temporary directory stands in for the library root, with a marker file
// keeping it non-empty — an empty directory is exactly what an unmounted mount
// looks like, and the runner treats that as "the root is gone", not "the file".
let libRoot: string;
let live: LiveTestDatabase;
let libraryId: string;

beforeEach(async () => {
  libRoot = mkdtempSync(join(tmpdir(), 'maple-runstage-root-'));
  writeFileSync(join(libRoot, 'marker.txt'), 'x');
  live = await createLiveTestDatabase();
  libraryId = insertFolder(live.db, { path: libRoot });
});

afterEach(() => {
  live.close();
  rmSync(libRoot, { recursive: true, force: true });
});

/** One claimable asset whose single location names `filename` under the root. */
function seedAsset(stage: string, filename = 'gone.raw'): string {
  const assetId = insertAsset(live.db);
  insertLocation(live.db, { assetId, libraryId, path: '', filename });
  live.db.run(`INSERT INTO stage_state (asset_id, stage) VALUES (?, ?)`, [assetId, stage]);
  return assetId;
}

describe('a confirmed missing original', () => {
  it('tags the location and rolls the claim back untouched', async () => {
    const assetId = seedAsset('exif');

    await runOnce(originalFileStage(), CONFIG);

    const location = locationRow(live.db, assetId);
    expect(typeof location.missing_since).toBe('string');
    // Structured provenance: which writer tagged, and from which stage (#2171).
    expect(location.missing_reason).toBe('stage-enoent:exif');
    // The claim's provisional attempt is given back: a missing original was
    // never genuinely attempted, and the stage is left unadvanced so the reaper
    // recovering the file makes it claimable again immediately.
    expect(stageRow(live.db, assetId, 'exif')).toMatchObject({
      attempts: 0,
      version: 0,
      dead: 0,
    });
  });

  it('keeps the first detection when a later tick reaches the same conclusion', async () => {
    const assetId = seedAsset('exif');
    await runOnce(originalFileStage(), CONFIG);
    const firstTag = locationRow(live.db, assetId).missing_since;

    // The tagged location is now non-live, so the asset drops out of every
    // stage's claim — but the guard is what the reaper's age window depends on,
    // so assert the timestamp is unchanged regardless of who could claim it.
    await runOnce(originalFileStage(), CONFIG);

    expect(locationRow(live.db, assetId).missing_since).toBe(firstTag);
  });

  it('parks the asset out of the claim entirely once its only location is gone', async () => {
    const assetId = seedAsset('exif');
    await runOnce(originalFileStage(), CONFIG);

    // A second stage, with a handler that would succeed, still claims nothing.
    const other = defineStage({
      ...originalFileStage('thumb'),
      handler: async () => ({ wrote: true }),
    }) as StageConfig;
    live.db.run(`INSERT INTO stage_state (asset_id, stage) VALUES (?, 'thumb')`, [assetId]);

    expect(await runOnce(other, CONFIG)).toBe(0);
    expect(stageRow(live.db, assetId, 'thumb')).toMatchObject({ version: 0, attempts: 0 });
  });
});

describe('an ENOENT the runner refuses to believe', () => {
  it('does not tag a file that is present on disk', async () => {
    // A race — the file moved and came back, or a network share served a stale
    // negative. The rollback leaves the row claimable for a clean retry.
    writeFileSync(join(libRoot, 'gone.raw'), 'x');
    const assetId = seedAsset('exif');

    await runOnce(originalFileStage(), CONFIG);

    expect(locationRow(live.db, assetId).missing_since).toBeNull();
    expect(stageRow(live.db, assetId, 'exif')?.attempts).toBe(0);
  });

  it('does not tag when the library root is an empty mountpoint', async () => {
    // An unmounted bind/network mount is a present-but-EMPTY directory: every
    // child path ENOENTs. That is evidence the ROOT is gone, not the file.
    rmSync(join(libRoot, 'marker.txt'));
    const assetId = seedAsset('exif');

    await runOnce(originalFileStage(), CONFIG);

    expect(locationRow(live.db, assetId).missing_since).toBeNull();
  });

  it('does not tag a non-ENOENT failure', async () => {
    const assetId = seedAsset('exif', 'bad.raw');
    const stage = defineStage({
      ...originalFileStage(),
      handler: async () => {
        throw new Error('decode blew up');
      },
    }) as StageConfig;

    await runOnce(stage, CONFIG);

    expect(locationRow(live.db, assetId).missing_since).toBeNull();
    // An ordinary failed attempt, not the rollback path.
    expect(stageRow(live.db, assetId, 'exif')).toMatchObject({
      attempts: 1,
      last_error: 'decode blew up',
    });
  });

  it('does not tag for a stage that never reads the original', async () => {
    const assetId = seedAsset('meili');

    await runOnce(originalFileStage('meili', false), CONFIG);

    expect(locationRow(live.db, assetId).missing_since).toBeNull();
    expect(stageRow(live.db, assetId, 'meili')?.attempts).toBe(1);
  });
});

/**
 * A `no-resolvable-location` skip is not a missing-original report.
 *
 * The legacy orphan-tagging branch is gone: an asset whose every location is
 * non-live is parked by the claim itself, so a file-touching stage never sees
 * it, and whatever made it non-live already left a `missing_since` for the
 * reaper. A skip on a still-claimable asset records the reason and resets the
 * attempt count — it tags nothing.
 */
describe('a no-resolvable-location skip', () => {
  it('records the reason and leaves the location alone', async () => {
    const assetId = seedAsset('exif', 'live.raw');
    const stage = defineStage({
      ...originalFileStage(),
      handler: async () => ({ skip: 'no-resolvable-location' }),
    }) as StageConfig;

    await runOnce(stage, CONFIG);

    expect(locationRow(live.db, assetId).missing_since).toBeNull();
    expect(stageRow(live.db, assetId, 'exif')).toMatchObject({
      version: 1,
      attempts: 0,
      last_error: 'skip: no-resolvable-location',
    });
  });
});
