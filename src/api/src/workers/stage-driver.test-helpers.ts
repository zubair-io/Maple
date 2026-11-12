import { setTimeout as sleep } from 'node:timers/promises';
import type { RunStageHandle } from './run-stage.ts';

/** Stops the drive, then each stage. */
export interface StageDrive {
  stop: () => Promise<void>;
}

async function step(stage: RunStageHandle): Promise<void> {
  if (await stage.hasWork()) await stage.runSlice();
  else await stage.idle();
}

/**
 * Does what the stage lane and its workflow do, without a Temporal server: a
 * slice while a stage has work, an idle call while it has none. For suites
 * about what a stage does with its assets rather than how it is scheduled.
 */
export function driveStages(stages: readonly RunStageHandle[], intervalMs = 20): StageDrive {
  const halt = new AbortController();
  const loop = (async () => {
    while (!halt.signal.aborted) {
      await Promise.all(stages.map((stage) => step(stage).catch(() => {})));
      await sleep(intervalMs, undefined, { signal: halt.signal }).catch(() => {});
    }
  })();
  return {
    stop: async () => {
      halt.abort();
      await Promise.all(stages.map((stage) => stage.stop()));
      await loop;
    },
  };
}
