/**
 * Two claimers, one stage, no asset handed to both — the property the whole
 * `UPDATE`-shaped claim exists for (#3748).
 *
 * ## What is being proven, and what would be theatre
 *
 * The weak version of this test seeds a few assets, calls the claim twice in
 * `Promise.all`, and asserts the results do not overlap. It passes whether or
 * not the exclusion works, because two sequential calls do not overlap either.
 *
 * So each case here carries its own control. The candidate scan is shown
 * handing the *same* ids to both callers — that is the state the claim has to
 * survive, and it is what makes the claim's re-check the mechanism rather than
 * the scan's timing. Then the same interleaving is run through the real claim
 * and the results are disjoint. A claim that dropped the transaction's
 * re-check would pass the first assertion and fail the second.
 *
 * ## Why a file-backed database and two connections
 *
 * On Mongo the runner's exclusion is an in-process `Set` of ids it excludes
 * from its next filter. That protects one process from itself and nothing from
 * a second one — a second API process, an importer, or the same process across
 * a restart. Here the exclusion is a lease in the row, so it holds across
 * connections, and the only way to demonstrate that is with two of them
 * against the same file. An in-memory database is private to the connection
 * that opened it, so it could not express this test at all.
 *
 * Test shape note — round trips first, assertions afterwards, because Bun
 * 1.4.3 can drop a message when an `expect()` runs between two round trips.
 */

import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { claimStageBatch, type StageClaimRequest } from './stage-claim.ts';
import { seedClaimableAssets, stageRow } from './stage-runtime.test-helpers.ts';
import {
  createTestDatabase,
  testSqliteDb,
  type TestDatabase,
} from '../sqlite/test-sqlite.test-helpers.ts';
import { SCHEMA_PRAGMAS } from '../sqlite/ddl/index.ts';
import { stageClaimCandidatesSql } from './stage-runtime.sql.ts';

const STAGE = 'thumb';
const ASSETS = 20;

const openHandles: Array<{ close(): void }> = [];

afterEach(() => {
  for (const handle of openHandles.splice(0)) handle.close();
});

/** A second, independent connection to the same database file. */
function secondConnection(handle: TestDatabase): Database {
  const db = new Database(handle.path);
  for (const pragma of SCHEMA_PRAGMAS) db.exec(pragma);
  openHandles.push(db);
  return db;
}

function request(overrides: Partial<StageClaimRequest> = {}): StageClaimRequest {
  return {
    stage: STAGE,
    targetVersion: 1,
    dependsOn: [],
    limit: ASSETS,
    maxAttempts: 5,
    ...overrides,
  };
}

test('the candidate scan alone hands the same assets to both claimers', async () => {
  using handle = await createTestDatabase('file');
  const second = secondConnection(handle);
  seedClaimableAssets(handle.db, STAGE, ASSETS);
  const sql = stageClaimCandidatesSql(0, 0);
  const params = [STAGE, 1, new Date().toISOString(), ASSETS];

  const a = handle.db.query(sql).all(...(params as never[])) as Array<{ asset_id: string }>;
  const b = second.query(sql).all(...(params as never[])) as Array<{ asset_id: string }>;

  // The control. The scan is a plain read with no side effect, so it cannot be
  // what keeps two claimers apart — both see the whole backlog. Everything the
  // next test proves has to come from the claim itself.
  expect(a.map((row) => row.asset_id)).toEqual(b.map((row) => row.asset_id));
  expect(a).toHaveLength(ASSETS);
});

test('two interleaved claimers split the backlog with no asset in both', async () => {
  using handle = await createTestDatabase('file');
  const first = testSqliteDb(handle.db);
  const secondDb = testSqliteDb(secondConnection(handle));
  const expected = seedClaimableAssets(handle.db, STAGE, ASSETS);

  // Started together so each one's candidate scan resolves before either one's
  // claim transaction runs — the interleaving the previous test showed, now
  // going through the real claim.
  const [a, b] = await Promise.all([
    claimStageBatch(request(), first),
    claimStageBatch(request(), secondDb),
  ]);

  const claimedA = a.claimed.map((row) => row.asset_id);
  const claimedB = b.claimed.map((row) => row.asset_id);
  const overlap = claimedA.filter((id) => claimedB.includes(id));
  expect(overlap).toEqual([]);
  // Nothing is lost either: every asset went to exactly one of them.
  expect([...claimedA, ...claimedB].sort()).toEqual([...expected].sort());
  // And the loser learns it lost, rather than silently returning a short batch.
  expect(a.contended + b.contended).toBe(ASSETS);
});

test('the losing claimer does not spend a second attempt on a contended row', async () => {
  using handle = await createTestDatabase('file');
  const first = testSqliteDb(handle.db);
  const secondDb = testSqliteDb(secondConnection(handle));
  const assets = seedClaimableAssets(handle.db, STAGE, ASSETS);

  await Promise.all([claimStageBatch(request(), first), claimStageBatch(request(), secondDb)]);

  // Exactly one attempt per asset. A claim that fell back to a bare UPDATE
  // without the gates would show 2 here, and the attempt budget — the only
  // thing standing between a poison asset and an infinite retry loop — would
  // be consumed twice as fast as the runner believes.
  const attempts = assets.map((id) => stageRow(handle.db, id, STAGE)?.attempts);
  expect(attempts).toEqual(assets.map(() => 1));
});

test('eight concurrent claimers still hand out each asset once', async () => {
  using handle = await createTestDatabase('file');
  const claimers = [
    testSqliteDb(handle.db),
    ...Array.from({ length: 7 }, () => testSqliteDb(secondConnection(handle))),
  ];
  const assets = seedClaimableAssets(handle.db, STAGE, ASSETS);

  const outcomes = await Promise.all(claimers.map((db) => claimStageBatch(request(), db)));

  const everything = outcomes.flatMap((outcome) => outcome.claimed.map((row) => row.asset_id));
  expect(everything.sort()).toEqual([...assets].sort());
  expect(new Set(everything).size).toBe(ASSETS);
});

test('a lease held by one claimer survives the connection that took it', async () => {
  using handle = await createTestDatabase('file');
  const assets = seedClaimableAssets(handle.db, STAGE, 1);
  const holder = secondConnection(handle);
  const now = new Date('2026-06-01T12:00:00.000Z');

  await claimStageBatch(request({ now, leaseMs: 60_000 }), testSqliteDb(holder));
  // The claimer goes away entirely — a crashed worker, or a restarted process.
  holder.close();
  openHandles.pop();
  const afterDeath = await claimStageBatch(
    request({ now: new Date('2026-06-01T12:00:30.000Z'), leaseMs: 60_000 }),
    testSqliteDb(handle.db),
  );
  const afterLease = await claimStageBatch(
    request({ now: new Date('2026-06-01T12:02:00.000Z'), leaseMs: 60_000 }),
    testSqliteDb(handle.db),
  );

  // This is the difference from the in-process `Set` the Mongo runner uses:
  // the claim is in the row, so it outlives the claimer, and it expires on its
  // own rather than needing something to notice the death.
  expect(afterDeath.claimed).toEqual([]);
  expect(afterLease.claimed.map((row) => row.asset_id)).toEqual(assets);
});
