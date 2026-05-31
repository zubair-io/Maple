// Bun Worker entry point that owns the clustering LOAD + COMPUTE stage.
// Lives on its own JS thread so neither the O(N·D) embedding decode +
// normalise nor the synchronous O(N·K·D) `clusterEmbeddings` pass ever blocks
// the main HTTP thread. Before #710, the compute moved off-thread but the
// embedding load + normalize + `recomputeCentroids` mean stayed on main and
// still froze the loop for 1–5 s per pass on thousands of faces.
//
// The worker opens its OWN Mongo connection: the main thread resolves the
// connection params (so per-process / per-test `MAPLE_MONGO_URI` /
// `MAPLE_MONGO_DB` overrides are honoured — they are NOT reliably inherited
// across the Worker boundary) and passes them in the dispatch message. We set
// them into `process.env` BEFORE the first `getDb()` so the worker's lazy
// client connects to the right database.
//
// The worker runs the SAME `prepareClusteringPass` core the in-process
// fallback runs, against the SAME Mongo data, so its output is bit-identical
// to running the function on the main thread — the move off-thread changes
// timing only, never results. Only a small serializable result crosses back
// (assignments + updated centroids + per-face envelopes); the embeddings
// themselves never leave the worker. See `cluster-pool.ts` for the manager.

import type { PreparedClusteringPass } from './cluster-load.ts';

interface PrepareRequest {
  type: 'prepare';
  id: number;
  similarityThreshold: number;
  mongo: { uri: string; dbName: string };
}

self.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data as PrepareRequest;
  if (msg?.type !== 'prepare') return;
  void runPrepare(msg);
});

/** The `(uri, dbName)` the worker's lazy Mongo client is currently connected
 *  to, or null before the first connect. `getDb()` caches its `_db` after the
 *  first connect, so to honour a per-message config change we must drop the
 *  cached connection when the target differs. In production this NEVER fires
 *  (the db is fixed at boot); it exists so the worker actually connects to the
 *  database each message names, instead of silently reusing the first one —
 *  which is also what keeps cross-DB test files isolated. The coordinator's
 *  single-flight guarantees one pass at a time, so there's no concurrent
 *  `closeDb` race. */
let connectedTarget: string | null = null;

async function runPrepare(msg: PrepareRequest): Promise<void> {
  try {
    const target = `${msg.mongo.uri}::${msg.mongo.dbName}`;
    if (connectedTarget !== null && connectedTarget !== target) {
      // The named database changed since the last pass — drop the cached
      // client so the next `getDb()` reconnects to the new target.
      const { closeDb } = await import('../db/client.ts');
      await closeDb();
    }
    // Point this worker's lazy Mongo client at the right database. Must be
    // set before the first `getDb()` inside `prepareClusteringPass`.
    process.env.MAPLE_MONGO_URI = msg.mongo.uri;
    process.env.MAPLE_MONGO_DB = msg.mongo.dbName;
    connectedTarget = target;
    // Imported lazily AFTER env is set so any module-load-time reads see the
    // right values (the db client reads env at connect time, but keeping the
    // import here also avoids spinning up a connection on workers that never
    // receive a `prepare` message).
    const { prepareClusteringPass } = await import('./cluster-load.ts');
    const result: PreparedClusteringPass = await prepareClusteringPass(msg.similarityThreshold);
    self.postMessage({ type: 'prepare', id: msg.id, ok: true, result });
  } catch (e) {
    self.postMessage({
      type: 'prepare',
      id: msg.id,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
