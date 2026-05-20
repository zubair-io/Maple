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

import type { Collection } from "mongodb";
import type { WorkerConfig } from "./run-stage.ts";

export interface WorkerConfigDoc extends WorkerConfig {
  /** Stage name — the unique key for this collection. */
  name: string;
}

export class WorkerConfigRepo {
  constructor(private readonly coll: Collection<WorkerConfigDoc>) {}

  /** Load a single stage config. Returns null when not yet seeded. */
  async load(name: string): Promise<WorkerConfig | null> {
    const doc = await this.coll.findOne({ name });
    if (!doc) return null;
    return {
      concurrency: doc.concurrency,
      pollIntervalMs: doc.pollIntervalMs,
      batchSize: doc.batchSize,
      maxAttempts: doc.maxAttempts,
      paused: doc.paused,
      last_seen_target_version: doc.last_seen_target_version,
    };
  }

  /** Upsert (insert-or-replace) a stage config. */
  async upsert(name: string, config: WorkerConfig): Promise<void> {
    await this.coll.updateOne(
      { name },
      { $set: { name, ...config } },
      { upsert: true },
    );
  }

  /** Patch only the supplied fields on an existing config doc.
   * Uses upsert so a patch before first-boot (when no doc exists yet)
   * doesn't silently no-op. `name` is set on insert via $setOnInsert. */
  async patch(name: string, partial: Partial<WorkerConfig>): Promise<void> {
    await this.coll.updateOne(
      { name },
      { $set: partial, $setOnInsert: { name } as Partial<WorkerConfigDoc> },
      { upsert: true },
    );
  }
}
