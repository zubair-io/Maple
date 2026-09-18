/**
 * Single-worker clustering pool — off-main-thread online clustering, so that
 * neither the synchronous O(N·K·D) comparison pass nor the O(N·D) embedding
 * load and normalise ever blocks an HTTP handler.
 *
 * One worker rather than N: the online pass is order-sensitive and inherently
 * sequential — a face competes against every cluster the faces before it opened
 * — so it cannot be sharded without changing the answer. The `ClusterCoordinator`
 * already single-flights passes, so there is never more than one in flight.
 *
 * The implementation is `db/sqlite/repos/people.cluster-pool.ts`, which differs
 * from the Mongo original in one load-bearing way: the worker is handed a
 * database *path*, not a connection. Giving the clustering thread its own
 * connection would give it its own SQLite writer, and the pass does write —
 * `recomputeCentroids` persists refreshed centroids before the seeds are read
 * back. So the worker opens the file read-only and sends every write to the
 * host's single writer. `db/sqlite/worker-db.ts` has the full argument, and
 * `cluster.worker.ts` records what that changed about the dispatch message.
 *
 * `WorkerMongoConfig` has no successor: there are no connection parameters to
 * resolve on the main thread any more, which is what it existed to carry.
 */

export {
  prepareClusteringPassOffThread,
  shutdownClusterPool,
} from '../db/sqlite/repos/people.cluster-pool.ts';
export type { ClusterDispatch, PrepareResult } from '../db/sqlite/repos/people.cluster-pool.ts';
