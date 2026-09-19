/**
 * The four small singleton-ish collections that `ddl/settings.ts` owns: the
 * managed LAN certificate, the per-library indexer resume points, and the
 * Meilisearch backfill's cursor and its redrive list.
 *
 * All four were skipped at first, on the reasoning that something downstream
 * re-derives each of them. Re-deriving turned out to be the expensive part
 * (#3797), and in one case it did not happen at all:
 *
 *  - the server was expected to re-issue the LAN certificate on first boot. It
 *    did not — issuance failed, the settings page showed a generic Cloudflare
 *    error, nothing was logged, and the hostname stayed down for hours.
 *    Carrying the ACME account key means the new database starts from a
 *    registered account and an already-issued certificate rather than from a
 *    fresh ACME registration against Let's Encrypt's duplicate-certificate
 *    rate limit;
 *  - "a fresh backfill restarts from the top" is true and costs a full re-embed
 *    of every asset in the library, which on the install this was written for
 *    is 335,419 of them through a `bge-m3` embedder;
 *  - "the next sweep re-derives them" is also true, and that sweep walked
 *    216,000 assets immediately after the cutover.
 *
 * The rule these three replace is "skip anything that can be argued to be
 * re-derivable". The rule that replaces it is "copy it unless copying is
 * actively harmful", which is a much higher bar to clear and the reason
 * `meilisearch_backfill_leases` is still the one entry here that stays behind.
 *
 * ## The certificate document carries secrets, and this module never reads one
 *
 * `account_key` is the ACME account's private key and `certificate.key` is the
 * issued certificate's. Both are bound as statement parameters and neither is
 * ever interpolated into a string: no mapper here throws with a value in the
 * message, the reject list records only the `_id` and a reason, and the
 * verifier's field checks report `present` / `missing` rather than contents. A
 * future edit that adds `${…}` to an error in this file would undo that, which
 * is why it is written down rather than left to be inferred.
 *
 * ## The lease columns are carried verbatim
 *
 * `lease_owner` and `lease_until` name a process that does not survive the
 * cutover, so the temptation is to zero them. They are copied as they stand
 * anyway, for the same reason `mirror_queue.claimed_at` and
 * `discover_frontier.claimed_at` are: a lease is arithmetic on a clock and
 * expires on its own, ten minutes at the outside, while a row that differs
 * from its source is a row the verifier cannot check against the source. Ten
 * minutes of deferred renewal on a certificate with weeks of validity left is
 * not a cost worth an unverifiable row.
 */

import type { CollectionPlan } from '../types.ts';
import {
  idToHex,
  intOr,
  requireIdHex,
  toEpochMs,
  toIso,
  toJsonText,
  toNumber,
  toText,
  textOr,
} from '../values.ts';
import { docId, docKey, onePerDocument } from './shared.ts';

const EPOCH = new Date(0).toISOString();

/**
 * The ACME account key, the issued LAN certificate and any DNS-01 challenge
 * records still outstanding. One document, `_id: "lan"`.
 *
 * `challenges` falls back to `'[]'` rather than null because the column is NOT
 * NULL with that default: the store appends to the array with `json_insert`
 * and rebuilds it with `json_group_array`, and both need something valid to
 * start from. A document written before any challenge was recorded simply has
 * no such field, and an empty array is what "no challenges outstanding" means
 * on both engines.
 */
const managedCertificatesPlan = onePerDocument({
  source: 'managed_certificates',
  table: 'managed_certificates',
  idKind: 'string',
  columns: [
    'id',
    'account_key',
    'certificate',
    'challenges',
    'lease_owner',
    'lease_until',
    'retry_after',
    'attempted_revision',
  ],
  values: (doc) => [
    docKey(doc),
    toText(doc.account_key),
    toJsonText(doc.certificate),
    toJsonText(doc.challenges) ?? '[]',
    toText(doc.lease_owner),
    intOr(doc.lease_until, 0),
    toNumber(doc.retry_after),
    toText(doc.attempted_revision),
  ],
});

/**
 * One row per library root: where the last full walk reached, and which jobs
 * were in flight when the process last went down.
 *
 * The primary key is the folder, not the document: Mongo keyed these by an
 * ObjectId of their own and held the library's id in a `folderId` field, with
 * a unique index standing in for the uniqueness SQLite gets from the key
 * itself. The plan therefore batches on `_id` like any other collection and
 * writes `folderId` into the primary key column — two documents claiming the
 * same library would collide, which the unique index already forbade and which
 * lands on the reject list here rather than silently keeping one of them.
 *
 * The camelCase field names are the source's, not a typo: this collection was
 * written by the retired bounded-channel indexer and never went through the
 * snake_case convention the rest of the database follows.
 */
const indexerCheckpointsPlan = onePerDocument({
  source: 'indexer_checkpoints',
  table: 'indexer_checkpoints',
  columns: ['folder_id', 'path', 'last_walked_at', 'inflight_ids', 'sweep_gen', 'updated_at'],
  values: (doc) => [
    requireIdHex(doc.folderId, 'folderId'),
    textOr(doc.path, ''),
    toEpochMs(doc.lastWalkedAt) ?? 0,
    toJsonText(doc.inflightIds) ?? '[]',
    toNumber(doc.sweepGen),
    toEpochMs(doc.updatedAt) ?? 0,
  ],
});

/**
 * The Meilisearch backfill's resume point. One document, `_id: "assets"`.
 *
 * `cursor` is the one field that changes type on the way across: Mongo stored
 * the asset's `ObjectId` and the SQLite column is TEXT, because everything that
 * reads the cursor back — `loadMeiliAssetsAfter` and the `id > ?` it becomes —
 * now works in the same 24-character hex the rest of the schema uses. Leaving
 * it as the driver's object would store `[object Object]`, which compares
 * greater than every real id and would silently make the resumed backfill think
 * it had already finished.
 */
const meilisearchBackfillStatePlan = onePerDocument({
  source: 'meilisearch_backfill_state',
  table: 'meilisearch_backfill_state',
  idKind: 'string',
  columns: [
    'id',
    'cursor',
    'scanned',
    'upserted',
    'tombstoned',
    'skipped',
    'errors',
    'remaining',
    'retry_attempts',
    'retry_error',
    'blocked_at',
    'started_at',
    'updated_at',
    'completed_at',
    'doc_shape_version',
  ],
  values: (doc) => {
    const startedAt = toIso(doc.started_at) ?? EPOCH;
    return [
      docKey(doc),
      idToHex(doc.cursor),
      intOr(doc.scanned, 0),
      intOr(doc.upserted, 0),
      intOr(doc.tombstoned, 0),
      intOr(doc.skipped, 0),
      intOr(doc.errors, 0),
      toNumber(doc.remaining),
      intOr(doc.retry_attempts, 0),
      toText(doc.retry_error),
      toIso(doc.blocked_at),
      startedAt,
      toIso(doc.updated_at) ?? startedAt,
      toIso(doc.completed_at),
      toNumber(doc.doc_shape_version),
    ];
  },
});

/**
 * Assets the backfill could not compose or write, keyed by the asset's own id.
 *
 * This one is imported because the cursor above is. The backfill advances past
 * a row it fails on — a durable cursor that never revisits a dead-lettered row
 * is what keeps one bad asset from stalling the whole migration — and the only
 * thing that ever comes back for those assets is the end-of-run redrive pass
 * reading exactly this list. Carry the cursor and drop the list and those
 * assets are absent from search for good, with nothing left pointing at them.
 *
 * `attempts` floors at 1 rather than 0: the Mongo writer `$inc`s it on every
 * failure including the first, so a row exists only because at least one
 * attempt was made, and 0 would claim otherwise.
 */
const meilisearchBackfillFailuresPlan = onePerDocument({
  source: 'meilisearch_backfill_failures',
  table: 'meilisearch_backfill_failures',
  columns: ['asset_id', 'maple_id', 'error', 'attempts', 'updated_at'],
  values: (doc) => [
    docId(doc),
    textOr(doc.maple_id, ''),
    textOr(doc.error, ''),
    intOr(doc.attempts, 1),
    toIso(doc.updated_at) ?? EPOCH,
  ],
});

/**
 * The settings-module plans.
 *
 * `meilisearch_backfill_failures` references `assets`, so this list belongs
 * after the assets plan in the import order; the other three reference nothing.
 */
export const SETTINGS_PLANS: CollectionPlan[] = [
  managedCertificatesPlan,
  indexerCheckpointsPlan,
  meilisearchBackfillStatePlan,
  meilisearchBackfillFailuresPlan,
];
