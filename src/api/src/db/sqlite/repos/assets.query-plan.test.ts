/**
 * Query plans, asserted rather than assumed.
 *
 * The performance case for this port is a claim about *which index answers
 * which query*, and a timing on a small test database cannot check that — a
 * table scan of twenty rows is fast. `EXPLAIN QUERY PLAN` can, and it fails
 * the moment a predicate is paraphrased into a form that loses a partial
 * index, which is the specific way this schema breaks silently.
 *
 * Three shapes are pinned here.
 *
 *  1. The backup-sidecar fallback is a seek on `asset_phasset_links`, the
 *     index that does not exist on Mongo at all. This is the ticket's exit
 *     criterion "demonstrated by a query plan, not by timing alone".
 *  2. The list query walks the ordered partial index and never touches
 *     `asset_locations` — assets leads, locations are probed afterwards for
 *     exactly the ids the page returned.
 *  3. Every lookup by key is a seek, not a scan.
 */

import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import {
  ASSET_CORE_BY_ID_SQL,
  ASSET_ID_BY_ADDRESS_SQL,
  ASSET_ID_BY_MAPLE_ID_SQL,
  ASSET_ID_BY_PHASSET_LINK_SQL,
  detailByAssetIdsSql,
  facesByAssetIdsSql,
  listItemsSql,
  locationsByAssetIdsSql,
} from './assets.sql.ts';
import { createTestDatabase } from '../test-sqlite.test-helpers.ts';
import type { SqlValue } from '../migrate.ts';

/** The planner's own description of how it will run a statement. */
function plan(db: Database, sql: string, ...params: SqlValue[]): string {
  const rows = db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>;
  return rows.map((row) => row.detail).join('\n');
}

describe('the backup-sidecar lookups are keyed', () => {
  test('the phasset fallback seeks the two-column index, and leads with it', async () => {
    using handle = await createTestDatabase();
    const detail = plan(handle.db, ASSET_ID_BY_PHASSET_LINK_SQL, 'device-a', 'local-1', 'lib');

    // The index that replaces a 288,000-document collection scan.
    expect(detail).toContain(
      'SEARCH p USING INDEX asset_phasset_links_device_local (device_id=? AND phasset_local_id=?)',
    );
    // The link table leads; the library scope is a probe per candidate, which
    // is the semi-join shape rather than a join the planner could reorder.
    expect(detail.split('\n')[0]).toContain('asset_phasset_links_device_local');
    expect(detail).toContain('EXISTS');
    expect(detail).not.toContain('SCAN');
  });

  test('the maple_id primary lookup seeks the partial unique index', async () => {
    using handle = await createTestDatabase();
    const detail = plan(handle.db, ASSET_ID_BY_MAPLE_ID_SQL, 'content-1', 'lib');
    expect(detail).toContain('SEARCH a USING INDEX assets_maple_id (maple_id=?)');
    expect(detail).not.toContain('SCAN');
  });
});

describe('the list query keeps assets as the outer loop', () => {
  test('walks the ordered partial index with no sort', async () => {
    using handle = await createTestDatabase();
    const detail = plan(handle.db, listItemsSql([], true), 1000);
    expect(detail).toContain('USING INDEX assets_live_captured');
    expect(detail).not.toContain('TEMP B-TREE');
  });

  test('keeps that plan when the optional filters are present', async () => {
    using handle = await createTestDatabase();
    // Without the INDEXED BY directive the planner takes assets_live here and
    // sorts the whole live set to satisfy the ORDER BY.
    const detail = plan(handle.db, listItemsSql(['has_xmp = ?', 'rating >= ?'], true), 1, 3, 1000);
    expect(detail).toContain('USING INDEX assets_live_captured');
    expect(detail).not.toContain('TEMP B-TREE');
  });

  test('turns a captured_after filter into a range on the same index', async () => {
    using handle = await createTestDatabase();
    const detail = plan(handle.db, listItemsSql(['captured_at > ?'], true), '2026-01-01', 1000);
    expect(detail).toContain('SEARCH assets USING INDEX assets_live_captured (captured_at>?)');
  });

  test('never joins asset_locations — the locations are fetched afterwards, by key', async () => {
    using handle = await createTestDatabase();
    expect(plan(handle.db, listItemsSql([], true), 1000)).not.toContain('asset_locations');
    expect(plan(handle.db, locationsByAssetIdsSql(3), 'a', 'b', 'c')).toContain(
      'SEARCH asset_locations',
    );
  });
});

describe('every by-id read is a seek', () => {
  test('the asset row, its locations, its faces and its detail payload', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    expect(plan(db, ASSET_CORE_BY_ID_SQL, 'id')).toContain('SEARCH assets USING INDEX');
    expect(plan(db, locationsByAssetIdsSql(1), 'id')).toContain(
      'SEARCH asset_locations USING INDEX',
    );
    expect(plan(db, facesByAssetIdsSql(1), 'id')).toContain('SEARCH f USING INDEX');
    expect(plan(db, detailByAssetIdsSql(1), 'id')).toContain('SEARCH asset_detail USING');
  });

  test('an address resolves through the unique (library, path, filename) index', async () => {
    using handle = await createTestDatabase();
    expect(plan(handle.db, ASSET_ID_BY_ADDRESS_SQL, 'lib', 'dir', 'file.dng')).toContain(
      'SEARCH asset_locations USING INDEX asset_locations_lib_path_name (library_id=? AND path=? AND filename=?)',
    );
  });
});
