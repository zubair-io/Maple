/**
 * Per-stage wall-clock timings for one search request (#4443).
 *
 * A text search's latency is spread across services the route only sees as
 * awaited promises — the query embedding, the Meilisearch call, the row
 * re-fetch, the facet groupings, the people lookups — and a single total says
 * nothing about which of them is the cost on production. The list and facets
 * routes record each stage as it is awaited and put the whole breakdown on
 * their log line, so the production log answers the question instead of a
 * guess.
 *
 * Stages are recorded by how long their own promise took, so two that run
 * concurrently each report their own duration and the total is the request's,
 * not their sum. A stage that is never awaited is simply absent.
 */

export interface StageTimings {
  /** Runs `work` and records how long it took under `stage`. */
  time<T>(stage: string, work: () => Promise<T>): Promise<T>;
  /** Records a duration measured elsewhere. */
  record(stage: string, ms: number): void;
  /** Every recorded stage plus `totalMs` since the timings were created. */
  report(): Record<string, number>;
}

const tenths = (ms: number): number => Math.round(ms * 10) / 10;

export function stageTimings(now: () => number = () => performance.now()): StageTimings {
  const started = now();
  const stages = new Map<string, number>();
  const record = (stage: string, ms: number): void => {
    stages.set(stage, tenths((stages.get(stage) ?? 0) + ms));
  };
  return {
    record,
    async time<T>(stage: string, work: () => Promise<T>): Promise<T> {
      const from = now();
      try {
        return await work();
      } finally {
        record(stage, now() - from);
      }
    },
    report(): Record<string, number> {
      return { ...Object.fromEntries(stages), totalMs: tenths(now() - started) };
    },
  };
}
