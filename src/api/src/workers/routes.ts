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

export function workerRoutes(supervisor: Supervisor): Elysia {
  return new Elysia({ prefix: "/api/workers" })

    .get("/status", async () => {
      const statuses = supervisor.statuses();
      const stageNames = Object.keys(statuses);

      // DB collections — fetched once for all stages.
      let assets: import("mongodb").Collection<import("mongodb").Document> | null = null;
      let configColl: ReturnType<Awaited<ReturnType<typeof getDb>>["collection"]> | null = null;
      let facetCounts: Record<string, Array<{ n: number }>> = {};
      let configMap = new Map<string, WorkerConfig>();

      try {
        const db = await getDb();
        assets = db.collection("assets") as import("mongodb").Collection<import("mongodb").Document>;
        configColl = db.collection<WorkerConfigDoc>("worker_config");

        // Load all worker configs in one query.
        const allConfigs = await (configColl as import("mongodb").Collection<WorkerConfigDoc>).find({}).toArray();
        for (const cfg of allConfigs) {
          configMap.set(cfg.name, cfg);
        }

        // Build a single $facet aggregation to count pending + dead for every
        // stage in one round trip instead of 2×N sequential countDocuments calls.
        const facetSpec: Record<string, unknown[]> = {};
        for (const name of stageNames) {
          // Use the stage's live targetVersion from the supervisor state.
          // Falls back to 1 when the IPC hasn't reported yet (stage just started).
          const tv = statuses[name]?.targetVersion ?? 1;
          facetSpec[`${name}_pending`] = [
            {
              $match: {
                $or: [
                  { [`stages.${name}.version`]: { $lt: tv } },
                  { [`stages.${name}.version`]: { $exists: false } },
                ],
                [`stages.${name}.dead`]: { $ne: true },
              },
            },
            { $count: "n" },
          ];
          facetSpec[`${name}_dead`] = [
            { $match: { [`stages.${name}.dead`]: true } },
            { $count: "n" },
          ];
        }

        if (stageNames.length > 0) {
          const [result] = await assets.aggregate([{ $facet: facetSpec }]).toArray();
          facetCounts = result as typeof facetCounts;
        }
      } catch {
        // DB unavailable — all counts remain zeros, configMap empty
      }

      const stages = Object.entries(statuses).map(([name, s]) => {
        const pending = facetCounts[`${name}_pending`]?.[0]?.n ?? 0;
        const dead = facetCounts[`${name}_dead`]?.[0]?.n ?? 0;
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
          concurrency: t.Optional(t.Number({ minimum: 1, maximum: 32 })),
          pollIntervalMs: t.Optional(t.Number({ minimum: 100, maximum: 60000 })),
          batchSize: t.Optional(t.Number({ minimum: 1, maximum: 100 })),
          maxAttempts: t.Optional(t.Number({ minimum: 1, maximum: 20 })),
          paused: t.Optional(t.Boolean()),
        }),
      },
    );
}
