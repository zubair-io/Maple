/**
 * The worker-status singleton now lives at
 * `db/repos/worker-status.repo.ts`.
 *
 * What survives here after the cutover (#3787) is the name, so
 * `routes/enrichment.ts` — the one importer outside this bucket — keeps
 * compiling until the coordinator rewrites its import line. No MongoDB code
 * path remains, reachable or otherwise.
 */

export { readWorkerStatus } from '../db/repos/worker-status.repo.ts';
