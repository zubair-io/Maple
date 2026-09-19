/**
 * The three tables the cutover skipped, carried end to end (#3797).
 *
 * `plan/settings.test.ts` states the mappers as pure functions and covers the
 * awkward shapes. This file asks the different question: does a seeded library
 * driven through the whole importer — coverage check, batching, repair pass,
 * verification — come out the other side with the certificate, the resume
 * points and the search cursor intact. Each was skipped on a re-derivable-in-
 * principle argument, and the one that mattered most did not re-derive at all.
 *
 * The keys below are the synthetic ones `seed-ops.test-helpers.ts` writes. A
 * real ACME account key is the value this whole test exists to move, and it is
 * not something to put in a repository to prove it moved.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { importedFixture, type ImportedFixture } from './fixture.test-helpers.ts';
import { CERTIFICATE_FIXTURE } from './seed-settings.test-helpers.ts';
import { iso } from './seed-fixtures.test-helpers.ts';

const fixture: ImportedFixture = importedFixture(`maple_import_settings_${process.pid}`);
const { one } = fixture;

beforeAll(fixture.setUp, 60_000);
afterAll(fixture.tearDown);

describe('the managed LAN certificate', () => {
  it('carries the ACME account key and every column beside it', () => {
    if (fixture.state.client === null) return;
    const row = one<{
      id: string;
      account_key: string;
      certificate: string;
      challenges: string;
      lease_owner: string;
      lease_until: number;
      retry_after: number;
      attempted_revision: string;
    }>(`SELECT * FROM managed_certificates`);

    expect(row.id).toBe('lan');
    expect(row.account_key).toBe(CERTIFICATE_FIXTURE.accountKey);
    expect(row.lease_owner).toBe(CERTIFICATE_FIXTURE.leaseOwner);
    expect(row.lease_until).toBe(CERTIFICATE_FIXTURE.leaseUntil);
    expect(row.retry_after).toBe(0);
    expect(row.attempted_revision).toBe(CERTIFICATE_FIXTURE.attemptedRevision);
  });

  /**
   * The certificate and the challenge list are subdocuments on Mongo and JSON
   * text here, so "it imported" is not the claim worth making — "it parses back
   * into the same objects the store reads" is. `StoredCertificate` is read back
   * whole and handed to the TLS listener; a field lost in translation is a
   * server that boots with a certificate it cannot use.
   */
  it('round-trips the certificate and the outstanding challenge as JSON', () => {
    if (fixture.state.client === null) return;
    const row = one<{ certificate: string; challenges: string; valid: number }>(
      `SELECT certificate, challenges,
              json_valid(certificate) AND json_valid(challenges) AS valid
         FROM managed_certificates`,
    );
    expect(row.valid).toBe(1);
    expect(JSON.parse(row.certificate)).toEqual({
      hostname: CERTIFICATE_FIXTURE.hostname,
      key: CERTIFICATE_FIXTURE.key,
      cert: CERTIFICATE_FIXTURE.cert,
      not_before: CERTIFICATE_FIXTURE.notBefore,
      not_after: CERTIFICATE_FIXTURE.notAfter,
    });
    expect(JSON.parse(row.challenges)).toEqual([CERTIFICATE_FIXTURE.challenge]);
  });

  /**
   * The lease claim is `UPDATE … WHERE lease_until <= ?`, so an imported row
   * whose lease column arrived as text or as null would either never be
   * claimable or throw the renewal loop off entirely. The seeded lease is in
   * the past, which is the state a cutover leaves behind.
   */
  it('leaves the lease claimable, as an integer the claim can compare', () => {
    if (fixture.state.client === null) return;
    const row = one<{ kind: string; claimable: number }>(
      `SELECT typeof(lease_until) AS kind, lease_until <= ? AS claimable
         FROM managed_certificates`,
      Date.now(),
    );
    expect(row).toEqual({ kind: 'integer', claimable: 1 });
  });
});

describe('the indexer resume points', () => {
  it('keys the row on the library and keeps the in-flight list', () => {
    if (fixture.state.client === null) return;
    const { ids } = fixture.state;
    if (ids === null) return;
    const row = one<{
      folder_id: string;
      path: string;
      last_walked_at: number;
      inflight_ids: string;
      sweep_gen: number;
      updated_at: number;
    }>(`SELECT * FROM indexer_checkpoints`);

    expect(row.folder_id).toBe(ids.libraryA.toHexString());
    expect(row.path).toBe('/libraries/a');
    expect(row.last_walked_at).toBe(1_767_225_600_000);
    expect(JSON.parse(row.inflight_ids)).toEqual(['maple-rich-0001', 'maple-legacy-0003']);
    expect(row.sweep_gen).toBe(7);
    expect(row.updated_at).toBe(1_767_225_660_000);
  });
});

describe('the Meilisearch backfill', () => {
  /**
   * The cursor is the whole point: without it a fresh backfill restarts from
   * the top, which on the library this was written for means re-embedding
   * 335,419 assets through a `bge-m3` embedder. It arrives as an `ObjectId`
   * and has to land as the same hex the resumed `id > ?` scan compares.
   */
  it('resumes from the cursor rather than from the top', () => {
    if (fixture.state.client === null) return;
    const { ids } = fixture.state;
    if (ids === null) return;
    const row = one<{
      id: string;
      cursor: string;
      scanned: number;
      upserted: number;
      tombstoned: number;
      skipped: number;
      errors: number;
      remaining: number;
      retry_attempts: number;
      retry_error: string | null;
      blocked_at: string | null;
      started_at: string;
      updated_at: string;
      completed_at: string;
      doc_shape_version: number;
    }>(`SELECT * FROM meilisearch_backfill_state`);

    expect(row).toEqual({
      id: 'assets',
      cursor: ids.assets.rich.toHexString(),
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
    });
  });

  /**
   * The redrive list travels with the cursor for a reason: the backfill
   * advances past a row it fails on, and the only thing that ever comes back
   * for that asset is the end-of-run pass reading this table.
   */
  it('carries the parked rows the resumed scan will never revisit', () => {
    if (fixture.state.client === null) return;
    const { ids } = fixture.state;
    if (ids === null) return;
    const row = one<{
      asset_id: string;
      maple_id: string;
      error: string;
      attempts: number;
      updated_at: string;
    }>(`SELECT * FROM meilisearch_backfill_failures`);

    expect(row).toEqual({
      asset_id: ids.assets.damaged.toHexString(),
      maple_id: 'maple-damaged-0005',
      error: 'compose failed: embedder timed out',
      attempts: 2,
      updated_at: iso(6),
    });
  });

  /** The one companion that stays behind — see `plan/coverage.ts`. */
  it('leaves the runner lease behind, live claim and all', () => {
    if (fixture.state.client === null) return;
    const row = one<{ n: number }>(`SELECT COUNT(*) AS n FROM meilisearch_backfill_leases`);
    expect(row.n).toBe(0);
  });
});
