/**
 * Persistence for runtime indexer configuration (worker pool sizes).
 *
 * Stored in MongoDB so a container restart preserves whatever the operator
 * tuned via `PUT /api/indexer/config`. The collection holds a single
 * document keyed by `_id: "workers"`.
 */

import { getDb } from "../db/client.ts";
import type { Stage } from "./channel.ts";

const COLL = "indexer_config";
const DOC_ID = "workers";

export type WorkerConfig = Partial<Record<Stage, number>>;

export async function loadWorkerConfig(): Promise<WorkerConfig | null> {
  try {
    const db = await getDb();
    const doc = await db
      .collection<{ _id: string; workers: WorkerConfig }>(COLL)
      .findOne({ _id: DOC_ID });
    return doc?.workers ?? null;
  } catch {
    return null;
  }
}

export async function saveWorkerConfig(patch: WorkerConfig): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  const db = await getDb();
  const set: Record<string, unknown> = { updatedAt: Date.now() };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) set[`workers.${k}`] = v;
  }
  await db
    .collection(COLL)
    .updateOne({ _id: DOC_ID }, { $set: set }, { upsert: true });
}
