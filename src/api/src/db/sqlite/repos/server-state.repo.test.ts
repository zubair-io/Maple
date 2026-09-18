/**
 * `server_state` behaviour: the two singletons whose whole point is what
 * happens when several callers arrive at once.
 *
 * The cases that matter are the races. Two boots must agree on one JWT secret
 * and exactly one of them must report having minted it; two first-time
 * registrations must produce exactly one owner. Both are exercised by letting
 * the two callers genuinely interleave — each one reads before either writes,
 * which is the interleaving the Mongo version needed a duplicate-key catch to
 * survive.
 */

import { describe, expect, test } from 'bun:test';
import { createTestDatabase, run } from '../test-sqlite.test-helpers.ts';
import { newObjectIdHex } from '../object-id.ts';
import { testSqliteDb } from './assets.test-helpers.ts';
import {
  JWT_SECRET_DOC_ID,
  OWNER_CLAIM_ID,
  backfillOwnershipClaim,
  getOrCreateJwtSecret,
  releaseOwnershipClaim,
  tryClaimOwnership,
} from './server-state.repo.ts';
import type { Database } from 'bun:sqlite';

function insertUser(db: Database): void {
  run(
    db,
    `INSERT INTO users (id, email, role, created_at) VALUES (?, ?, 'owner', ?)`,
    newObjectIdHex(),
    'owner@example.test',
    new Date().toISOString(),
  );
}

function claimRows(db: Database): number {
  const row = db
    .query(`SELECT count(*) AS n FROM server_state WHERE id = ?`)
    .get(OWNER_CLAIM_ID) as { n: number } | null;
  return row?.n ?? 0;
}

describe('getOrCreateJwtSecret', () => {
  test('mints the secret on first call and reports having done so', async () => {
    using handle = await createTestDatabase();
    const first = await getOrCreateJwtSecret(testSqliteDb(handle.db));
    expect(first.created).toBe(true);
    expect(first.secret.length).toBeGreaterThan(0);
  });

  test('a later call reads the stored secret and does not claim to have minted it', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const first = await getOrCreateJwtSecret(db);
    const second = await getOrCreateJwtSecret(db);
    expect(second.secret).toBe(first.secret);
    expect(second.created).toBe(false);
  });

  test('two concurrent boots converge on one secret, and only one mints it', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    // Both callers read the empty row before either writes — the interleaving
    // the conditional upsert exists to survive.
    const [a, b] = await Promise.all([getOrCreateJwtSecret(db), getOrCreateJwtSecret(db)]);
    expect(a.secret).toBe(b.secret);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
  });

  test('fills a row that exists without a value', async () => {
    using handle = await createTestDatabase();
    // A partial prior write. The Mongo `$setOnInsert` version skipped this row
    // silently and handed back an unpersisted candidate, so every process
    // signed with a different key.
    run(handle.db, `INSERT INTO server_state (id) VALUES (?)`, JWT_SECRET_DOC_ID);
    const db = testSqliteDb(handle.db);
    const minted = await getOrCreateJwtSecret(db);
    expect(minted.created).toBe(true);
    expect((await getOrCreateJwtSecret(db)).secret).toBe(minted.secret);
  });

  test('fills a row whose value is the empty string', async () => {
    using handle = await createTestDatabase();
    // The other half-written row. `readSecret` counts `''` as no secret, so the
    // upsert's guard has to count it too — otherwise the read says "mint one",
    // the guarded update matches nothing, the re-read says "still nothing", and
    // the function throws. The row never changes, so that throw repeats on
    // every boot for good and no token can ever be signed again.
    run(handle.db, `INSERT INTO server_state (id, value) VALUES (?, '')`, JWT_SECRET_DOC_ID);
    const db = testSqliteDb(handle.db);
    const minted = await getOrCreateJwtSecret(db);
    expect(minted.created).toBe(true);
    expect(minted.secret.length).toBeGreaterThan(0);
    // And it persisted, so the next boot signs with the same key.
    expect(await getOrCreateJwtSecret(db)).toEqual({ secret: minted.secret, created: false });
  });

  test('never overwrites a secret that is already there', async () => {
    using handle = await createTestDatabase();
    run(
      handle.db,
      `INSERT INTO server_state (id, value) VALUES (?, 'pre-existing')`,
      JWT_SECRET_DOC_ID,
    );
    expect(await getOrCreateJwtSecret(testSqliteDb(handle.db))).toEqual({
      secret: 'pre-existing',
      created: false,
    });
  });
});

describe('tryClaimOwnership', () => {
  test('the first caller wins', async () => {
    using handle = await createTestDatabase();
    expect(await tryClaimOwnership(testSqliteDb(handle.db))).toBe(true);
  });

  test('a second caller loses rather than becoming a second owner', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await tryClaimOwnership(db);
    expect(await tryClaimOwnership(db)).toBe(false);
  });

  test('exactly one of four concurrent first registrations wins', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const results = await Promise.all([
      tryClaimOwnership(db),
      tryClaimOwnership(db),
      tryClaimOwnership(db),
      tryClaimOwnership(db),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(claimRows(handle.db)).toBe(1);
  });
});

describe('releaseOwnershipClaim', () => {
  test('lets the server be claimed again after a failed registration', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await tryClaimOwnership(db);
    await releaseOwnershipClaim(db);
    expect(await tryClaimOwnership(db)).toBe(true);
  });
});

describe('backfillOwnershipClaim', () => {
  test('leaves a genuinely fresh install unclaimed', async () => {
    using handle = await createTestDatabase();
    await backfillOwnershipClaim(testSqliteDb(handle.db));
    expect(claimRows(handle.db)).toBe(0);
  });

  test('plants the sentinel when an owner predates it', async () => {
    using handle = await createTestDatabase();
    insertUser(handle.db);
    await backfillOwnershipClaim(testSqliteDb(handle.db));
    // Without this the next invited registration would win the free sentinel
    // and escalate itself to owner.
    expect(claimRows(handle.db)).toBe(1);
  });

  test('short-circuits once the sentinel is present', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    insertUser(handle.db);
    await backfillOwnershipClaim(db);
    await backfillOwnershipClaim(db);
    expect(claimRows(handle.db)).toBe(1);
  });
});
