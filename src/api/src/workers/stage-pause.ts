/**
 * Pause a stage from inside the pipeline with an operator-visible reason.
 *
 * The operator's pause button writes `worker_config.<name>.paused` and nothing
 * else; a stage that pauses ITSELF must say why, or Settings → Workers shows a
 * paused row with no explanation and the operator's first move is to resume it
 * straight back into the same failure. The reason lives on the same DB-backed
 * `worker_config` doc (`pause_reason`), so it survives restarts and is read by
 * `GET /api/workers/status` exactly like the other knobs. Any resume path —
 * the button, `PATCH /config { paused: false }`, the in-process registry —
 * clears it (see `WorkerConfigRepo.patch`).
 *
 * First caller: the `meili` stage when Meilisearch's address policy rejects the
 * embedding server (#3315). Submitting more embed batches there cannot
 * succeed and each one holds Meilisearch's task queue for minutes.
 */

import { getDb } from '../db/client.ts';
import { stageRegistry } from './registry.ts';
import { WorkerConfigRepo, type WorkerConfigDoc } from './worker-config.repo.ts';

export async function pauseStageWithReason(name: string, reason: string): Promise<void> {
  const db = await getDb();
  const repo = new WorkerConfigRepo(db.collection<WorkerConfigDoc>('worker_config'));
  await repo.patch(name, { paused: true, pause_reason: reason });
  // When the stage's poll loop runs in THIS process (the worker tier), apply
  // the new config now rather than on its next throttled re-read, so the
  // remainder of the current claim batch is the last work it dispatches.
  // Best-effort: the API process has no live registry entry and the
  // worker's own 2 s config re-read covers that case.
  await stageRegistry.notifyConfigChanged(name);
}
