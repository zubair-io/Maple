/**
 * What a real install holds, checked against what the plan accounts for.
 *
 * The coverage check was already tested, and it passed while two collections in
 * the owner's production library had neither a plan nor a skip. It passed
 * because every case handed `uncoveredCollections` a list of collection names
 * written in this repository, from the plan — so a collection the plan had
 * never heard of was one the test had never heard of either, and the two agreed
 * with each other right up to the first boot against real data. A guard that
 * can only fire at 3am against somebody's live library is the weakest useful
 * form of that guard.
 *
 * What was missing is a record of what an install actually carries, which no
 * amount of reading this repository produces. `indexer_config` and
 * `indexer_dead_letter` are written by the bounded-channel indexer, which has
 * since been deleted: they appear in no `db.collection(…)` call site, in no
 * schema, and in nothing the plan was derived from — but they are still sitting
 * in every database that ever ran it.
 *
 * {@link LIVE_INSTALL_COLLECTIONS} is that record. It is an observation, not a
 * restatement of the plan, and it is only worth anything while it stays one:
 * entries are added by reading a real database, never by copying the list the
 * plan already has. Otherwise this file grows into the same tautology it exists
 * to break.
 */

import { describe, expect, test } from 'bun:test';
import type { Db } from 'mongodb';
import { IMPORT_PLAN, SKIPPED_COLLECTIONS, uncoveredCollections } from './index.ts';

/**
 * Every collection in the owner's production library, read off it on
 * 2026-09-18, when it held 335,419 assets.
 *
 * It is longer than the set any test fixture seeds because an install
 * accumulates: `indexer_config`, `indexer_dead_letter` and `indexer_queue`
 * belong to a pipeline retired in 2026, `video_geo_backfill_audit` to a
 * one-shot migration finished in August. A fresh install would carry none of
 * them, and a cutover has to decide about all of them.
 */
const LIVE_INSTALL_COLLECTIONS = [
  'apns_device_tokens',
  'app_settings',
  'asset_changes',
  'assets',
  'backup_sessions',
  'challenges',
  'credentials',
  'discover_frontier',
  'folders',
  'generated_searches',
  'geocode_cache',
  'image_access_tokens',
  'import_files',
  'imports',
  'indexer_checkpoints',
  'indexer_config',
  'indexer_dead_letter',
  'indexer_queue',
  'invites',
  'jobs',
  'lan_handoff_codes',
  'managed_certificates',
  'meilisearch_backfill_leases',
  'meilisearch_backfill_state',
  'migrations',
  'mirror_queue',
  'native_auth_codes',
  'people',
  'person_merge_dismissals',
  'presets',
  'refresh_tokens',
  'server_state',
  'service_api_keys',
  'system.profile',
  'upload_sessions',
  'users',
  'video_geo_backfill_audit',
  'worker_config',
  'worker_status',
] as const;

/**
 * A `Db` that answers the one question the coverage check asks it.
 *
 * A stub rather than a server, so this runs everywhere the suite runs: the
 * check reads a list of names and subtracts, and a real MongoDB would only add
 * a way for the test to skip-pass on a machine that has none.
 */
function dbWithCollections(names: readonly string[]): Db {
  return {
    listCollections: () => ({
      toArray: async () => names.map((name) => ({ name })),
    }),
  } as unknown as Db;
}

describe('a live install', () => {
  test('holds no collection the plan neither imports nor declares skipped', async () => {
    const db = dbWithCollections(LIVE_INSTALL_COLLECTIONS);
    expect(await uncoveredCollections(db, IMPORT_PLAN)).toEqual([]);
  });

  test('still surfaces one nobody has decided about', async () => {
    const db = dbWithCollections([...LIVE_INSTALL_COLLECTIONS, 'indexer_notes']);
    expect(await uncoveredCollections(db, IMPORT_PLAN)).toEqual(['indexer_notes']);
  });

  test("leaves MongoDB's own bookkeeping out of the reckoning", async () => {
    // `system.profile` is in the inventory and in no list here, so the only
    // reason the first case passes is the internal-name filter. This says so.
    expect(SKIPPED_COLLECTIONS['system.profile']).toBeUndefined();
    expect(await uncoveredCollections(dbWithCollections(['system.profile']), IMPORT_PLAN)).toEqual(
      [],
    );
  });
});
