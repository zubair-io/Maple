/**
 * Worker-tier lifecycle — extracted from `src/api/src/index.ts`'s boot IIFE.
 *
 * `startWorkers()` brings up every subsystem that belongs in the worker tier:
 *   - stage orchestrator (boots every pipeline stage; Temporal schedules them)
 *   - discover registration (the sweep itself runs on the Temporal host)
 *   - cache-gc sweep
 *   - FFI decode pool sizing
 *   - geocode / face / describe enrichment workers
 *   - worker-side enrichment config refresh
 *   - Temporal host (user-triggered jobs, folder imports, pipeline stages, the discover sweep and scheduled maintenance)
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
import { listLibraryRoots } from '../db/repos/folders.repo.ts';
import { startAllStages, stopAllStages } from './orchestrator.ts';
import { stageRegistry } from './registry.ts';
import { registerDiscoverWorker, unregisterDiscoverWorker } from './discover/register.ts';
import { sweepOrphanedCaches } from './cache-gc.ts';
import { bootstrapFfiPool, stopFfiPoolConfigRefresh } from '../ffi/ffi-pool-bootstrap.ts';
import { decodeMemoryBudget } from '../ffi/decode-memory-budget.ts';
import { ffiPool } from '../ffi/ffi-pool.ts';
import { startGeocodeWorker, stopGeocodeWorker } from '../enrichment/bootstrap.ts';
import { startFaceWorker, stopFaceWorker } from '../enrichment/face-bootstrap.ts';
import { getFaceModelsStatus } from '../enrichment/face-models.ts';
import { startDescribeWorker, stopDescribeWorker } from '../enrichment/describe-bootstrap.ts';
import { writeWorkerMemory, writeWorkerStatus } from '../db/repos/worker-status.repo.ts';
import { childMemoryReports } from '../runtime/child-process-worker.ts';
import {
  startMemoryTelemetry,
  stopMemoryTelemetry,
  type ProcessMemoryRow,
} from '../runtime/memory-telemetry.ts';
import { startStatusCountsRefresher, type RefresherHandle } from './status-counts.ts';
import { startMaintenanceSupport, stopMaintenanceSupport } from './maintenance/support.ts';
import { flushPendingMirrorOps } from '../fs/mirrored.ts';
import {
  refreshWorkerEnrichmentConfig,
  startWorkerEnrichmentConfigRefresh,
  stopWorkerEnrichmentConfigRefresh,
} from './enrichment-config-refresh.ts';

const log = childLogger('workers');

// ---------------------------------------------------------------------------
// Module-level handles — kept so stopWorkers() can reach them
// ---------------------------------------------------------------------------

/** Unref'd timer that publishes stageRegistry.statuses() to the `worker_status` row. */
let _statusInterval: ReturnType<typeof setInterval> | null = null;
let _countsRefresher: RefresherHandle | null = null;
let _stopTemporalHost: (() => Promise<void>) | null = null;

// ---------------------------------------------------------------------------
// startWorkers
// ---------------------------------------------------------------------------

async function startSubsystem(start: () => unknown, failureMessage: string): Promise<void> {
  try {
    await start();
  } catch (err) {
    log.warn({ err }, failureMessage);
  }
}

/** What the worker tier is holding in flight, folded into its memory line
 * (#4445): per-stage in-flight counts and the FFI pool's busy/queued depth, so
 * a growing RSS can be read against what the process was doing. */
function workerLoadSnapshot(): Record<string, unknown> {
  const stages = Object.fromEntries(
    Object.entries(stageRegistry.statuses()).map(([name, s]) => [name, s.inFlight]),
  );
  return { stages, ffi: ffiPool().stats(), decodeBudget: decodeMemoryBudget().snapshot() };
}

/** The worker's own sample plus whatever its native children last relayed,
 * persisted so the API process can show them on Settings → Workers. */
function persistWorkerMemory(row: ProcessMemoryRow): void {
  writeWorkerMemory({
    rows: [row, ...childMemoryReports()],
    decodeBudget: decodeMemoryBudget().snapshot(),
  }).catch(() => {});
}

export async function startWorkers(): Promise<void> {
  // Before any stage runs: a decode enqueued while the budget is still
  // unconfigured skips admission for good (#5467).
  await bootstrapFfiPool();

  await startSubsystem(async () => {
    await startAllStages();
    log.info(stageRegistry.statuses(), 'Worker stages running');
  }, 'Worker stages failed to start');

  await startSubsystem(async () => {
    // Registered with or without roots: the Temporal host starts a root's sweep
    // as soon as the folder is added, and its pause switch applies from then on.
    registerDiscoverWorker();
    const discoverRoots = (await listLibraryRoots()).map((root) => root.path).filter(Boolean);

    // Fire-and-forget cache-gc sweep per library: reaps orphans for
    // hard-deleted or relocated assets and leaves retired hashed/versioned
    // names untouched (#4928). See `workers/cache-gc.ts` for why no sentinel.
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
  }, 'Discover registration or cache-gc failed to start');

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
    await refreshWorkerEnrichmentConfig(true);
    startWorkerEnrichmentConfigRefresh();
  } catch (err) {
    log.warn(
      { err },
      'worker enrichment config refresh failed at boot; the periodic refresh retries',
    );
    startWorkerEnrichmentConfigRefresh();
  }

  // Before the Temporal host, so the maintenance workers' Settings → Workers
  // entries exist by the time their first scheduled pass reports through them.
  startMaintenanceSupport();

  // User-triggered jobs (export, batch sync, pano, restore), folder imports,
  // the pipeline stages booted above, the discover sweep and scheduled
  // maintenance (trash-gc, missing-reaper, migration, session clean-up, the
  // nightly database backup, …) run on Temporal. Imported here, not at the top:
  // the SDK loads a native bridge on import, and a platform without one must
  // still boot the rest of this tier (stages and the sweep then wait in the
  // database; maintenance does not run).
  await startSubsystem(async () => {
    const temporal = await import('../temporal/worker-tier-host.ts');
    temporal.startTemporalHost();
    _stopTemporalHost = temporal.stopTemporalHost;
  }, 'Temporal host failed to start');

  // Publish stageRegistry.statuses() to the `worker_status` row every 2 s
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

  // The Workers page's pending / ready / dead / migration-remaining counts are
  // computed here, in the worker, and persisted — never on the API's request
  // path (#3491). See `status-counts.ts` for the demand-aware cadence.
  _countsRefresher = startStatusCountsRefresher();

  // Last, so the first per-minute memory line already reflects a booted tier.
  startMemoryTelemetry({
    process: 'worker',
    extra: workerLoadSnapshot,
    onSample: persistWorkerMemory,
  });
}

// ---------------------------------------------------------------------------
// stopWorkers
// ---------------------------------------------------------------------------

export async function stopWorkers(): Promise<void> {
  stopMemoryTelemetry();
  stopWorkerEnrichmentConfigRefresh();
  stopFfiPoolConfigRefresh();

  // Clear the status-publishing interval before tearing down subsystems so
  // we don't fire a best-effort write after the DB connection closes.
  if (_statusInterval !== null) {
    clearInterval(_statusInterval);
    _statusInterval = null;
  }
  _countsRefresher?.stop();
  _countsRefresher = null;

  stopMaintenanceSupport();

  // The sweep itself stops with the Temporal host below.
  unregisterDiscoverWorker();

  // Stages stop before the Temporal host below. A stage's stop() aborts its
  // handlers and settles its running slice within its 30 s drain bound, so the
  // Temporal worker's own drain, which waits for every running activity, never
  // waits on a stage handler that ignores its abort signal. The other order
  // would leave that drain unbounded.
  try {
    await stopAllStages();
  } catch (e) {
    log.warn({ err: e }, 'error stopping worker stages');
  }

  // Reap the FFI decode child processes — the same pool now also renders
  // and validates non-RAW (JPEG/PNG/WEBP/TIFF/AVIF/HEIC/PSD/HDR) bitmap
  // thumbnails via Maple, so a single shutdown call covers both.
  try {
    ffiPool().shutdown();
  } catch (e) {
    log.warn({ err: e }, 'error shutting down FFI decode pool');
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
        await _stopTemporalHost?.();
        _stopTemporalHost = null;
      } catch (e) {
        log.warn({ err: e }, 'error stopping the Temporal host');
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
