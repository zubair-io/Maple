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
 * 2026-09-18 and again on 2026-09-19, when it held 335,419 assets. Both
 * readings returned the same 39 names.
 *
 * It is longer than the set any test fixture seeds because an install
 * accumulates: `indexer_config`, `indexer_dead_letter` and `indexer_queue`
 * belong to a pipeline retired in 2026, `video_geo_backfill_audit` to a
 * one-shot migration finished in August. A fresh install would carry none of
 * them, and a cutover has to decide about all of them.
 *
 * `meilisearch_backfill_failures` is not here and that is the inventory doing
 * its job rather than an omission: the backfill writes that collection only
 * when a row fails, no row ever has on this install, and MongoDB does not
 * create a collection nothing has written to. It has a plan all the same,
 * because an install where one HAS failed is the install that needs it.
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

  /**
   * The three #3797 recovered, pinned as imported rather than merely covered.
   *
   * `uncoveredCollections` is satisfied by either answer, so the case above
   * would keep passing if one of these were quietly moved back to a one-line
   * skip — which is exactly how all three were lost the first time. This asks
   * the stronger question: is there a plan whose source is this collection.
   */
  test('carries the certificate, the resume points and the search cursor by plan', () => {
    const planned = new Set(IMPORT_PLAN.map((entry) => entry.source));
    for (const collection of [
      'managed_certificates',
      'indexer_checkpoints',
      'meilisearch_backfill_state',
      'meilisearch_backfill_failures',
    ]) {
      expect(planned.has(collection)).toBe(true);
      expect(SKIPPED_COLLECTIONS[collection]).toBeUndefined();
    }
  });

  /** The companion that stays behind, for the reason `coverage.ts` gives. */
  test('leaves the backfill lease behind, and says so rather than omitting it', () => {
    expect(IMPORT_PLAN.some((entry) => entry.source === 'meilisearch_backfill_leases')).toBe(false);
    expect(SKIPPED_COLLECTIONS['meilisearch_backfill_leases']).toBeDefined();
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
