// Bun Worker entry point that owns the synchronous online-clustering loop.
// Lives on its own JS thread so `clusterEmbeddings` — a pure, CPU-bound
// O(N·K·D) pass over every unassigned face embedding — never blocks the
// main HTTP thread. Before this worker, a clustering pass (fired every
// ~500 embedded faces during a bulk import) froze the entire Bun event
// loop for the whole computation, stalling every request including static
// HTML and /api/health. See `cluster-pool.ts` for the manager side.
//
// The worker imports the *pure* core (`./cluster-embeddings.ts`, no Mongo),
// so its output is bit-identical to running the function in-process — the
// move off-thread changes timing only, never results.

import { clusterEmbeddings, type OnlineClusterOptions } from './cluster-embeddings.ts';

interface ClusterRequest {
  type: 'cluster';
  id: number;
  embeddings: Float32Array[];
  options: OnlineClusterOptions;
}

self.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data as ClusterRequest;
  if (msg?.type !== 'cluster') return;
  try {
    const result = clusterEmbeddings(msg.embeddings, msg.options);
    self.postMessage({ type: 'cluster', id: msg.id, ok: true, result });
  } catch (e) {
    self.postMessage({
      type: 'cluster',
      id: msg.id,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
});
