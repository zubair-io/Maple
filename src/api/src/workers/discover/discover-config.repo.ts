/**
 * `discover` worker config in the shared `worker_config` collection (the same
 * collection stages + missing-reaper use), keyed by name. Operator-tunable on
 * /settings/workers — NOT an env var (repo convention).
 */
// The `worker_config` collection is shared with the stages (keyed by `name`).
// There is no exported accessor — open it directly, exactly as the PATCH route
// does (`routes-main.ts`: `const coll = (await getDb()).collection('worker_config')`).
// `WorkerConfigRepo.load()` only projects the stage fields (concurrency/
// maxAttempts/paused/last_seen_target_version), so discover reads its own
// `{paused, sweepDirIntervalMs}` here rather than reusing it.
import { getDb } from '../../db/client.ts';

export interface DiscoverConfig {
  paused: boolean;
  sweepDirIntervalMs: number;
}
const DEFAULTS: DiscoverConfig = { paused: false, sweepDirIntervalMs: 250 };
const NAME = 'discover';

interface DiscoverConfigDoc {
  name: string;
  paused?: boolean;
  sweepDirIntervalMs?: number;
}

export async function loadDiscoverConfig(): Promise<DiscoverConfig> {
  const coll = (await getDb()).collection<DiscoverConfigDoc>('worker_config');
  const doc = await coll.findOne({ name: NAME });
  return {
    paused: doc?.paused ?? DEFAULTS.paused,
    sweepDirIntervalMs: doc?.sweepDirIntervalMs ?? DEFAULTS.sweepDirIntervalMs,
  };
}

export async function patchDiscoverConfig(patch: Partial<DiscoverConfig>): Promise<void> {
  const coll = (await getDb()).collection<DiscoverConfigDoc>('worker_config');
  await coll.updateOne({ name: NAME }, { $set: { name: NAME, ...patch } }, { upsert: true });
}
