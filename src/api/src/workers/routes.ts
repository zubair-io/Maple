/**
 * Worker management API routes.
 *
 * Mounted on the main Elysia app in src/api/src/index.ts under /api/workers.
 * Reads live state from the in-process `stageRegistry` (see `./registry.ts`);
 * there is no external process to talk to.
 *
 * Config change flow for PATCH /:name/config:
 *   1. Validate the patch body.
 *   2. Write to worker_config in Mongo (persistence).
 *   3. Call stageRegistry.notifyConfigChanged(name); the running poll loop
 *      re-reads its config from Mongo and applies the new values live.
 *   4. Return { ok: true, config: WorkerConfig } (reads back saved config).
 *
 * Routes:
 *   GET  /api/workers/status            — aggregated status + pending/dead counts
 *   GET  /api/workers/:name/dead        — recent dead-lettered docs with reasons
 *   POST /api/workers/:name/pause       — pause a stage's poll loop
 *   POST /api/workers/:name/resume      — resume a paused stage
 *   POST /api/workers/:name/retry-dead  — reset dead docs for a stage
 *   PATCH /api/workers/:name/config     — update WorkerConfig fields + notify
 */

import { Elysia, t } from 'elysia';
import { getDb } from '../db/client.ts';
import { WorkerConfigRepo } from './worker-config.repo.ts';
import type { WorkerConfig, ImageDoc } from './run-stage.ts';
import type { WorkerConfigDoc } from './worker-config.repo.ts';
import { stageRegistry } from './registry.ts';
import { assetAbsPath } from '../indexer/images.repo.ts';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';
import { child } from '../log.ts';

const log = child('workers:routes');

const DEAD_LIST_LIMIT_DEFAULT = 50;
const DEAD_LIST_LIMIT_MAX = 500;

export function workerRoutes(): Elysia {
  return new Elysia({ prefix: '/api/workers' })

    .get('/status', async () => {
      // DB collections — fetched once for all stages.
      let assets: import('mongodb').Collection<import('mongodb').Document> | null = null;
      const configMap = new Map<string, WorkerConfig>();
      const pendingByStage = new Map<string, number>();
      const deadByStage = new Map<string, number>();

      try {
        const db = await getDb();
        assets = db.collection('assets') as import('mongodb').Collection<
          import('mongodb').Document
        >;
        const configColl = db.collection<WorkerConfigDoc>('worker_config');

        const allConfigs = await configColl.find({}).toArray();
        for (const cfg of allConfigs) {
          configMap.set(cfg.name, cfg);
        }
      } catch {
        // DB unavailable — counts remain zeros, configMap empty.
      }

      const statuses = stageRegistry.statuses();
      const stageNames = Object.keys(statuses);

      if (assets && stageNames.length > 0) {
        const counts = await Promise.all(
          stageNames.flatMap((name) => {
            const tv = statuses[name]?.targetVersion ?? 1;
            const pending = assets!
              .countDocuments({
                $or: [
                  { [`stages.${name}.version`]: { $lt: tv } },
                  { [`stages.${name}.version`]: { $exists: false } },
                ],
                [`stages.${name}.dead`]: { $ne: true },
              })
              .then((n) => ({ key: 'pending' as const, name, n }))
              .catch((err) => {
                log.warn({ stage: name, err }, 'countDocuments failed for pending — returning 0');
                return { key: 'pending' as const, name, n: 0 };
              });
            const dead = assets!
              .countDocuments({ [`stages.${name}.dead`]: true })
              .then((n) => ({ key: 'dead' as const, name, n }))
              .catch((err) => {
                log.warn({ stage: name, err }, 'countDocuments failed for dead — returning 0');
                return { key: 'dead' as const, name, n: 0 };
              });
            return [pending, dead];
          }),
        );
        for (const c of counts) {
          if (c.key === 'pending') pendingByStage.set(c.name, c.n);
          else deadByStage.set(c.name, c.n);
        }
      }

      const stages = Object.entries(statuses).map(([name, s]) => {
        const pending = pendingByStage.get(name) ?? 0;
        const dead = deadByStage.get(name) ?? 0;
        const config = configMap.get(name) ?? null;
        const configured = config?.concurrency ?? 0;
        const batchSize = config?.batchSize ?? 0;
        return {
          name,
          status: s.status,
          inFlight: s.inFlight,
          configured,
          pending,
          dead,
          throughput: s.throughput,
          lastError: s.lastError,
          config,
          batchSize,
        };
      });

      return { stages };
    })

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
            abs_path: assetAbsPath(doc, libs) ?? doc.abs_path ?? null,
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
        return { ok: true, reset: result.modifiedCount };
      } catch (err) {
        set.status = 500;
        return { error: err instanceof Error ? err.message : String(err) };
      }
    })

    .patch(
      '/:name/config',
      async ({ params, body, set }) => {
        if (!stageRegistry.has(params.name)) {
          set.status = 404;
          return { error: `unknown stage: ${params.name}` };
        }
        try {
          const db = await getDb();
          const coll = db.collection('worker_config');
          const repo = new WorkerConfigRepo(coll as never);
          await repo.patch(params.name, body as Partial<WorkerConfig>);
          // Tell the running poll loop to re-read its config from Mongo.
          await stageRegistry.notifyConfigChanged(params.name);
          const savedConfig = await repo.load(params.name);
          return { ok: true, config: savedConfig };
        } catch (err) {
          set.status = 500;
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
      {
        body: t.Object({
          concurrency: t.Optional(t.Integer({ minimum: 1, maximum: 32 })),
          pollIntervalMs: t.Optional(t.Integer({ minimum: 100, maximum: 60000 })),
          batchSize: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
          maxAttempts: t.Optional(t.Integer({ minimum: 1, maximum: 20 })),
          paused: t.Optional(t.Boolean()),
        }),
      },
    );
}
