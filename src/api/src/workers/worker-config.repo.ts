/**
 * WorkerConfigRepo — CRUD on the worker_config collection.
 *
 * One document per stage. Fields mirror WorkerConfig plus a `name` key.
 *
 * Config changes are NOT propagated here. PATCH /api/workers/:name/config
 * writes to Mongo via this repo, then calls
 * `stageRegistry.notifyConfigChanged(name)` (see `./registry.ts`) which
 * triggers an in-process re-read inside the running poll loop — same
 * process, no IPC.
 */

import type { Collection } from 'mongodb';
import { getDb } from '../db/client.ts';
import type { WorkerConfig } from './run-stage.ts';
import { sanitizeWorkerConfig, type WorkerConfigDoc } from './worker-config-shape.ts';

// The document shape and the wire projection moved to
// `./worker-config-shape.ts` when the SQLite port (#3751) became a second
// owner of this collection — both have to answer `/api/workers/status` with
// the same body, and the omissions are the part that is on the wire.
export { sanitizeWorkerConfig, type WorkerConfigDoc } from './worker-config-shape.ts';

export async function loadWorkerConfigSafe(workerName: string): Promise<WorkerConfig | null> {
  try {
    const db = await getDb();
    const repo = new WorkerConfigRepo(db.collection<WorkerConfigDoc>('worker_config'));
    return await repo.load(workerName);
  } catch (err) {
    if (process.env.NODE_ENV !== 'test') {
      console.warn(`[${workerName} worker] Failed to load worker config from database:`, err);
    }
    return null;
  }
}

export class WorkerConfigRepo {
  constructor(private readonly coll: Collection<WorkerConfigDoc>) {}

  /** Load a single stage config. Returns null when not yet seeded. */
  async load(name: string): Promise<WorkerConfig | null> {
    const doc = await this.coll.findOne({ name });
    if (!doc) return null;
    return sanitizeWorkerConfig(doc);
  }

  /** Upsert (insert-or-replace) a stage config. */
  async upsert(name: string, config: WorkerConfig): Promise<void> {
    await this.coll.updateOne({ name }, { $set: { name, ...config } }, { upsert: true });
  }

  /** Patch only the supplied fields on an existing config doc.
   * Uses upsert so a patch before first-boot (when no doc exists yet)
   * doesn't silently no-op. `name` is set on insert via $setOnInsert.
   *
   * Resuming (`paused: false`) also clears `pause_reason`: the reason
   * describes the pause it came with, and every resume path — the button,
   * `PATCH /config`, the in-process registry — goes through here, so none
   * of them can leave a stale explanation on a running stage. A stage that
   * pauses itself again writes a fresh reason with its `paused: true`. */
  async patch(name: string, partial: Partial<WorkerConfig>): Promise<void> {
    const fields = partial.paused === false ? { ...partial, pause_reason: null } : partial;
    await this.coll.updateOne(
      { name },
      { $set: fields, $setOnInsert: { name } as Partial<WorkerConfigDoc> },
      { upsert: true },
    );
  }
}
