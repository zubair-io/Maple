/**
 * `managed_certificates` — the SQLite port of `network/certificate-store.ts`
 * (#3751).
 *
 * ACME account key, issued certificate and in-flight DNS challenges for the
 * managed LAN HTTPS listener. Exactly one row, id `lan`, and nothing here is
 * ever serialised to an HTTP response.
 *
 * `renewalTime` is not ported: it is arithmetic on a certificate's validity
 * window with no database in it, so it stays where it is.
 *
 * ## The lease is the reason this table has columns at all
 *
 * Two instances of the API may boot against the same database and both decide
 * the certificate needs renewing. The lease is what stops them both driving an
 * ACME order, and it works because {@link claimCertificateLease} is a
 * conditional write whose row count decides the winner — the losing instance
 * sees `changes === 0` and returns false without ever having read a value it
 * then acted on.
 *
 * On Mongo this is two round trips: seed the row with `$setOnInsert: {
 * lease_until: 0 }`, then a conditional `updateOne` whose `modifiedCount` is
 * the answer. It is the same two statements here — `INSERT … ON CONFLICT DO
 * NOTHING` then `UPDATE … WHERE id = 'lan' AND lease_until <= ?` — run as one
 * transaction so the seed cannot land without the claim attempt that follows
 * it. `lease_until` defaults to 0 in the DDL, so a freshly seeded row is
 * immediately claimable, which is exactly what the `$setOnInsert` arranged.
 *
 * The Mongo filter also has to allow for `lease_until` being absent
 * (`{ $exists: false }`). The column is `NOT NULL DEFAULT 0`, so that case
 * cannot occur and the predicate loses a branch.
 */

import type { SqlValue } from '../sqlite/protocol.ts';
import { changesAt, sqliteDb, type SqliteDb } from './db-handle.ts';
import { parseJson } from './values.ts';

export type { SqliteDb } from './db-handle.ts';

/** The single row's id. */
const LAN = 'lan';

/** How long a claimed lease is good for. */
const LEASE_MS = 10 * 60_000;

export interface StoredCertificate {
  hostname: string;
  key: string;
  cert: string;
  not_before: number;
  not_after: number;
}

export interface DnsChallengeRecord {
  id: string;
  zone_id: string;
}

export interface CertificateState {
  _id: string;
  account_key?: string;
  certificate?: StoredCertificate;
  challenges?: DnsChallengeRecord[];
  lease_owner?: string;
  lease_until?: number;
  retry_after?: number;
  attempted_revision?: string;
}

interface CertificateRow {
  account_key: string | null;
  certificate: string | null;
  challenges: string;
  lease_owner: string | null;
  lease_until: number;
  retry_after: number | null;
  attempted_revision: string | null;
}

const SELECT_SQL = `
  SELECT account_key, certificate, challenges, lease_owner, lease_until,
         retry_after, attempted_revision
    FROM managed_certificates WHERE id = ?`;

const SEED_SQL = `INSERT INTO managed_certificates (id) VALUES (?) ON CONFLICT (id) DO NOTHING`;

const CLAIM_SQL = `
  UPDATE managed_certificates SET lease_owner = ?, lease_until = ?
   WHERE id = ? AND lease_until <= ?`;

/**
 * `$pull` matches array entries by whole-document equality, so an entry is
 * removed only when every field matches. A challenge record is exactly `{ id,
 * zone_id }`, so reproducing that meaning is "keep the entries that differ in
 * either field" — which is what this rebuild expresses. `IS NOT` rather than
 * `<>` so an entry missing one of the fields compares as different rather than
 * as unknown.
 */
const FORGET_CHALLENGE_SQL = `
  UPDATE managed_certificates
     SET challenges = (
       SELECT json_group_array(json(value)) FROM json_each(challenges)
        WHERE json_extract(value, '$.id') IS NOT ?
           OR json_extract(value, '$.zone_id') IS NOT ?)
   WHERE id = ?`;

/** Patch field → its column and the value the column stores. */
const COLUMN_VALUES: {
  [K in keyof Omit<CertificateState, '_id'>]-?: (
    value: NonNullable<CertificateState[K]>,
  ) => SqlValue;
} = {
  account_key: (value) => value,
  certificate: (value) => JSON.stringify(value),
  challenges: (value) => JSON.stringify(value),
  lease_owner: (value) => value,
  lease_until: (value) => value,
  retry_after: (value) => value,
  attempted_revision: (value) => value,
};

function toState(row: CertificateRow): CertificateState {
  return {
    _id: LAN,
    account_key: row.account_key ?? undefined,
    certificate: parseJson<StoredCertificate | undefined>(row.certificate, undefined),
    challenges: parseJson<DnsChallengeRecord[]>(row.challenges, []),
    lease_owner: row.lease_owner ?? undefined,
    lease_until: row.lease_until,
    retry_after: row.retry_after ?? undefined,
    attempted_revision: row.attempted_revision ?? undefined,
  };
}

/** The certificate row, or `null` when nothing has written one yet. */
export async function readCertificateState(
  dbOverride?: SqliteDb,
): Promise<CertificateState | null> {
  const rows = await sqliteDb(dbOverride).read<CertificateRow>(SELECT_SQL, [LAN]);
  const row = rows[0];
  return row === undefined ? null : toState(row);
}

/**
 * Apply a partial update, creating the row when it does not exist.
 *
 * Mirrors `updateOne({ _id: 'lan' }, { $set: patch }, { upsert: true })`, down
 * to an empty patch being a no-op — no caller produces one, and the driver
 * rejects it.
 */
export async function writeCertificateState(
  patch: Partial<Omit<CertificateState, '_id'>>,
  dbOverride?: SqliteDb,
): Promise<void> {
  const fields = (Object.keys(COLUMN_VALUES) as Array<keyof typeof COLUMN_VALUES>)
    .filter((column) => patch[column] !== undefined)
    .map((column) => ({
      column,
      // Narrowed by the filter above; the mapped type keeps each converter
      // paired with its own field.
      value: (COLUMN_VALUES[column] as (v: unknown) => SqlValue)(patch[column]),
    }));
  if (fields.length === 0) return;

  const columns = fields.map((field) => field.column);
  const assignments = columns.map((column) => `${column} = excluded.${column}`).join(', ');
  await sqliteDb(dbOverride).write(
    `INSERT INTO managed_certificates (id, ${columns.join(', ')})
     VALUES (?, ${columns.map(() => '?').join(', ')})
     ON CONFLICT (id) DO UPDATE SET ${assignments}`,
    [LAN, ...fields.map((field) => field.value)],
  );
}

/**
 * Take the renewal lease for ten minutes, reporting whether this caller got it.
 *
 * `changes === 1` is the whole answer: the `lease_until <= ?` predicate is
 * evaluated by the same statement that overwrites the lease, so a second
 * instance arriving while the first lease is live matches nothing and is told
 * no.
 */
export async function claimCertificateLease(
  owner: string,
  dbOverride?: SqliteDb,
): Promise<boolean> {
  const now = Date.now();
  const results = await sqliteDb(dbOverride).transaction([
    { sql: SEED_SQL, params: [LAN] },
    { sql: CLAIM_SQL, params: [owner, now + LEASE_MS, LAN, now] },
  ]);
  return changesAt(results, 1) === 1;
}

/**
 * Extend this owner's lease. False when the lease has been taken over, which
 * is the signal the renewal loop uses to stop.
 */
export async function renewCertificateLease(
  owner: string,
  dbOverride?: SqliteDb,
): Promise<boolean> {
  const result = await sqliteDb(dbOverride).write(
    `UPDATE managed_certificates SET lease_until = ? WHERE id = ? AND lease_owner = ?`,
    [Date.now() + LEASE_MS, LAN, owner],
  );
  return result.changes === 1;
}

/** Give the lease back, so the next instance can claim it immediately. */
export async function releaseCertificateLease(owner: string, dbOverride?: SqliteDb): Promise<void> {
  await sqliteDb(dbOverride).write(
    `UPDATE managed_certificates SET lease_until = 0 WHERE id = ? AND lease_owner = ?`,
    [LAN, owner],
  );
}

/**
 * Append one in-flight DNS challenge, so a crashed issuance run's TXT records
 * can still be cleaned up by whichever instance comes back.
 *
 * `'$[#]'` is SQLite's append path. A no-op when the row does not exist, which
 * is what the Mongo `$push` without `upsert` did.
 */
export async function rememberChallenge(
  record: DnsChallengeRecord,
  dbOverride?: SqliteDb,
): Promise<void> {
  await sqliteDb(dbOverride).write(
    `UPDATE managed_certificates
        SET challenges = json_insert(challenges, '$[#]', json(?))
      WHERE id = ?`,
    [JSON.stringify(record), LAN],
  );
}

/** Drop one challenge record once its TXT record has been removed. */
export async function forgetChallenge(
  record: DnsChallengeRecord,
  dbOverride?: SqliteDb,
): Promise<void> {
  await sqliteDb(dbOverride).write(FORGET_CHALLENGE_SQL, [record.id, record.zone_id, LAN]);
}
