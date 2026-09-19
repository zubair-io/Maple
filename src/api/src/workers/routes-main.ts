import { rejectLegacyAiWrite } from '../routes/ai-legacy-write.ts';
/**
 * Worker management API routes — main handlers.
 *
 * Mounted on the main Elysia app in src/api/src/index.ts under /api/workers.
 * Workers run in a separate child process (worker-main.ts); the API process's
 * in-process `stageRegistry` is EMPTY.  Route handlers that need to validate
 * worker names use the static `KNOWN_WORKER_NAMES` set instead.
 *
 * Pause/resume cross-process contract:
 *   - POST /:name/pause|resume write the worker's `paused` flag via
 *     WorkerConfigRepo.patch().  The worker process re-reads `worker_config` on
 *     every poll tick, so the change takes effect without any IPC.
 *
 * Config change flow for PATCH /:name/config:
 *    1. Validate the patch body.
 *    2. Write the row (persistence).
 *    3. The worker re-reads its config on the next tick — no IPC.
 *    4. Return { ok: true, config: WorkerConfig } (reads back saved config).
 *
 * The dead-letter and damaged surfaces below hold no SQL of their own: every
 * one of them is a call into `db/sqlite/repos/worker-admin.repo.ts`, which is
 * also where the damaged-clear's ordering (reset the stages, then drop the tag,
 * in one transaction) lives.
 */

import { Elysia, t } from 'elysia';
import { WorkerConfigBody } from './worker-config.schema.ts';
import { parseAssetId } from '../db/sqlite/repos/assets.repo.ts';
import {
  clearDamagedAssets,
  listDamagedAssets,
  listDeadAssets,
  retryDeadStage,
} from '../db/sqlite/repos/worker-admin.repo.ts';
import { ffiPool } from '../ffi/ffi-pool.ts';
import {
  MAX_FFI_WORKERS,
  MIN_FFI_WORKERS,
  clampFfiWorkers,
  loadPerformanceConfig,
  resolveFfiPoolConfig,
  savePerformanceConfig,
} from '../ffi/ffi-pool-config.repo.ts';
import { WorkerConfigRepo } from '../db/sqlite/repos/worker-config.repo.ts';
import type { WorkerConfig } from './run-stage.ts';
import { previewOndemandLimiter } from '../indexer/preview-ondemand-limiter.ts';
import { MISSING_REAPER_NAME } from './missing-reaper.ts';
import { MIGRATION_WORKER_NAME } from './migration.ts';
import { DEDUPLICATE_NAME } from './dedupe.ts';
import { DISCOVER_NAME } from './discover/register.ts';
import { ALL_STAGE_NAMES } from './stages/manifest.ts';
import { loadPruneWindowHours, savePruneWindowHours } from './missing-reaper-config.repo.ts';
import {
  loadDeDuplicateConfig,
  saveDeDuplicateConfig,
  type DeDuplicateConfig,
} from './dedupe-config.repo.ts';
import { MIGRATIONS, getMigration } from './migration/index.ts';
import {
  loadAllMigrationStates,
  defaultMigrationState,
  setMigrationEnabled,
  resetMigrationState,
} from './migration-config.repo.ts';
import {
  DEAD_LIST_LIMIT_DEFAULT,
  DEAD_LIST_LIMIT_MAX,
  computeWorkersStatus,
  requestStatusCounts,
} from './routes-status.ts';

/**
 * Every worker name the API accepts for name-gated routes.
 * The worker process runs in a separate child; the in-process `stageRegistry`
 * is empty here, so we validate against this static set instead.
 */
const KNOWN_WORKER_NAMES = new Set<string>([
  ...ALL_STAGE_NAMES,
  MISSING_REAPER_NAME, // 'missing-reaper'
  MIGRATION_WORKER_NAME, // 'migration'
  DEDUPLICATE_NAME, // 'deduplicate'
  DISCOVER_NAME, // 'discover'
]);

/** Stages that stamp the `damaged` tag (those with `tagsDamagedOnDeadLetter`).
 * `POST /damaged/clear` resets their dead/attempt bookkeeping when un-tagging
 * so a cleared file is genuinely re-tried. Kept in sync with the stage configs
 * in `stages/{exif,thumb,preview}.ts`. */
const DAMAGE_TAGGING_STAGES = ['exif', 'thumb', 'preview'] as const;

/** 404 payload for a `:name`-gated route, or `null` when `name` is a known
 * worker/stage. Shared by every route below that validates `params.name`
 * against `KNOWN_WORKER_NAMES` before doing any work. */
function unknownWorkerError(name: string, noun: 'worker' | 'stage'): { error: string } | null {
  return KNOWN_WORKER_NAMES.has(name) ? null : { error: `unknown ${noun}: ${name}` };
}

/** Clamp a `?limit=` query value into `[1, DEAD_LIST_LIMIT_MAX]`, falling
 * back to `DEAD_LIST_LIMIT_DEFAULT` when it's missing or not a finite
 * number. Shared by every dead/damaged-list route. */
function resolveDeadListLimit(rawLimit: unknown): number {
  const requested = Number(rawLimit ?? DEAD_LIST_LIMIT_DEFAULT);
  return Number.isFinite(requested)
    ? Math.max(1, Math.min(DEAD_LIST_LIMIT_MAX, Math.floor(requested)))
    : DEAD_LIST_LIMIT_DEFAULT;
}

async function setWorkerPaused(name: string, paused: boolean): Promise<{ ok: true }> {
  await new WorkerConfigRepo().patch(name, { paused });
  return { ok: true };
}

/** `POST /:name/pause` and `/:name/resume` are identical apart from the
 * `paused` value they write — one handler factory backs both routes. */
function pauseResumeHandler(paused: boolean) {
  return async ({
    params,
    set,
  }: {
    params: { name: string };
    set: { status?: number | string };
  }) => {
    const unknown = unknownWorkerError(params.name, 'worker');
    if (unknown) {
      set.status = 404;
      return unknown;
    }
    try {
      return await setWorkerPaused(params.name, paused);
    } catch (err) {
      set.status = 500;
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };
}

// ── Routes: Main entry that combines all route definitions ──────────────────

export function workerRoutes() {
  return (
    new Elysia({ prefix: '/api/workers' })

      // ── Status ─────────────────────────────────────────────────────────────

      .get('/status', async () => {
        // Cheap by construction: the counts come from the snapshot the worker
        // persists (#3491). Poking demand is what makes the worker refresh
        // that snapshot quickly while someone is looking.
        await requestStatusCounts();
        return computeWorkersStatus();
      })

      // Missing-reaper prune window (hours an original must be missing before the
      // reaper hard-deletes the row). The reaper re-reads this each tick, so a
      // PATCH takes effect on the next pass without a restart.
      .get('/missing-reaper/prune-window', async () => {
        return { hours: await loadPruneWindowHours() };
      })

      .patch(
        '/missing-reaper/prune-window',
        async ({ body, set }) => {
          try {
            const hours = await savePruneWindowHours((body as { hours: number }).hours);
            return { ok: true, hours };
          } catch (err) {
            set.status = 500;
            return { error: err instanceof Error ? err.message : String(err) };
          }
        },
        { body: t.Object({ hours: t.Number({ minimum: 1, maximum: 8760 }) }) },
      )

      // DeDuplicate worker tunables: per-pass batch size + dry-run preview. The
      // worker re-reads these each tick, so a PATCH takes effect on the next
      // pass without a restart. (The worker itself starts paused — resume via
      // POST /api/workers/deduplicate/resume.)
      .get('/deduplicate/config', async () => {
        return await loadDeDuplicateConfig();
      })

      .patch(
        '/deduplicate/config',
        async ({ body, set }) => {
          try {
            const config = await saveDeDuplicateConfig(body as Partial<DeDuplicateConfig>);
            return { ok: true, config };
          } catch (err) {
            set.status = 500;
            return { error: err instanceof Error ? err.message : String(err) };
          }
        },
        {
          body: t.Object({
            batch_size: t.Optional(t.Number({ minimum: 1, maximum: 5000 })),
            dry_run: t.Optional(t.Boolean()),
          }),
        },
      )

      // ── Migrations ────────────────────────────────────────────────────────
      // The `migration` worker owns a registry of named one-shot migrations,
      // each with its own enable toggle surfaced in /settings/workers. Listing
      // merges the static registry (id/title/description) with persisted state
      // (enabled/status/progress) and a live `remaining` count.

      .get('/migration/migrations', async ({ set }) => {
        try {
          await requestStatusCounts();
          // One DB read for all per-migration state, indexed by id below. The
          // `remaining` / `failedPermanently` counts are the worker's persisted
          // values (#3491): most `countRemaining()` filters are full-collection
          // scans, so they are never run on the request path. Null until the
          // worker has counted a migration for the first time.
          const states = await loadAllMigrationStates();
          const migrations = MIGRATIONS.map((m) => {
            const state = states[m.id] ?? defaultMigrationState();
            return {
              id: m.id,
              title: m.title,
              description: m.description,
              enabled: state.enabled,
              status: state.status,
              processed: state.processed,
              errors: state.errors,
              remaining: state.remaining ?? null,
              remaining_at: state.remaining_at ?? null,
              // Only migrations that implement `countFailedPermanently` (a
              // migration-specific dead-letter queue) surface the field at all.
              ...(m.countFailedPermanently
                ? { failedPermanently: state.failed_permanently ?? null }
                : {}),
              last_error: state.last_error,
              started_at: state.started_at,
              finished_at: state.finished_at,
            };
          });
          return { migrations };
        } catch (err) {
          set.status = 500;
          return { error: err instanceof Error ? err.message : String(err) };
        }
      })

      // Toggle a migration on/off (enabling arms a fresh run) or reset its
      // progress back to idle. The worker re-reads state each tick, so the
      // change takes effect on the next pass without a restart.
      .patch(
        '/migration/migrations/:id',
        async ({ params, body, set }) => {
          if (!getMigration(params.id)) {
            set.status = 404;
            return { error: `unknown migration: ${params.id}` };
          }
          const { enabled, reset } = body as { enabled?: boolean; reset?: boolean };
          try {
            if (reset) {
              const state = await resetMigrationState(params.id);
              return { ok: true, state };
            }
            if (typeof enabled === 'boolean') {
              const state = await setMigrationEnabled(params.id, enabled, new Date().toISOString());
              return { ok: true, state };
            }
            set.status = 400;
            return { error: 'expected { enabled: boolean } or { reset: true }' };
          } catch (err) {
            set.status = 500;
            return { error: err instanceof Error ? err.message : String(err) };
          }
        },
        {
          body: t.Object({
            enabled: t.Optional(t.Boolean()),
            reset: t.Optional(t.Boolean()),
          }),
        },
      )

      // ── Dead logs ───────────────────────────────────────────────────────────

      .get('/:name/dead', async ({ params, query, set }) => {
        const unknown = unknownWorkerError(params.name, 'stage');
        if (unknown) {
          set.status = 404;
          return unknown;
        }
        try {
          const items = await listDeadAssets(params.name, resolveDeadListLimit(query.limit));
          return { items };
        } catch (err) {
          set.status = 500;
          return { error: err instanceof Error ? err.message : String(err) };
        }
      })

      // ── Damaged files ───────────────────────────────────────────────────────

      // Damaged files — assets tagged `damaged` (unreadable bytes) by a
      // file-reading stage that exhausted its retries. Collection-level: one
      // list across the whole pipeline, each row keyed by maple_id.
      .get('/damaged', async ({ query, set }) => {
        try {
          const items = await listDamagedAssets(resolveDeadListLimit(query.limit));
          return { items };
        } catch (err) {
          set.status = 500;
          return { error: err instanceof Error ? err.message : String(err) };
        }
      })

      // Clear the `damaged` tag so the pipeline re-processes the file. `id`
      // (asset _id hex) clears one; omit it to clear all. Also resets the
      // tagging stages' dead/attempt bookkeeping so the file is actually
      // re-tried, not just un-parked.
      .post(
        '/damaged/clear',
        async ({ body, set }) => {
          const id = (body as { id?: string } | null)?.id;
          if (id !== undefined && parseAssetId(id) === null) {
            set.status = 400;
            return { error: `invalid asset id: ${id}` };
          }
          try {
            // One transaction: the file-reading stages' dead/attempt
            // bookkeeping is reset so a cleared file is genuinely re-tried, and
            // only then is the tag dropped.
            const cleared = await clearDamagedAssets(id ?? null, DAMAGE_TAGGING_STAGES);
            return { ok: true, cleared };
          } catch (err) {
            set.status = 500;
            return { error: err instanceof Error ? err.message : String(err) };
          }
        },
        { body: t.Optional(t.Object({ id: t.Optional(t.String()) })) },
      )

      // ── Stage control ───────────────────────────────────────────────────────

      .post('/:name/pause', pauseResumeHandler(true))

      .post('/:name/resume', pauseResumeHandler(false))

      .post('/:name/retry-dead', async ({ params, set }) => {
        const unknown = unknownWorkerError(params.name, 'stage');
        if (unknown) {
          set.status = 404;
          return unknown;
        }
        try {
          return { ok: true, reset: await retryDeadStage(params.name) };
        } catch (err) {
          set.status = 500;
          return { error: err instanceof Error ? err.message : String(err) };
        }
      })

      // ── Config management ───────────────────────────────────────────────────

      .patch(
        '/:name/config',
        async ({ params, body, set }) => {
          const unknown = unknownWorkerError(params.name, 'stage');
          if (unknown) {
            set.status = 404;
            return unknown;
          }
          // `pollIntervalMs` / `batchSize` were removed as knobs (#674) — the
          // poll cadence is a global constant and batch size is derived as
          // 5×concurrency. Elysia strips unknown keys before the typed `body`
          // reaches us, so reject them explicitly from the raw payload rather
          // than silently ignoring a caller that still sends them.
          const raw = body as Record<string, unknown>;
          const removed = ['pollIntervalMs', 'batchSize'].filter((k) => k in raw);
          if (removed.length > 0) {
            set.status = 400;
            return {
              error: `removed config keys not accepted: ${removed.join(', ')}`,
            };
          }
          try {
            const repo = new WorkerConfigRepo();
            await repo.patch(params.name, body as Partial<WorkerConfig>);
            // The worker process re-reads worker_config on its next poll tick
            // — no IPC needed.
            const savedConfig = await repo.load(params.name);
            // The `preview` stage's concurrency also caps ON-DEMAND (request-
            // path) preview regeneration in THIS process — see
            // preview-ondemand-limiter.ts's module doc for why it reuses this
            // setting instead of adding a new one. Apply live; this route runs
            // in the API process, same as the on-demand routes (no IPC needed).
            if (params.name === 'preview' && savedConfig) {
              previewOndemandLimiter().setLimit(savedConfig.concurrency);
            }
            return { ok: true, config: savedConfig };
          } catch (err) {
            set.status = 500;
            return { error: err instanceof Error ? err.message : String(err) };
          }
        },
        {
          beforeHandle: rejectLegacyAiWrite,
          body: WorkerConfigBody,
        },
      )

      // ── Performance: FFI decode-pool size (ticket #673) ─────────────────────
      // GET   /api/workers/performance — effective ffi_workers + source + live
      //                                 pool stats.
      // PATCH /api/workers/performance — clamp 1–16, persist to the
      //                                 `performance` app_settings doc, then
      //                                 resize the live pool immediately (no
      //                                 restart).
      .get('/performance', async () => {
        const resolved = resolveFfiPoolConfig(await loadPerformanceConfig());
        return {
          ffi_workers: resolved.ffi_workers,
          source: resolved.source.ffi_workers,
          min: MIN_FFI_WORKERS,
          max: MAX_FFI_WORKERS,
          pool: ffiPool().stats(),
        };
      })

      .patch(
        '/performance',
        async ({ body, set }) => {
          const clamped = clampFfiWorkers(body.ffi_workers);
          if (clamped === null) {
            set.status = 400;
            return {
              error: `Invalid ffi_workers: must be a finite number (got ${body.ffi_workers})`,
            };
          }
          try {
            await savePerformanceConfig({ ffi_workers: clamped });
          } catch (err) {
            set.status = 500;
            return { error: err instanceof Error ? err.message : String(err) };
          }
          // Re-resolve (in case the DB was unreachable and env/default applies)
          // and resize the live pool right away.
          const resolved = resolveFfiPoolConfig(await loadPerformanceConfig());
          ffiPool().setPoolSize(resolved.ffi_workers);
          return {
            ok: true,
            ffi_workers: resolved.ffi_workers,
            source: resolved.source.ffi_workers,
            pool: ffiPool().stats(),
          };
        },
        {
          body: t.Object({
            ffi_workers: t.Number(),
          }),
        },
      )
  );
}
