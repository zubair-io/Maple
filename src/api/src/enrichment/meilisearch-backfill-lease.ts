import { randomUUID } from 'node:crypto';
import { getDb } from '../db/client.ts';

const LEASE_ID = 'assets';
const LEASE_MS = 2 * 60 * 1000;

interface BackfillLease {
  _id: string;
  owner: string;
  expires_at: Date;
}

export class MeilisearchBackfillBusyError extends Error {
  constructor() {
    super('A semantic-search backfill or reset is already running.');
    this.name = 'MeilisearchBackfillBusyError';
  }
}

function isDuplicateKey(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === 11000;
}

/** Serialize the migration worker, admin route, and reset operation. */
export async function withMeilisearchBackfillLease<T>(work: () => Promise<T>): Promise<T> {
  const leases = (await getDb()).collection<BackfillLease>('meilisearch_backfill_leases');
  const owner = randomUUID();
  const now = new Date();
  try {
    const acquired = await leases.findOneAndUpdate(
      {
        _id: LEASE_ID,
        $or: [{ expires_at: { $lte: now } }, { owner }],
      },
      {
        $set: {
          owner,
          expires_at: new Date(now.getTime() + LEASE_MS),
        },
      },
      { upsert: true, returnDocument: 'after' },
    );
    if (acquired?.owner !== owner) throw new MeilisearchBackfillBusyError();
  } catch (error) {
    if (isDuplicateKey(error)) throw new MeilisearchBackfillBusyError();
    throw error;
  }

  const heartbeat = setInterval(() => {
    void leases.updateOne(
      { _id: LEASE_ID, owner },
      { $set: { expires_at: new Date(Date.now() + LEASE_MS) } },
    );
  }, LEASE_MS / 3);
  heartbeat.unref();

  try {
    return await work();
  } finally {
    clearInterval(heartbeat);
    await leases.deleteOne({ _id: LEASE_ID, owner });
  }
}
