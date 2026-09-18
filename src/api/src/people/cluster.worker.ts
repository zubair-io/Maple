// Bun Worker entry point for the clustering LOAD + COMPUTE stage. It lives on
// its own thread so neither the O(N·D) embedding decode + normalise nor the
// synchronous O(N·K·D) comparison pass ever blocks the HTTP thread.
//
// The handler itself is `db/sqlite/repos/people.cluster.worker.ts`; importing
// it here registers its `message` listener, so a `new Worker(...)` pointed at
// this path gets the SQLite stage. This file is kept only as that stable entry
// path.
//
// ## The dispatch protocol changed with the store
//
// The Mongo worker opened its OWN database connection from `{ uri, dbName }`
// in the dispatch message. Reproducing that against SQLite would give the
// clustering thread an independent WRITER — and the pass does write, since
// `recomputeCentroids` persists refreshed centroids before the seeds are read
// back. Two writers is exactly what the pool's single-writer design exists to
// prevent. The SQLite worker therefore takes a database *path*, opens it
// read-only for queries, and sends every write to the host thread's one
// writer; `db/sqlite/worker-db.ts` has the full argument.
//
// So a `prepare` message now carries `path`, not `mongo`. The manager that
// speaks that protocol is `db/sqlite/repos/people.cluster-pool.ts` — NOT the
// Mongo-era `./cluster-pool.ts`, which still posts `{ mongo }` and no longer
// has a worker that understands it. `clustering-job.ts` already dispatches
// through the SQLite pool; retiring `./cluster-pool.ts` is the last step.
//
// Nothing a logger can reach may enter this import graph: pino inside a Worker
// thread never answers its first message, and one `log.warn` turned a 214 ms
// test into a hard timeout. See `db/sqlite/busy-retry.ts`.

import '../db/sqlite/repos/people.cluster.worker.ts';
