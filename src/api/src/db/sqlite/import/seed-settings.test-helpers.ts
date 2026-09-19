/**
 * The four settings-module singletons #3797 recovered, seeded in the shape the
 * owner's production library holds them.
 *
 * Its own module rather than another block in `seed-ops.test-helpers.ts`
 * because these are what a cutover gets wrong rather than another queue, and
 * because the certificate needs a paragraph about keys that does not belong in
 * the middle of the upload-session fixtures.
 *
 * **Nothing here is a real secret.** The ACME account key and the
 * certificate's own private key are obviously synthetic strings, because a
 * fixture is the one place a real key would live forever and in plain sight.
 * What a test needs from them is only that whatever went in comes back out
 * byte for byte, which a short labelled stand-in proves as well as 1.7 kB of
 * real PEM would.
 *
 * They are deliberately not PEM-shaped either. A literal that opens with a
 * `BEGIN PRIVATE KEY` header trips the repository's secret scanner, and the
 * fix for that is a fixture that does not look like a key rather than a
 * scanner taught to ignore key headers in files whose name ends in `test`.
 */

import type { Db } from 'mongodb';
import { iso, type SeedIds } from './seed-fixtures.test-helpers.ts';

/** A stand-in for a key: a value rather than a flag, and plainly not a key. */
const syntheticKey = (label: string): string =>
  `synthetic-${label}-key-not-a-real-one-do-not-use-anywhere`;

/** The seeded certificate's fields, so a test asserts against one source. */
export const CERTIFICATE_FIXTURE = {
  accountKey: syntheticKey('acme-account'),
  hostname: 'local.maple.test',
  key: syntheticKey('leaf'),
  cert: 'synthetic-leaf-certificate-not-a-real-one',
  notBefore: 1_767_225_600_000,
  notAfter: 1_774_915_200_000,
  challenge: { id: 'txt-record-1', zone_id: 'zone-1' },
  leaseOwner: 'instance-a',
  leaseUntil: 1_767_225_000_000,
  attemptedRevision: '8279c2e3-0000-4eef-b60a-2d83de072d86',
};

/**
 * The certificate, the indexer resume point, the backfill cursor and one
 * parked redrive row.
 *
 * `indexer_checkpoints` keeps its camelCase field names and its own ObjectId
 * `_id`, which is what the live collection has — the library it belongs to is
 * a separate `folderId` field, and that is the value the destination's primary
 * key column takes.
 */
export async function seedSettings(db: Db, ids: SeedIds): Promise<void> {
  await db.collection('managed_certificates').insertOne({
    _id: 'lan',
    account_key: CERTIFICATE_FIXTURE.accountKey,
    certificate: {
      hostname: CERTIFICATE_FIXTURE.hostname,
      key: CERTIFICATE_FIXTURE.key,
      cert: CERTIFICATE_FIXTURE.cert,
      not_before: CERTIFICATE_FIXTURE.notBefore,
      not_after: CERTIFICATE_FIXTURE.notAfter,
    },
    challenges: [CERTIFICATE_FIXTURE.challenge],
    lease_owner: CERTIFICATE_FIXTURE.leaseOwner,
    lease_until: CERTIFICATE_FIXTURE.leaseUntil,
    retry_after: 0,
    attempted_revision: CERTIFICATE_FIXTURE.attemptedRevision,
  } as never);

  await db.collection('indexer_checkpoints').insertOne({
    folderId: ids.libraryA.toHexString(),
    path: '/libraries/a',
    lastWalkedAt: 1_767_225_600_000,
    inflightIds: ['maple-rich-0001', 'maple-legacy-0003'],
    sweepGen: 7,
    updatedAt: 1_767_225_660_000,
  } as never);

  await db.collection('meilisearch_backfill_state').insertOne({
    _id: 'assets',
    cursor: ids.assets.rich,
    scanned: 1200,
    upserted: 1100,
    tombstoned: 40,
    skipped: 50,
    errors: 10,
    remaining: 335_000,
    retry_attempts: 0,
    retry_error: null,
    blocked_at: null,
    started_at: iso(5),
    updated_at: iso(7),
    completed_at: iso(7),
    doc_shape_version: 4,
  } as never);

  await db.collection('meilisearch_backfill_failures').insertOne({
    _id: ids.assets.damaged,
    maple_id: 'maple-damaged-0005',
    error: 'compose failed: embedder timed out',
    attempts: 2,
    updated_at: iso(6),
  } as never);
}
