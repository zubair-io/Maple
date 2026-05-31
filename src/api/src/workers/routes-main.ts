/**
 * Worker management API routes — main handlers.
 *
 * Mounted on the main Elysia app in src/api/src/index.ts under /api/workers.
 * Reads live state from the in-process `stageRegistry` (see `./registry.ts`);
 * there is no external process to talk to.
 *
 * Config change flow for PATCH /:name/config:
 *    1. Validate the patch body.
 *    2. Write to worker_config in Mongo (persistence).
 *    3. Call stageRegistry.notifyConfigChanged(name); the running poll loop
 *       re-reads its config from Mongo and applies the new values live.
 *    4. Return { ok: true, config: WorkerConfig } (reads back saved config).
 */

import { Elysia, t } from 'elysia';
import { type Filter, type ObjectId } from 'mongodb';
import { getDb } from '../db/client.ts';
import { ffiPool } from '../ffi/ffi-pool.ts';
import {
  MAX_FFI_WORKERS,
  MIN_FFI_WORKERS,
  clampFfiWorkers,
  loadPerformanceConfig,
  resolveFfiPoolConfig,
  savePerformanceConfig,
} from '../ffi/ffi-pool-config.repo.ts';
import { WorkerConfigRepo } from './worker-config.repo.ts';
import type { WorkerConfig, ImageDoc } from './run-stage.ts';
import { buildClaimQuery, deriveBatchSize, computeWorkersStatus } from './run-stage.ts';
import type { WorkerConfigDoc } from './worker-config.repo.ts';
import { stageRegistry } from './registry.ts';
import { MISSING_REAPER_NAME } from './missing-reaper.ts';
import { loadPruneWindowHours, savePruneWindowHours } from './missing-reaper-config.repo.ts';
import { assetAbsPath } from '../indexer/images.repo.ts';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';
import { ALL_STAGE_NAMES } from './stages/manifest.ts';
import { child } from '../log.ts';
import {
  CLAIM_STAGE_NAMES,
  DEAD_LIST_LIMIT_DEFAULT,
  DEAD_LIST_LIMIT_MAX,
  sanitizeWorkerConfig,
  invalidateStatusCache,
  getStatusDbStateCached,
  assembleWorkersStatus,
} from './routes-status.ts';
import type { StageStatusSnapshot } from './registry.ts';

const log = child('workers:routes');

/** Stages that stamp the `damaged` tag (those with `tagsDamagedOnDeadLetter`).
 * `POST /damaged/clear` resets their dead/attempt bookkeeping when un-tagging
 * so a cleared file is genuinely re-tried. Kept in sync with the stage configs
 * in `stages/{exif,thumb,preview}.ts`. */
export const DAMAGE_TAGGING_STAGES = ['exif', 'thumb', 'preview'] as const;

// ── Routes: Main entry that combines all route definitions ──────────────────

export function workerRoutes(): Elysia {
  return (
    new Elysia({ prefix: '/api/workers' })

    // ── Status ─────────────────────────────────────────────────────────────

    .get('/status', async () => {
      const statuses = stageRegistry.statuses();
      return computeWorkersStatus(statuses);
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

    // ── Dead logs ───────────────────────────────────────────────────────────

    .get('/:name/dead', async ({ params, query, set }) => {
      if (!stageRegistry.has(params.name)) {
        set.status = 404;
        return { error: `unknown stage: ${params.name}` };
      }
      const requested = Number(query.limit ?? DEAD_LIST_LIMIT_DEFAULT);
      const limit = Number.isFinite(requested)
        ? Math.max(1, Math.min(DEAD_LIST_LIMIT_MAX, Math.floor(requested)))
        : DEAD_LIST_LIMIT_DEFAULT;
      try {
        const db = await getDb();
        const assets = db.collection<ImageDoc>('assets');
        const stageKey = `stages.${params.name}`;
        const docs = await assets
          .find(
            { [`${stageKey}.dead`]: true },
            {
              projection: {
                _id: 1,
                abs_path: 1,
                fileinfo: 1,
                folder_id: 1,
                [`${stageKey}.last_error`]: 1,
                [`${stageKey}.attempts`]: 1,
                [`${stageKey}.processed_at`]: 1,
              },
            },
          )
          .sort({ [`${stageKey}.processed_at`]: -1 })
          .limit(limit)
          .toArray();
        const libs = await loadLibraryRoots();
        const items = docs.map((doc) => {
          const stage = doc.stages?.[params.name];
          return {
            id: String(doc._id),
            abs_path: assetAbsPath(doc, libs),
            last_error: stage?.last_error ?? null,
            attempts: stage?.attempts ?? 0,
            processed_at: stage?.processed_at ? new Date(stage.processed_at).toISOString() : null,
          };
        });
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
      const requested = Number(query.limit ?? DEAD_LIST_LIMIT_DEFAULT);
      const limit = Number.isFinite(requested)
        ? Math.max(1, Math.min(DEAD_LIST_LIMIT_MAX, Math.floor(requested)))
        : DEAD_LIST_LIMIT_DEFAULT;
      try {
        const db = await getDb();
        const assets = db.collection<ImageDoc>('assets');
        const docs = await assets
          .find(
            { 'damaged.since': { $type: 'string' } },
            {
              projection: { _id: 1, maple_id: 1, fileinfo: 1, damaged: 1 },
            },
          )
          .sort({ 'damaged.since': -1 })
          .limit(limit)
          .toArray();
        const libs = await loadLibraryRoots();
        const items = docs.map((doc) => {
          const Damaged = doc as {
            damaged?: { since: string; stage: string; reason: string };
          };
          const damaged = Damaged.damaged;
          return {
            id: String(doc._id),
            maple_id: (doc as { maple_id?: string }).maple_id ?? null,
            abs_path: assetAbsPath(doc, libs),
            stage: damaged?.stage ?? null,
            reason: damaged?.reason ?? null,
            since: damaged?.since ?? null,
          };
        });
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
        try {
          const db = await getDb();
          const images = db.collection<ImageDoc>('assets');
          const id = (body as { id?: string } | null)?.id;
          let filter: Filter<ImageDoc>;
          if (id) {
            let oid: ObjectId;
            try {
              oid = new ObjectId(id);
            } catch {
              set.status = 400;
              return { error: `invalid asset id: ${id}` };
            }
            filter = { _id: oid, 'damaged.since': { $type: 'string' } };
          } else {
            filter = { 'damaged.since': { $type: 'string' } };
          }
          // Reset the dead/attempt bookkeeping on the file-reading stages so a
          // cleared file is genuinely re-tried, then drop the tag.
          const stageResets: Record<string, unknown> = { damaged: null };
          for (const stageName of DAMAGE_TAGGING_STAGES) {
            stageResets[`stages.${stageName}.dead`] = false;
            stageResets[`stages.${stageName}.attempts`] = 0;
            stageResets[`stages.${stageName}.last_error`] = null;
          }
          const result = await images.updateMany(filter, {
            $set: stageResets,
          });
          invalidateStatusCache();
          return { ok: true, cleared: result.modifiedCount };
        } catch (err) {
          set.status = 500;
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
      { body: t.Optional(t.Object({ id: t.Optional(t.String()) })) },
    )

    // ── Stage control ───────────────────────────────────────────────────────

    .post('/:name/pause', async ({ params, set }) => {
      if (!stageRegistry.has(params.name)) {
        set.status = 404;
        return { error: `unknown stage: ${params.name}` };
      }
      const result = await stageRegistry.pause(params.name);
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      return { ok: true };
    })

    .post('/:name/resume', async ({ params, set }) => {
      if (!stageRegistry.has(params.name)) {
        set.status = 404;
        return { error: `unknown stage: ${params.name}` };
      }
      const result = await stageRegistry.resume(params.name);
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      return { ok: true };
    })

    .post('/:name/retry-dead', async ({ params, set }) => {
      if (!stageRegistry.has(params.name)) {
        set.status = 404;
        return { error: `unknown stage: ${params.name}` };
      }
      try {
        const db = await getDb();
        const images = db.collection<ImageDoc>('assets');
        const result = await images.updateMany(
          { [`stages.${params.name}.dead`]: true },
          {
            $set: {
              [`stages.${params.name}.dead`]: false,
              [`stages.${params.name}.attempts`]: 0,
              [`stages.${params.name}.last_error`]: null,
            },
          },
        );
        invalidateStatusCache();
        return { ok: true, reset: result.modifiedCount };
      } catch (err) {
        set.status = 500;
        return { error: err instanceof Error ? err.message : String(err) };
      }
    })

    // ── Config management ───────────────────────────────────────────────────

    .patch(
      '/:name/config',
      async ({ params, body, set }) => {
        if (!stageRegistry.has(params.name)) {
          set.status = 404;
          return { error: `unknown stage: ${params.name}` };
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
          const db = await getDb();
          const coll = db.collection('worker_config');
          const repo = new WorkerConfigRepo(coll as never);
          await repo.patch(params.name, body as Partial<WorkerConfig>);
          // Tell the running poll loop to re-read its config from Mongo.
          await stageRegistry.notifyConfigChanged(params.name);
          const savedConfig = await repo.load(params.name);
          invalidateStatusCache();
          return { ok: true, config: savedConfig };
        } catch (err) {
          set.status = 500;
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
      {
        // Loosely-typed body (`additionalProperties: true`, the default) so the
        // removed knobs survive normalization and the handler can 400 on them.
        // The accepted fields are still bounds-validated here; concurrency's
        // ceiling rose 32 → 100 (#674).
        body: t.Object({
          concurrency: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
          maxAttempts: t.Optional(t.Integer({ minimum: 1, maximum: 20 })),
          paused: t.Optional(t.Boolean()),
          pollIntervalMs: t.Optional(t.Unknown()),
          batchSize: t.Optional(t.Unknown()),
        }),
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
