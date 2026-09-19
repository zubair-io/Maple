/**
 * `worker_config` now lives at `db/repos/worker-config.repo.ts`.
 *
 * This file is what is left of the MongoDB repository after the cutover
 * (#3787): no statements, no collection, nothing but the names, so the fifteen
 * modules outside this bucket that import `WorkerConfigRepo` /
 * `loadWorkerConfigSafe` from here keep compiling while the coordinator
 * rewrites their import lines in one pass. It carries no MongoDB code path,
 * reachable or otherwise.
 *
 * The one behavioural difference a caller can see is the constructor:
 * `new WorkerConfigRepo()` takes no collection now, and the optional argument
 * it does accept is a test's SQLite handle.
 */

export { loadWorkerConfigSafe } from '../db/repos/worker-config.repo.ts';
