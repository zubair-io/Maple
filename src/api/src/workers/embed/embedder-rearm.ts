import { EMBED_STAGE } from '../../db/repos/assets.stage-rearm.ts';
import { rearmEmbedForEmbedderChange } from '../../db/repos/asset-vectors.repo.ts';
import { WorkerConfigRepo } from '../../db/repos/worker-config.repo.ts';
import type { OllamaEmbedTarget } from '../../enrichment/ollama-embed-client.ts';
import { currentEmbedderTarget } from './embedder-target.ts';

const SWEEP_INTERVAL_MS = 60_000;

const sweep = { lastAt: 0 };

/**
 * Re-queues vectors written by a different model or endpoint than `target`. Dead-lettered rows
 * are revived too, but only when the target differs from what the stage last recorded (in
 * `worker_config.ai_model`), so permanently failing assets are not retried on every sweep.
 */
export async function rearmForEmbedderTarget(target: OllamaEmbedTarget): Promise<void> {
  const fingerprint = `${target.model} @ ${target.url}`;
  const repo = new WorkerConfigRepo();
  const targetChanged = (await repo.load(EMBED_STAGE))?.ai_model !== fingerprint;
  await rearmEmbedForEmbedderChange(target, { includeDead: targetChanged });
  if (targetChanged) await repo.patch(EMBED_STAGE, { ai_model: fingerprint });
}

/** The stage's per-tick hook: checks for an embedder change at most once a minute, busy or idle. */
export async function sweepEmbedderChange(
  _processedThisTick: number,
  _idle: boolean,
  now: number = Date.now(),
): Promise<void> {
  if (now - sweep.lastAt < SWEEP_INTERVAL_MS) return;
  sweep.lastAt = now;
  await rearmForEmbedderTarget(await currentEmbedderTarget());
}
