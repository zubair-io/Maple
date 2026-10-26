import { EMBED_STAGE } from '../../db/repos/assets.stage-rearm.ts';
import { rearmEmbedForForeignVectors } from '../../db/repos/asset-vectors.repo.ts';
import { WorkerConfigRepo } from '../../db/repos/worker-config.repo.ts';
import { BUNDLED_EMBEDDER } from './bundled-embedder.ts';

const SWEEP_INTERVAL_MS = 60_000;

const sweep = { lastAt: 0 };

/**
 * Re-queues vectors another model wrote. Dead-lettered rows are revived too, but only the first
 * time the stage runs with the bundled embedder (`worker_config.ai_model` still names the Ollama
 * or OpenAI endpoint it last used), so permanently failing assets are not retried on every sweep.
 */
export async function rearmForBundledEmbedder(): Promise<void> {
  const repo = new WorkerConfigRepo();
  const embedderChanged = (await repo.load(EMBED_STAGE))?.ai_model !== BUNDLED_EMBEDDER;
  await rearmEmbedForForeignVectors({ includeDead: embedderChanged });
  if (embedderChanged) await repo.patch(EMBED_STAGE, { ai_model: BUNDLED_EMBEDDER });
}

/** The stage's per-tick hook: checks for foreign vectors at most once a minute, busy or idle. */
export async function sweepForeignVectors(
  _processedThisTick: number,
  _idle: boolean,
  now: number = Date.now(),
): Promise<void> {
  if (now - sweep.lastAt < SWEEP_INTERVAL_MS) return;
  sweep.lastAt = now;
  await rearmForBundledEmbedder();
}
