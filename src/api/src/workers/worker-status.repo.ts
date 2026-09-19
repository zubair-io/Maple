/**
 * The worker-status singleton now lives at
 * `db/sqlite/repos/worker-status.repo.ts`.
 *
 * What survives here after the cutover (#3787) is the name, so
 * `routes/enrichment.ts` — the one importer outside this bucket — keeps
 * compiling until the coordinator rewrites its import line. No MongoDB code
 * path remains, reachable or otherwise.
 */

export {
  pokeStatusCountsDemand,
  readStatusCountsDemand,
  readWorkerStatus,
  writeStatusCounts,
  writeWorkerStatus,
} from '../db/sqlite/repos/worker-status.repo.ts';
export type {
  FaceModelsStatusSnapshot,
  StatusCountsSnapshot,
  WorkerStatusRead,
} from '../db/sqlite/repos/worker-status.repo.ts';
