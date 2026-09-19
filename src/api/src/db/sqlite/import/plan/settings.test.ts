/**
 * The four settings-module mappers, as pure functions and against the real
 * tables (#3797).
 *
 * Companion to `import-settings.test.ts`, which drives the whole importer
 * against a seeded MongoDB and needs one running. This file needs nothing: a
 * plan's `map` is a pure function of one document, so the awkward shapes — a
 * certificate that has never recorded a challenge, a backfill parked on a
 * retry, a checkpoint written before any sweep — are cheapest to state here,
 * and every mapped row is then inserted into a real database so the column
 * constraints get a say rather than the assertions alone.
 *
 * No real key appears anywhere below. The strings are shaped like keys and say
 * so, because a fixture is the one place a real one would live forever.
 */

import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createTestDatabase } from '../../test-sqlite.test-helpers.ts';
import type { CollectionPlan, MapContext, Row } from '../types.ts';
import { insertSql } from './shared.ts';
import { SETTINGS_PLANS } from './settings.ts';

const CONTEXT: MapContext = {
  stageNames: [],
  note: () => {},
  releasedLocation: () => false,
};

const ASSET_ID = 'a'.repeat(24);
const FOLDER_ID = 'b'.repeat(24);

// Not PEM-shaped on purpose: a literal opening with a `BEGIN PRIVATE KEY`
// header trips the repository's secret scanner, and the right answer to that
// is a fixture that does not look like a key.
const ACCOUNT_KEY = 'synthetic-acme-account-key-not-a-real-one';
const LEAF_KEY = 'synthetic-leaf-key-not-a-real-one';

function planFor(source: string): CollectionPlan {
  const plan = SETTINGS_PLANS.find((entry) => entry.source === source);
  if (plan === undefined) throw new Error(`no plan for ${source}`);
  return plan;
}

/** The single row one document maps to, with its column list. */
function mapOne(source: string, doc: Record<string, unknown>): { columns: string[]; row: Row } {
  const batches = planFor(source).map(doc, CONTEXT);
  expect(batches).toHaveLength(1);
  const batch = batches[0] as { table: string; columns: readonly string[]; rows: Row[] };
  expect(batch.rows).toHaveLength(1);
  return { columns: [...batch.columns], row: batch.rows[0] as Row };
}

/** A mapped row as the destination stores it, read back by column name. */
function roundTrip(
  db: Database,
  source: string,
  table: string,
  doc: Record<string, unknown>,
): Record<string, unknown> {
  const { columns, row } = mapOne(source, doc);
  db.query(insertSql(table, columns)).run(...(row as never[]));
  return db.query(`SELECT * FROM ${table}`).get() as Record<string, unknown>;
}

describe('managed_certificates', () => {
  const full = {
    _id: 'lan',
    account_key: ACCOUNT_KEY,
    certificate: {
      hostname: 'local.maple.test',
      key: LEAF_KEY,
      cert: 'synthetic-leaf-certificate-not-a-real-one',
      not_before: 1_767_225_600_000,
      not_after: 1_774_915_200_000,
    },
    challenges: [{ id: 'txt-1', zone_id: 'zone-1' }],
    lease_owner: 'instance-a',
    lease_until: 1_767_225_000_000,
    retry_after: 0,
    attempted_revision: 'rev-1',
  };

  test('stores the account key and the leaf key byte for byte', async () => {
    using handle = await createTestDatabase();
    const stored = roundTrip(handle.db, 'managed_certificates', 'managed_certificates', full);
    expect(stored.id).toBe('lan');
    expect(stored.account_key).toBe(ACCOUNT_KEY);
    expect(JSON.parse(String(stored.certificate))).toEqual(full.certificate);
    expect(JSON.parse(String(stored.challenges))).toEqual(full.challenges);
    expect(stored.lease_owner).toBe('instance-a');
    expect(stored.lease_until).toBe(1_767_225_000_000);
    expect(stored.retry_after).toBe(0);
    expect(stored.attempted_revision).toBe('rev-1');
  });

  /**
   * The column is NOT NULL with a `'[]'` default and every write path — the
   * `json_insert` append, the `json_group_array` rebuild — needs something
   * valid to start from. A document from a server that has never driven a
   * DNS-01 challenge simply has no such field, so the mapper has to supply
   * the empty array rather than pass a null through.
   */
  test('gives a document with no challenge list a valid empty one', async () => {
    using handle = await createTestDatabase();
    const stored = roundTrip(handle.db, 'managed_certificates', 'managed_certificates', {
      _id: 'lan',
      account_key: ACCOUNT_KEY,
    });
    expect(stored.challenges).toBe('[]');
    expect(JSON.parse(String(stored.challenges))).toEqual([]);
    expect(stored.certificate).toBeNull();
    // Both JSON columns carry a `json_valid` CHECK, so this is the constraint
    // answering rather than the assertion above restating itself.
    const valid = handle.db
      .query(
        `SELECT json_valid(challenges) AS c, certificate IS NULL AS n FROM managed_certificates`,
      )
      .get() as { c: number; n: number };
    expect(valid).toEqual({ c: 1, n: 1 });
  });

  test('defaults an absent lease to immediately claimable', () => {
    const { columns, row } = mapOne('managed_certificates', { _id: 'lan' });
    expect(row[columns.indexOf('lease_until')]).toBe(0);
    expect(row[columns.indexOf('lease_owner')]).toBeNull();
    expect(row[columns.indexOf('retry_after')]).toBeNull();
  });
});

describe('indexer_checkpoints', () => {
  test('keys the row on folderId, not on the document id', async () => {
    using handle = await createTestDatabase();
    const stored = roundTrip(handle.db, 'indexer_checkpoints', 'indexer_checkpoints', {
      _id: 'ignored-in-favour-of-folderId',
      folderId: FOLDER_ID,
      path: '/libraries/a',
      lastWalkedAt: 1_767_225_600_000,
      inflightIds: ['maple-0001', 'maple-0002'],
      sweepGen: 7,
      updatedAt: 1_767_225_660_000,
    });
    expect(stored).toEqual({
      folder_id: FOLDER_ID,
      path: '/libraries/a',
      last_walked_at: 1_767_225_600_000,
      inflight_ids: '["maple-0001","maple-0002"]',
      sweep_gen: 7,
      updated_at: 1_767_225_660_000,
    });
  });

  /**
   * The in-flight marker upserts on the folder alone, so a job claimed before
   * the first walk finished leaves a document with no `path`, no `lastWalkedAt`
   * and no `sweepGen`. A null `sweep_gen` reads back as "no sweep in progress",
   * which is what the source meant by not having the field.
   */
  test('carries a row written before any walk finished', async () => {
    using handle = await createTestDatabase();
    const stored = roundTrip(handle.db, 'indexer_checkpoints', 'indexer_checkpoints', {
      folderId: FOLDER_ID,
      inflightIds: [],
      updatedAt: 1_767_225_660_000,
    });
    expect(stored).toEqual({
      folder_id: FOLDER_ID,
      path: '',
      last_walked_at: 0,
      inflight_ids: '[]',
      sweep_gen: null,
      updated_at: 1_767_225_660_000,
    });
  });

  test('rejects a document whose folderId is not an id', () => {
    expect(() => mapOne('indexer_checkpoints', { folderId: 'not-an-object-id' })).toThrow(
      'folderId',
    );
  });
});

describe('meilisearch_backfill_state', () => {
  test('turns the cursor ObjectId into the hex the resumed scan compares', async () => {
    using handle = await createTestDatabase();
    const stored = roundTrip(
      handle.db,
      'meilisearch_backfill_state',
      'meilisearch_backfill_state',
      {
        _id: 'assets',
        cursor: ASSET_ID,
        scanned: 1200,
        upserted: 1100,
        tombstoned: 40,
        skipped: 50,
        errors: 10,
        remaining: 335_000,
        retry_attempts: 0,
        retry_error: null,
        blocked_at: null,
        started_at: '2026-01-06T00:00:00.000Z',
        updated_at: '2026-01-08T00:00:00.000Z',
        completed_at: '2026-01-08T00:00:00.000Z',
        doc_shape_version: 4,
      },
    );
    expect(stored).toEqual({
      id: 'assets',
      cursor: ASSET_ID,
      scanned: 1200,
      upserted: 1100,
      tombstoned: 40,
      skipped: 50,
      errors: 10,
      remaining: 335_000,
      retry_attempts: 0,
      retry_error: null,
      blocked_at: null,
      started_at: '2026-01-06T00:00:00.000Z',
      updated_at: '2026-01-08T00:00:00.000Z',
      completed_at: '2026-01-08T00:00:00.000Z',
      doc_shape_version: 4,
    });
  });

  /** A run parked against a Meilisearch that is down keeps its retry circuit. */
  test('carries the retry circuit of a blocked run', async () => {
    using handle = await createTestDatabase();
    const stored = roundTrip(
      handle.db,
      'meilisearch_backfill_state',
      'meilisearch_backfill_state',
      {
        _id: 'assets',
        cursor: null,
        retry_attempts: 3,
        retry_error: 'meilisearch unreachable',
        blocked_at: '2026-01-07T00:00:00.000Z',
        started_at: '2026-01-06T00:00:00.000Z',
      },
    );
    expect(stored.cursor).toBeNull();
    expect(stored.retry_attempts).toBe(3);
    expect(stored.retry_error).toBe('meilisearch unreachable');
    expect(stored.blocked_at).toBe('2026-01-07T00:00:00.000Z');
    // Both timestamps are NOT NULL, and a row that has never committed a batch
    // has no `updated_at` of its own; the start is the honest stand-in.
    expect(stored.updated_at).toBe('2026-01-06T00:00:00.000Z');
    expect(stored.completed_at).toBeNull();
    expect(stored.scanned).toBe(0);
  });
});

describe('meilisearch_backfill_failures', () => {
  test('keys a parked row on the asset and keeps its attempt count', async () => {
    using handle = await createTestDatabase();
    // The parked row's asset_id is a NOT NULL reference, and the harness turns
    // foreign keys on — so the asset has to exist for the insert to mean
    // anything.
    handle.db
      .query(`INSERT INTO assets (id, size, mtime, indexed_at) VALUES (?, ?, ?, ?)`)
      .run(ASSET_ID, 1024, 1_767_225_600_000, '2026-01-01T00:00:00.000Z');
    const stored = roundTrip(
      handle.db,
      'meilisearch_backfill_failures',
      'meilisearch_backfill_failures',
      {
        _id: ASSET_ID,
        maple_id: 'maple-damaged-0005',
        error: 'compose failed: embedder timed out',
        attempts: 2,
        updated_at: '2026-01-07T00:00:00.000Z',
      },
    );
    expect(stored).toEqual({
      asset_id: ASSET_ID,
      maple_id: 'maple-damaged-0005',
      error: 'compose failed: embedder timed out',
      attempts: 2,
      updated_at: '2026-01-07T00:00:00.000Z',
    });
  });

  /**
   * The Mongo writer `$inc`s `attempts` on every failure including the first,
   * so a row exists only because at least one attempt was made. Zero would
   * claim otherwise to the redrive pass, which tells a first-time failure from
   * a repeat by that number.
   */
  test('floors the attempt count of a row written before the counter existed', () => {
    const { columns, row } = mapOne('meilisearch_backfill_failures', {
      _id: ASSET_ID,
      maple_id: 'maple-0001',
      error: 'boom',
      updated_at: '2026-01-07T00:00:00.000Z',
    });
    expect(row[columns.indexOf('attempts')]).toBe(1);
  });
});
