/**
 * Worker-slot pool — bounded concurrency for a stage's per-tick dispatch.
 *
 * Extracted from run-stage.ts to keep that file under the size budget. A pure,
 * self-contained generic helper: run `run(item)` across `items` with at most
 * `limit` in flight at once. Resolves when every item has been processed.
 */
export async function dispatchPool<T>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers: Promise<void>[] = [];
  const concurrency = Math.max(1, Math.min(limit, queue.length));
  for (let i = 0; i < concurrency; i++) {
    workers.push(
      (async () => {
        while (queue.length > 0) {
          const item = queue.shift();
          if (item === undefined) return;
          await run(item);
        }
      })(),
    );
  }
  await Promise.all(workers);
}
