/**
 * `managed_certificates` behaviour through the repository.
 *
 * Two things here are load-bearing rather than incidental. The lease is what
 * stops two API instances driving an ACME order for the same hostname at once,
 * so `refuses a second claimer while the lease is live` is the test that pins
 * it — a claim implemented as read-then-write would pass both callers. And the
 * challenge list has to behave like `$push` / `$pull` on an array of
 * sub-documents, including `$pull`'s whole-document equality: a record that
 * shares an id with the one being forgotten but names a different zone stays.
 */

import { describe, expect, test } from 'bun:test';
import { createTestDatabase } from '../test-sqlite.test-helpers.ts';
import { testSqliteDb } from './assets.test-helpers.ts';
import {
  claimCertificateLease,
  forgetChallenge,
  readCertificateState,
  releaseCertificateLease,
  rememberChallenge,
  renewCertificateLease,
  writeCertificateState,
  type StoredCertificate,
} from './managed-certificates.repo.ts';

const CERT: StoredCertificate = {
  hostname: 'maple.local',
  key: '-----BEGIN PRIVATE KEY-----',
  cert: '-----BEGIN CERTIFICATE-----',
  not_before: 1_750_000_000_000,
  not_after: 1_757_776_000_000,
};

describe('readCertificateState', () => {
  test('returns null before anything has been written', async () => {
    using handle = await createTestDatabase();
    expect(await readCertificateState(testSqliteDb(handle.db))).toBeNull();
  });
});

describe('writeCertificateState', () => {
  test('creates the row on first write and carries the id back', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await writeCertificateState({ account_key: 'acme-account' }, db);

    const state = await readCertificateState(db);
    expect(state?._id).toBe('lan');
    expect(state?.account_key).toBe('acme-account');
    expect(state?.challenges).toEqual([]);
    expect(state?.lease_until).toBe(0);
  });

  test('leaves fields the patch does not name alone', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await writeCertificateState({ account_key: 'acme-account', retry_after: 42 }, db);
    await writeCertificateState({ retry_after: 0 }, db);

    const state = await readCertificateState(db);
    expect(state?.account_key).toBe('acme-account');
    expect(state?.retry_after).toBe(0);
  });

  test('round-trips the stored certificate', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await writeCertificateState({ certificate: CERT, attempted_revision: 'rev-7' }, db);

    const state = await readCertificateState(db);
    expect(state?.certificate).toEqual(CERT);
    expect(state?.attempted_revision).toBe('rev-7');
  });

  test('an empty patch neither inserts nor throws', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await writeCertificateState({}, db);
    expect(await readCertificateState(db)).toBeNull();
  });
});

describe('claimCertificateLease', () => {
  test('seeds the row and grants the lease to the first caller', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    expect(await claimCertificateLease('instance-a', db)).toBe(true);

    const state = await readCertificateState(db);
    expect(state?.lease_owner).toBe('instance-a');
    expect(state!.lease_until!).toBeGreaterThan(Date.now());
  });

  test('refuses a second claimer while the lease is live', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    expect(await claimCertificateLease('instance-a', db)).toBe(true);
    expect(await claimCertificateLease('instance-b', db)).toBe(false);
    // The loser must not have stamped its own name over the winner's.
    expect((await readCertificateState(db))?.lease_owner).toBe('instance-a');
  });

  test('grants the lease once the previous one has expired', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await claimCertificateLease('instance-a', db);
    await db.write(`UPDATE managed_certificates SET lease_until = ? WHERE id = 'lan'`, [
      Date.now() - 1,
    ]);

    expect(await claimCertificateLease('instance-b', db)).toBe(true);
    expect((await readCertificateState(db))?.lease_owner).toBe('instance-b');
  });

  test('grants the lease immediately after the holder releases it', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await claimCertificateLease('instance-a', db);
    await releaseCertificateLease('instance-a', db);
    expect(await claimCertificateLease('instance-b', db)).toBe(true);
  });

  test('a non-owner cannot release the lease out from under the holder', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await claimCertificateLease('instance-a', db);
    await releaseCertificateLease('instance-b', db);
    expect(await claimCertificateLease('instance-b', db)).toBe(false);
  });
});

describe('renewCertificateLease', () => {
  test('extends the lease for the instance that holds it', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await claimCertificateLease('instance-a', db);
    await db.write(`UPDATE managed_certificates SET lease_until = 1 WHERE id = 'lan'`);

    expect(await renewCertificateLease('instance-a', db)).toBe(true);
    expect((await readCertificateState(db))!.lease_until!).toBeGreaterThan(Date.now());
  });

  test('tells a former holder it has lost the lease', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await claimCertificateLease('instance-a', db);
    expect(await renewCertificateLease('instance-b', db)).toBe(false);
  });
});

describe('rememberChallenge and forgetChallenge', () => {
  test('appends records in order', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await writeCertificateState({ account_key: 'acme-account' }, db);
    await rememberChallenge({ id: 'rec-1', zone_id: 'zone-a' }, db);
    await rememberChallenge({ id: 'rec-2', zone_id: 'zone-b' }, db);

    expect((await readCertificateState(db))?.challenges).toEqual([
      { id: 'rec-1', zone_id: 'zone-a' },
      { id: 'rec-2', zone_id: 'zone-b' },
    ]);
  });

  test('forgets only the record that matches on both fields', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await writeCertificateState({ account_key: 'acme-account' }, db);
    await rememberChallenge({ id: 'rec-1', zone_id: 'zone-a' }, db);
    await rememberChallenge({ id: 'rec-1', zone_id: 'zone-b' }, db);
    await rememberChallenge({ id: 'rec-2', zone_id: 'zone-a' }, db);

    await forgetChallenge({ id: 'rec-1', zone_id: 'zone-a' }, db);

    // Same id, different zone: `$pull` compares the whole sub-document, so this
    // one stays.
    expect((await readCertificateState(db))?.challenges).toEqual([
      { id: 'rec-1', zone_id: 'zone-b' },
      { id: 'rec-2', zone_id: 'zone-a' },
    ]);
  });

  test('forgetting the last record leaves an empty list, not null', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await writeCertificateState({ account_key: 'acme-account' }, db);
    await rememberChallenge({ id: 'rec-1', zone_id: 'zone-a' }, db);
    await forgetChallenge({ id: 'rec-1', zone_id: 'zone-a' }, db);

    expect((await readCertificateState(db))?.challenges).toEqual([]);
  });

  test('forgetting a record that was never remembered changes nothing', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await writeCertificateState({ account_key: 'acme-account' }, db);
    await rememberChallenge({ id: 'rec-1', zone_id: 'zone-a' }, db);
    await forgetChallenge({ id: 'nope', zone_id: 'zone-z' }, db);

    expect((await readCertificateState(db))?.challenges).toEqual([
      { id: 'rec-1', zone_id: 'zone-a' },
    ]);
  });

  test('are no-ops before the row exists, exactly as the un-upserted $push was', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await rememberChallenge({ id: 'rec-1', zone_id: 'zone-a' }, db);
    await forgetChallenge({ id: 'rec-1', zone_id: 'zone-a' }, db);
    expect(await readCertificateState(db)).toBeNull();
  });
});
