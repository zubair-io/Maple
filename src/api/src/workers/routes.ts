/**
 * Worker management API routes.
 *
 * Mounted on the main Elysia app in src/api/src/index.ts under /api/workers.
 * All routes are server-side only in Plan 1 — the Angular UI is Plan 4.
 *
 * Config change flow for PATCH /:name/config:
 *   1. Validate the patch body.
 *   2. Write to worker_config in Mongo (persistence).
 *   3. Call supervisor.notifyConfigChanged(name), which POSTs reload-config
 *      to the child's IPC port. The child re-reads from Mongo and applies live.
 *   4. Return { ok: true, config: WorkerConfig } (reads back saved config).
 *
 * Routes:
 *   GET  /api/workers/status            — aggregated status + pending/dead counts
 *   GET  /api/workers/:name/dead        — recent dead-lettered docs with reasons
 *   POST /api/workers/:name/pause       — pause a stage's poll loop
 *   POST /api/workers/:name/resume      — resume a paused stage
 *   POST /api/workers/:name/retry-dead  — reset dead docs for a stage
 *   PATCH /api/workers/:name/config     — update WorkerConfig fields + notify child
 */

import { Elysia, t } from "elysia";
import type { Supervisor } from "./supervisor.ts";
import { getDb } from "../db/client.ts";
import { WorkerConfigRepo } from "./worker-config.repo.ts";
import type { WorkerConfig } from "./runtime/define-stage.ts";
import type { ImageDoc } from "./runtime/define-stage.ts";
import type { WorkerConfigDoc } from "./worker-config.repo.ts";
import { ALL_STAGE_NAMES } from "./stages/manifest.ts";
import { child } from "../log.ts";

const log = child("workers:routes");

const DEAD_LIST_LIMIT_DEFAULT = 50;
const DEAD_LIST_LIMIT_MAX = 500;

export function workerRoutes(supervisor: Supervisor): Elysia {
  return new Elysia({ prefix: "/api/workers" })

    .get("/status", async () => {
      // Run the supervisor IPC refresh concurrently with the DB work — both
      // are I/O-bound and independent. refreshLiveStatus is bounded by the
      // child-side 300 ms AbortSignal.timeout, so total wall time = max(
      // IPC fan-out, DB fan-out) instead of their sum.
      const refreshPromise = supervisor.refreshLiveStatus();

      // DB collections — fetched once for all stages.
      let assets:
        | import("mongodb").Collection<import("mongodb").Document>
        | null = null;
      let configMap = new Map<string, WorkerConfig>();
      let pendingByStage = new Map<string, number>();
      let deadByStage = new Map<string, number>();

      try {
        const db = await getDb();
        assets = db.collection("assets") as import("mongodb").Collection<
          import("mongodb").Document
        >;
        const configColl = db.collection<WorkerConfigDoc>("worker_config");

        // Load all worker configs in one query.
        const allConfigs = await configColl.find({}).toArray();
        for (const cfg of allConfigs) {
          configMap.set(cfg.name, cfg);
        }
      } catch {
        // DB unavailable — counts remain zeros, configMap empty.
      }

      // We need the supervisor statuses before we know per-stage targetVersions,
      // but refreshLiveStatus mutates the in-memory state, so await it first.
      await refreshPromise;
      const statuses = supervisor.statuses();
      const stageNames = Object.keys(statuses);

      if (assets && stageNames.length > 0) {
        // Fan out 2 indexed countDocuments per stage in parallel.
        // The pending query uses { stages.<name>.version: 1 } via the $lt branch
        // and via the $exists:false branch (Mongo indexes missing-field docs
        // as null entries on a non-sparse index). The dead query hits the new
        // partial index { stages.<name>.dead: 1 } filtered to dead:true.
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
              .then((n) => ({ key: "pending" as const, name, n }))
              .catch((err) => {
                log.warn(
                  { stage: name, err: err instanceof Error ? err.message : err },
                  "countDocuments failed for pending — returning 0",
                );
                return { key: "pending" as const, name, n: 0 };
              });
            const dead = assets!
              .countDocuments({ [`stages.${name}.dead`]: true })
              .then((n) => ({ key: "dead" as const, name, n }))
              .catch((err) => {
                log.warn(
                  { stage: name, err: err instanceof Error ? err.message : err },
                  "countDocuments failed for dead — returning 0",
                );
                return { key: "dead" as const, name, n: 0 };
              });
            return [pending, dead];
          }),
        );
        for (const c of counts) {
          if (c.key === "pending") pendingByStage.set(c.name, c.n);
          else deadByStage.set(c.name, c.n);
        }
      }

      const stages = Object.entries(statuses).map(([name, s]) => {
        const pending = pendingByStage.get(name) ?? 0;
        const dead = deadByStage.get(name) ?? 0;
        const config = configMap.get(name) ?? null;
        const configured = config?.concurrency ?? 0;
        const batchSize = config?.batchSize ?? 0;
        // Surface config-level pause as a distinct status. The supervisor
        // status tracks the process; a stage whose child is alive but whose
        // poll loop is paused (config.paused = true) should read as
        // "paused" in the UI, not "running".
        const status =
          s.status === "running" && config?.paused === true
            ? "paused"
            : s.status;
        return {
          name,
          status,
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

    .get("/:name/dead", async ({ params, query, set }) => {
      const statuses = supervisor.statuses();
      if (!(params.name in statuses)) {
        set.status = 404;
        return { error: `unknown stage: ${params.name}` };
      }
      const requested = Number(query.limit ?? DEAD_LIST_LIMIT_DEFAULT);
      const limit = Number.isFinite(requested)
        ? Math.max(1, Math.min(DEAD_LIST_LIMIT_MAX, Math.floor(requested)))
        : DEAD_LIST_LIMIT_DEFAULT;
      try {
        const db = await getDb();
        const assets = db.collection<ImageDoc>("assets");
        const stageKey = `stages.${params.name}`;
        const docs = await assets
          .find(
            { [`${stageKey}.dead`]: true },
            {
              projection: {
                _id: 1,
                abs_path: 1,
                [`${stageKey}.last_error`]: 1,
                [`${stageKey}.attempts`]: 1,
                [`${stageKey}.processed_at`]: 1,
              },
            },
          )
          .sort({ [`${stageKey}.processed_at`]: -1 })
          .limit(limit)
          .toArray();
        const items = docs.map((doc) => {
          const stage = doc.stages?.[params.name];
          return {
            id: String(doc._id),
            abs_path: doc.abs_path ?? null,
            last_error: stage?.last_error ?? null,
            attempts: stage?.attempts ?? 0,
            processed_at: stage?.processed_at
              ? new Date(stage.processed_at).toISOString()
              : null,
          };
        });
        return { items };
      } catch (err) {
        set.status = 500;
        return { error: err instanceof Error ? err.message : String(err) };
      }
    })

    .post("/:name/pause", async ({ params, set }) => {
      const statuses = supervisor.statuses();
      if (!(params.name in statuses)) {
        set.status = 404;
        return { error: `unknown stage: ${params.name}` };
      }
      const result = await supervisor.pause(params.name);
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      return { ok: true };
    })

    .post("/:name/resume", async ({ params, set }) => {
      const statuses = supervisor.statuses();
      if (!(params.name in statuses)) {
        set.status = 404;
        return { error: `unknown stage: ${params.name}` };
      }
      const result = await supervisor.resume(params.name);
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      return { ok: true };
    })

    .post("/:name/retry-dead", async ({ params, set }) => {
      const statuses = supervisor.statuses();
      if (!(params.name in statuses)) {
        set.status = 404;
        return { error: `unknown stage: ${params.name}` };
      }
      try {
        const db = await getDb();
        const images = db.collection<ImageDoc>("assets");
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
      "/:name/config",
      async ({ params, body, set }) => {
        const statuses = supervisor.statuses();
        if (!(params.name in statuses)) {
          set.status = 404;
          return { error: `unknown stage: ${params.name}` };
        }
        try {
          const db = await getDb();
          const coll = db.collection("worker_config");
          const repo = new WorkerConfigRepo(coll as never);
          await repo.patch(params.name, body as Partial<WorkerConfig>);
          // Push the change to the running child via IPC.
          // Returns ok:false with an error if the child is not running — that
          // is non-fatal: the config is persisted and will be loaded on next boot.
          await supervisor.notifyConfigChanged(params.name);
          // Read back the saved config so the UI can update its in-memory state
          // without an extra poll round-trip.
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
