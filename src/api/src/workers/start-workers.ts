/**
 * Worker-tier lifecycle — extracted from `src/api/src/index.ts`'s boot IIFE.
 *
 * `startWorkers()` brings up every subsystem that belongs in the worker tier:
 *   - stage orchestrator (10 stages)
 *   - discover sweep (in-process, no child spawn)
 *   - cache-gc sweep
 *   - FFI decode pool sizing
 *   - geocode / face / describe enrichment workers
 *   - Meilisearch stage-side config + index bootstrap
 *   - job runner
 *   - import runner
 *
 * `stopWorkers()` tears them all down in the correct order, mirroring the
 * `shutdown()` function in `index.ts`.
 *
 * This module is NOT called from `index.ts` in Task 1. It is extracted here
 * so that Task 2 can wire it into a standalone worker-main.ts entry and
 * Task 3 can spawn that entry as a child process.
 *
 * Closes #890.
 */

import { child as childLogger } from '../log.ts';
import { foldersCollection } from '../db/client.ts';
import { startAllStages, stopAllStages } from './orchestrator.ts';
import { stageRegistry } from './registry.ts';
import { registerDiscoverWorker, unregisterDiscoverWorker } from './discover/register.ts';
import { startDiscover, type DiscoverHandle } from './discover/index.ts';
import { sweepOrphanedCaches } from './cache-gc.ts';
import { bootstrapFfiPool } from '../ffi/ffi-pool-bootstrap.ts';
import { ffiPool } from '../ffi/ffi-pool.ts';
import { imgdecodePool } from '../thumbs/imgdecode-pool.ts';
import { startGeocodeWorker, stopGeocodeWorker } from '../enrichment/bootstrap.ts';
import { startFaceWorker, stopFaceWorker } from '../enrichment/face-bootstrap.ts';
import { getFaceModelsStatus } from '../enrichment/face-models.ts';
import { startDescribeWorker, stopDescribeWorker } from '../enrichment/describe-bootstrap.ts';
import { meilisearchClient, reconfigureMeilisearch } from '../enrichment/meilisearch-client.ts';
import { loadEnrichmentConfig } from '../enrichment/enrichment-config.repo.ts';
import { resolveEnrichmentConfig } from '../enrichment/enrichment-config.resolve.ts';
import { startJobRunner, stopJobRunner } from '../job-runner/runner.ts';
import { startImportRunner, stopImportRunner } from '../imports/worker.ts';
import { writeWorkerStatus } from './worker-status.repo.ts';
import { startMaintenanceJobs, stopMaintenanceJobs } from './maintenance.ts';
import { flushPendingMirrorOps } from '../fs/mirrored.ts';

const log = childLogger('workers');

// ---------------------------------------------------------------------------
// Module-level handles — kept so stopWorkers() can reach them
// ---------------------------------------------------------------------------

let _discoverHandle: DiscoverHandle | null = null;
/** Unref'd timer that publishes stageRegistry.statuses() to worker_status in Mongo. */
let _statusInterval: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// startWorkers
// ---------------------------------------------------------------------------

export async function startWorkers(): Promise<void> {
  try {
    await startAllStages();
    log.info(stageRegistry.statuses(), 'Worker stages running');
  } catch (err) {
    log.warn({ err }, 'Worker stages failed to start');
  }

  try {
    const foldersColl = await foldersCollection();
    const folders = await foldersColl.find({}, { projection: { path: 1 } }).toArray();
    const discoverRoots = folders.map((f) => f.path).filter(Boolean);
    if (discoverRoots.length > 0) {
      registerDiscoverWorker();
      _discoverHandle = await startDiscover({ roots: discoverRoots });
      log.info({ roots: discoverRoots }, 'discover sweep started in-process');
    }

    // Fire-and-forget cache-gc sweep per library. Reaps both legacy
    // sha256_prefix16-keyed thumbs (always orphans post-PR-3) and stale
    // maple_id-keyed files for hard-deleted or relocated assets. See
    // `workers/cache-gc.ts` for why no migration sentinel.
    for (const root of discoverRoots) {
      void (async (libRoot: string) => {
        try {
          const result = await sweepOrphanedCaches(libRoot);
          log.info({ libRoot, ...result }, 'cache-gc swept');
        } catch (err) {
          log.warn(
            { libRoot, err: err instanceof Error ? err.message : err },
            'cache-gc sweep failed',
          );
        }
      })(root);
    }
  } catch (err) {
    log.warn({ err }, 'Discover failed to start');
  }

  await bootstrapFfiPool(); // size the FFI decode pool (DB > env > default 1)

  // Slow-tier enrichment workers run in-process. Each one's failure is
  // isolated — the operator recovers via /settings/enrichment without a
  // restart. Concurrent boot avoids head-of-line blocking (e.g. a slow
  // Nominatim health check delaying the face model preload).
  await Promise.all([
    (async () => {
      try {
        await startGeocodeWorker();
      } catch (err) {
        log.error({ err }, 'geocode worker failed to start; fix via /settings/enrichment');
      }
    })(),
    (async () => {
      try {
        await startFaceWorker();
      } catch (err) {
        log.error({ err }, 'face worker failed to start; fix via /settings/enrichment');
      }
    })(),
    (async () => {
      try {
        await startDescribeWorker();
      } catch (err) {
        log.error({ err }, 'describe worker failed to start; fix via /settings/enrichment');
      }
    })(),
  ]);

  try {
    // Meilisearch sidecar — stage side. Resolve the URL from the DB-backed
    // enrichment config first (operator can set it via /settings/workers); a
    // saved value wins over the MAPLE_MEILISEARCH_URL env var.
    // reconfigureMeilisearch rebuilds the shared client so the meili stage
    // agrees. ensureIndex() creates the index if absent.
    //
    // NOTE: index.ts also calls reconfigureMeilisearch on its own for the
    // search route. Since both run in the same process for now (Task 1),
    // either call suffices; the stage side call here covers the workers.
    const resolvedMeili = resolveEnrichmentConfig(await loadEnrichmentConfig());
    reconfigureMeilisearch(
      resolvedMeili.meilisearch_url,
      resolvedMeili.meilisearch_api_key,
      resolvedMeili.meilisearch_task_timeout_seconds * 1000,
    );
    const meili = meilisearchClient();
    if (!meili.isConfigured()) {
      log.info('Meilisearch URL unset (DB + MAPLE_MEILISEARCH_URL) — sidecar disabled');
    } else if (!(await meili.health())) {
      log.warn(
        'Meilisearch health check failed; search will fall back to Mongo $text until the service is reachable',
      );
    } else {
      await meili.ensureIndex();
      log.info('Meilisearch sidecar ready');
    }
  } catch (err) {
    log.warn({ err }, 'Meilisearch boot failed; search will fall back to Mongo $text');
  }

  try {
    // JobRunner — sibling subsystem to the indexer pipeline for
    // user-triggered long-running work (export, batch reprocess).
    startJobRunner();
  } catch (err) {
    log.warn({ err }, 'JobRunner failed to start');
  }

  try {
    // ImportRunner — claims pending `imports` and copies server-local
    // folders into a library (ticket #742).
    startImportRunner();
  } catch (err) {
    log.warn({ err }, 'ImportRunner failed to start');
  }

  // Library-wide maintenance jobs (trash-gc + missing-reaper + migration).
  // Moved here from index.ts so maintenance load is off the API event loop and
  // these workers are gated by MAPLE_INDEXER_AUTOSTART like everything else.
  try {
    startMaintenanceJobs();
  } catch (err) {
    log.warn({ err }, 'Maintenance jobs failed to start');
  }

  // Publish stageRegistry.statuses() to the worker_status Mongo doc every 2 s
  // so the API process (which has an empty in-process registry) can serve
  // GET /api/workers/status.  The face-models loader status rides along in the
  // same write — the ONNX sessions load in THIS worker process, so the API
  // process can't read the loader's in-process `liveStatus`; mirroring it here
  // is what lets the /settings/enrichment badge reflect the real load state.
  // The timer is unref'd so it doesn't prevent a clean exit when stopWorkers()
  // clears it.
  _statusInterval = setInterval(() => {
    const face = getFaceModelsStatus();
    writeWorkerStatus(stageRegistry.statuses(), Date.now(), {
      kind: face.kind,
      errorDetail: face.errorDetail,
    }).catch(() => {});
  }, 2000);
  _statusInterval.unref();
}

// ---------------------------------------------------------------------------
// stopWorkers
// ---------------------------------------------------------------------------

export async function stopWorkers(): Promise<void> {
  // Clear the status-publishing interval before tearing down subsystems so
  // we don't fire a best-effort write after the DB connection closes.
  if (_statusInterval !== null) {
    clearInterval(_statusInterval);
    _statusInterval = null;
  }

  // Stop maintenance jobs first so their timers don't fire mid-shutdown.
  try {
    stopMaintenanceJobs();
  } catch (e) {
    log.warn({ err: e }, 'error stopping maintenance jobs');
  }

  // Stop the discover sweep (in-process handle).
  try {
    await _discoverHandle?.stop();
    _discoverHandle = null;
    unregisterDiscoverWorker();
  } catch (e) {
    log.warn({ err: e }, 'error stopping discover');
  }

  // Stop the in-process stage runners so any in-flight handler can drain
  // before the process exits.
  try {
    await stopAllStages();
  } catch (e) {
    log.warn({ err: e }, 'error stopping worker stages');
  }

  // Reap the FFI decode child processes.
  try {
    ffiPool().shutdown();
  } catch (e) {
    log.warn({ err: e }, 'error shutting down FFI decode pool');
  }

  // Reap the non-RAW (sharp + heic-convert) decode child process.
  try {
    imgdecodePool().shutdown();
  } catch (e) {
    log.warn({ err: e }, 'error shutting down imgdecode pool');
  }

  await Promise.all([
    (async () => {
      try {
        await stopGeocodeWorker();
      } catch (e) {
        log.warn({ err: e }, 'error stopping geocode worker');
      }
    })(),
    (async () => {
      try {
        await stopFaceWorker();
      } catch (e) {
        log.warn({ err: e }, 'error stopping face worker');
      }
    })(),
    (async () => {
      try {
        await stopDescribeWorker();
      } catch (e) {
        log.warn({ err: e }, 'error stopping describe worker');
      }
    })(),
    (async () => {
      try {
        await stopJobRunner();
      } catch (e) {
        log.warn({ err: e }, 'error stopping job runner');
      }
    })(),
    (async () => {
      try {
        await stopImportRunner();
      } catch (e) {
        log.warn({ err: e }, 'error stopping import runner');
      }
    })(),
  ]);

  // Every mirrored writer in this tier (migration relocations, import copies,
  // trash deletes) is stopped now — flush their scheduled-but-not-yet-run mirror
  // ops so a graceful shutdown doesn't drop in-flight copies. Best-effort; the
  // scan/copy reconcile catches anything still missed.
  try {
    await flushPendingMirrorOps();
  } catch (e) {
    log.warn({ err: e }, 'error flushing pending mirror ops');
  }
}
