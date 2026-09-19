/**
 * What happens to a claim while a handler holds it — the half of the claim
 * protocol that only shows up once time passes (#3748).
 *
 * The concurrency suite next door proves two callers never get the same asset
 * at the instant of claiming. That is a different question from this one, and a
 * test that only exercises that instant passes under the bug this file is
 * about: a lease is granted for fifteen minutes, `transcribe` is documented as
 * running "the length of a video", and what the runtime does between the grant
 * and the writeback is what decides whether two handlers end up on one asset.
 *
 * So every case here advances a clock across a lease boundary, or mutates a
 * gate in the window the un-locked candidate scan leaves open, rather than
 * interleaving two callers.
 */

import { describe, expect, test } from 'bun:test';
import { claimStageBatch, renewStageLease } from './stage-claim.ts';
import { stageResultStatements } from './stage-writeback.ts';
import { seedClaimableAsset, stageRow } from './stage-runtime.test-helpers.ts';
import { createTestDatabase, testSqliteDb } from '../sqlite/test-sqlite.test-helpers.ts';

const STAGE = 'thumb';

/** The request every test starts from: target version 2, no dependencies. */
function request(overrides: Partial<Parameters<typeof claimStageBatch>[0]> = {}) {
  return {
    stage: STAGE,
    targetVersion: 2,
    dependsOn: [],
    limit: 50,
    maxAttempts: 3,
    ...overrides,
  };
}

describe('claimStageBatch — the lease across a long handler', () => {
  const LEASE_MS = 15 * 60_000;
  const T0 = new Date('2026-06-01T12:00:00.000Z');
  const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);

  test('a handler that outruns its lease loses the asset, and cannot release the new claim', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const assetId = seedClaimableAsset(handle.db, { stages: { [STAGE]: {} } });

    // t+0: the first worker claims and starts a 20-minute transcode.
    const first = await claimStageBatch(request({ now: T0, leaseMs: LEASE_MS }), db);
    // t+15: the lease has elapsed, so a second worker takes the same asset.
    const second = await claimStageBatch(request({ now: at(16), leaseMs: LEASE_MS }), db);
    // t+20: the first worker finally finishes and writes back.
    await db.transaction(
      stageResultStatements(
        {
          target: {
            assetId,
            stage: STAGE,
            targetVersion: 2,
            lease: first.claimed[0]?.next_attempt_at ?? '',
          },
          attemptNo: 1,
          maxAttempts: 3,
          dependsOn: [],
          at: at(20),
        },
        { wrote: true },
      ),
    );
    // t+21: could a third worker take an asset two handlers already ran?
    const third = await claimStageBatch(request({ now: at(21), leaseMs: LEASE_MS }), db);

    expect(first.claimed).toHaveLength(1);
    expect(second.claimed).toHaveLength(1);
    // The late writeback is fenced out: the row still belongs to the second
    // claimer, still below target, with its lease intact.
    expect(third.claimed).toEqual([]);
    expect(stageRow(handle.db, assetId, STAGE)).toMatchObject({
      version: 0,
      attempts: 2,
      next_attempt_at: second.claimed[0]?.next_attempt_at,
    });
  });

  test('renewing keeps a slow handler’s claim, so nothing else can take the asset', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const assetId = seedClaimableAsset(handle.db, { stages: { [STAGE]: {} } });

    const claimed = await claimStageBatch(request({ now: T0, leaseMs: LEASE_MS }), db);
    // The handler heartbeats at t+14, a minute before the lease would lapse.
    const renewed = await renewStageLease(
      { assetId, stage: STAGE, lease: claimed.claimed[0]?.next_attempt_at ?? '' },
      { now: at(14), leaseMs: LEASE_MS },
      db,
    );
    const contender = await claimStageBatch(request({ now: at(16), leaseMs: LEASE_MS }), db);
    await db.transaction(
      stageResultStatements(
        {
          target: { assetId, stage: STAGE, targetVersion: 2, lease: renewed ?? '' },
          attemptNo: 1,
          maxAttempts: 3,
          dependsOn: [],
          at: at(20),
        },
        { wrote: true },
      ),
    );

    // Renewal is what stops fencing from making a legitimately slow stage
    // strictly worse off: without it `transcribe` could never record a success.
    expect(renewed).toBe(at(29).toISOString());
    expect(contender.claimed).toEqual([]);
    expect(stageRow(handle.db, assetId, STAGE)).toMatchObject({
      version: 2,
      attempts: 0,
      next_attempt_at: null,
    });
  });

  test('a renewal after the asset was re-claimed returns null and changes nothing', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const assetId = seedClaimableAsset(handle.db, { stages: { [STAGE]: {} } });

    const first = await claimStageBatch(request({ now: T0, leaseMs: LEASE_MS }), db);
    const second = await claimStageBatch(request({ now: at(16), leaseMs: LEASE_MS }), db);
    const renewed = await renewStageLease(
      { assetId, stage: STAGE, lease: first.claimed[0]?.next_attempt_at ?? '' },
      { now: at(17), leaseMs: LEASE_MS },
      db,
    );

    // This is how a slow handler learns to drop its work rather than write it:
    // a renewal that matches nothing means the claim is already somebody
    // else's, and resurrecting it would put two writers on the row.
    expect(renewed).toBeNull();
    expect(stageRow(handle.db, assetId, STAGE)?.next_attempt_at).toBe(
      second.claimed[0]?.next_attempt_at ?? null,
    );
  });
});

describe('claimStageBatch — the gates re-checked at claim time', () => {
  /** Scan, mutate a gate, then claim with the stale candidate list in hand. */
  async function claimStaleCandidates(
    handle: Awaited<ReturnType<typeof createTestDatabase>>,
    mutate: () => void,
    overrides: Partial<Parameters<typeof claimStageBatch>[0]> = {},
  ): Promise<number> {
    const db = testSqliteDb(handle.db);
    const scanning = {
      ...db,
      read: async <T>(sql: string, params?: Parameters<typeof db.read>[1]): Promise<T[]> => {
        const rows = await db.read<T>(sql, params);
        mutate();
        return rows;
      },
    };
    const outcome = await claimStageBatch(request(overrides), scanning);
    return outcome.claimed.length;
  }

  test('an asset soft-deleted between the scan and the claim is not dispatched', async () => {
    using handle = await createTestDatabase();
    const assetId = seedClaimableAsset(handle.db, { stages: { [STAGE]: {} } });

    const claimed = await claimStaleCandidates(handle, () => {
      handle.db.run(`UPDATE assets SET deleted_at = ? WHERE id = ?`, ['2026-06-01', assetId]);
    });

    // Handing a trashed asset to a handler is not just wasted work: a
    // file-reading stage would read bytes the user has asked to delete.
    expect(claimed).toBe(0);
    expect(stageRow(handle.db, assetId, STAGE)?.attempts).toBe(0);
  });

  test('an asset tagged damaged between the scan and the claim is not dispatched', async () => {
    using handle = await createTestDatabase();
    const assetId = seedClaimableAsset(handle.db, { stages: { [STAGE]: {} } });

    const claimed = await claimStaleCandidates(handle, () => {
      handle.db.run(`UPDATE assets SET damaged_since = ? WHERE id = ?`, ['2026-06-01', assetId]);
    });

    expect(claimed).toBe(0);
  });

  test('a dependency invalidated between the scan and the claim parks the asset', async () => {
    using handle = await createTestDatabase();
    const assetId = seedClaimableAsset(handle.db, {
      stages: { [STAGE]: {}, preview: { version: 1 } },
    });

    const claimed = await claimStaleCandidates(
      handle,
      () => {
        handle.db.run(`UPDATE stage_state SET version = 0 WHERE asset_id = ? AND stage = ?`, [
          assetId,
          'preview',
        ]);
      },
      { dependsOn: [{ name: 'preview', minVersion: 1 }] },
    );

    // The upstream artefact this stage was about to read no longer exists.
    expect(claimed).toBe(0);
  });
});
