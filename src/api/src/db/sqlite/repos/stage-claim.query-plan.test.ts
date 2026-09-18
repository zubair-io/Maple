/**
 * The claim's query plan, asserted rather than assumed.
 *
 * The whole case for this port is a claim about which index answers the claim
 * scan, and a timing on a twenty-row test database cannot check it — a table
 * scan of twenty rows is fast. `EXPLAIN QUERY PLAN` can, and it fails the
 * moment a predicate is paraphrased into a form that loses an index, which is
 * the specific way this schema breaks silently.
 *
 * Three shapes are pinned.
 *
 *  1. The candidate scan uses `stage_claim` and nothing else leads. That index
 *     is `(stage, version, dead, next_attempt_at, asset_id)` and it does not
 *     grow with the stage list, which is the 24-indexes-to-2 argument.
 *  2. `ORDER BY version` costs no sort. It is the index's own order once
 *     `stage` is pinned by equality, and a tie-break on `asset_id` would
 *     silently reintroduce a `TEMP B-TREE`.
 *  3. Everything about an asset stays a semi-join, so `stage_state` remains the
 *     outer loop and the scan can stop at the limit instead of the planner
 *     leading with `assets` and filtering every stage row against it.
 */

import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import {
  STAGE_CLAIM_SQL,
  STAGE_CRASH_EXHAUSTED_SQL,
  STAGE_DEAD_COUNT_SQL,
  stageClaimCandidatesSql,
  stagePendingCountSql,
} from './stage-runtime.sql.ts';
import { createTestDatabase } from '../test-sqlite.test-helpers.ts';
import type { SqlValue } from '../migrate.ts';

function plan(db: Database, sql: string, ...params: SqlValue[]): string {
  const rows = db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>;
  return rows.map((row) => row.detail).join('\n');
}

const NOW = '2026-06-01T12:00:00.000Z';

describe('the candidate scan', () => {
  test('leads with stage_claim and sorts nothing', async () => {
    using handle = await createTestDatabase();

    const detail = plan(handle.db, stageClaimCandidatesSql(0, 0), 'thumb', 2, NOW, 20);

    expect(detail.split('\n')[0]).toContain('USING INDEX stage_claim');
    // A sort here would be paid on every poll tick of every stage.
    expect(detail).not.toContain('TEMP B-TREE');
    // The stage name is an equality seek, not a filter over every stage's rows.
    expect(detail).toContain('stage=?');
  });

  test('the asset gates are a semi-join that never leads', async () => {
    using handle = await createTestDatabase();

    const detail = plan(handle.db, stageClaimCandidatesSql(0, 0), 'thumb', 2, NOW, 20);

    // `assets` is probed by key per candidate, and `EXISTS` in the detail is
    // the planner saying it stops at the first match. If it led instead, the
    // planner would walk the asset table and test 12 million stage rows
    // against it — the inner-join shape the schema doc measures at 51.3 ms
    // against 0.36 ms.
    expect(detail).toMatch(/SEARCH assets EXISTS USING INDEX \w+ \(id=\?\)/);
    expect(detail.split('\n')[0]).toContain('stage_state');
    expect(detail).not.toContain('SCAN assets');
  });

  test('a dependency is a keyed probe into the same table, not a second scan', async () => {
    using handle = await createTestDatabase();

    const detail = plan(
      handle.db,
      stageClaimCandidatesSql(1, 0),
      'describe',
      7,
      NOW,
      'preview',
      1,
      20,
    );

    // `(asset_id, stage)` is the primary key of a WITHOUT ROWID table, so the
    // dependency gate is one B-tree descent per candidate.
    expect(detail).toContain('SEARCH dep EXISTS USING PRIMARY KEY (asset_id=? AND stage=?)');
    expect(detail).not.toContain('SCAN dep');
    expect(detail).not.toContain('TEMP B-TREE');
  });

  test('an in-flight exclusion and a residual do not cost the index', async () => {
    using handle = await createTestDatabase();

    const detail = plan(
      handle.db,
      stageClaimCandidatesSql(
        0,
        2,
        `EXISTS (SELECT 1 FROM assets WHERE id = stage_state.asset_id AND media_kind IN (?, ?))`,
      ),
      'transcribe',
      1,
      NOW,
      'id-a',
      'id-b',
      'video',
      'audio',
      20,
    );

    expect(detail.split('\n')[0]).toContain('USING INDEX stage_claim');
    expect(detail).not.toContain('TEMP B-TREE');
  });
});

describe('the claim and its bookkeeping', () => {
  test('taking one candidate is a primary-key seek', async () => {
    using handle = await createTestDatabase();

    const detail = plan(handle.db, STAGE_CLAIM_SQL, NOW, 'a'.repeat(24), 'thumb', 2, NOW);

    // `WITHOUT ROWID` means the row lives in the primary-key B-tree itself, so
    // this is one descent with no separate index lookup.
    expect(detail).toContain('SEARCH stage_state USING PRIMARY KEY');
    expect(detail).not.toContain('SCAN');
  });

  test('the crash-exhausted sweep shares the claim index', async () => {
    using handle = await createTestDatabase();

    const detail = plan(handle.db, STAGE_CRASH_EXHAUSTED_SQL, 'thumb', 2, NOW, 3, 20);

    expect(detail).toContain('USING INDEX stage_claim');
    expect(detail).not.toContain('TEMP B-TREE');
  });
});

describe('the persisted counts', () => {
  test('the dead count is answered by the partial index alone', async () => {
    using handle = await createTestDatabase();

    const detail = plan(handle.db, STAGE_DEAD_COUNT_SQL, 'thumb');

    // `stage_dead` is partial on `dead = 1`, so it holds only the parked rows —
    // the equivalent of twelve separate `stage_<name>_dead` indexes, as one.
    expect(detail).toContain('USING COVERING INDEX stage_dead');
  });

  test('the pending count walks stage_claim rather than the table', async () => {
    using handle = await createTestDatabase();

    const detail = plan(handle.db, stagePendingCountSql(), 'thumb', 2);

    // Covering, in fact: the count never reads a stage_state row body, because
    // every column it filters on is in the index.
    expect(detail).toContain('USING COVERING INDEX stage_claim');
    expect(detail).not.toContain('SCAN stage_state');
  });
});
