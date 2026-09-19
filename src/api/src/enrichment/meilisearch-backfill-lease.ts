/**
 * The vector backfill's single-runner lease: it serialises the migration
 * worker, the admin route and the reset operation against each other.
 *
 * Storage is `db/sqlite/repos/meilisearch-backfill.repo.ts`. The claim there is
 * one conditional upsert, so the duplicate-key catch this module used to need —
 * two racing Mongo upserts can both miss the document, and one then loses the
 * insert — has no equivalent: a claim either changes the row or it does not.
 */

import { randomUUID } from 'node:crypto';
import {
  acquireBackfillLease,
  releaseBackfillLease,
  renewBackfillLease,
} from '../db/sqlite/repos/meilisearch-backfill.repo.ts';

const LEASE_MS = 2 * 60 * 1000;

export class MeilisearchBackfillBusyError extends Error {
  constructor() {
    super('A semantic-search backfill or reset is already running.');
    this.name = 'MeilisearchBackfillBusyError';
  }
}

/** Serialize the migration worker, admin route, and reset operation. */
export async function withMeilisearchBackfillLease<T>(work: () => Promise<T>): Promise<T> {
  const owner = randomUUID();
  const nowMs = Date.now();
  const acquired = await acquireBackfillLease(owner, nowMs + LEASE_MS, nowMs);
  if (!acquired) throw new MeilisearchBackfillBusyError();

  const heartbeat = setInterval(() => {
    void renewBackfillLease(owner, Date.now() + LEASE_MS);
  }, LEASE_MS / 3);
  heartbeat.unref();

  try {
    return await work();
  } finally {
    clearInterval(heartbeat);
    await releaseBackfillLease(owner);
  }
}
