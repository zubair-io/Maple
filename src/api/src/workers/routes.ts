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
 *   4. Return { ok: true }.
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

export function workerRoutes(supervisor: Supervisor): Elysia {
  return new Elysia({ prefix: "/api/workers" })

    .get("/status", async () => {
      const statuses = supervisor.statuses();
      // Get DB + collections once outside the per-stage loop (Issues 2 + 3).
      let images: ReturnType<Awaited<ReturnType<typeof getDb>>["collection"]> | null = null;
      let configColl: ReturnType<Awaited<ReturnType<typeof getDb>>["collection"]> | null = null;
      try {
        const db = await getDb();
        images = db.collection<ImageDoc>("assets");
        configColl = db.collection<WorkerConfigDoc>("worker_config");
      } catch {
        // DB unavailable — all counts will be zeros
      }

      const stages = await Promise.all(
        Object.entries(statuses).map(async ([name, s]) => {
          let pending = 0;
          let dead = 0;
          try {
            if (images && configColl) {
              // Determine the stage's target version from the persisted config so
              // the pending count uses the real threshold (not a hardcoded sentinel).
              // Fall back to 0 if no config doc exists yet, which means all docs
              // (version missing or 0) are pending.
              const repo = new WorkerConfigRepo(configColl as never);
              const workerCfg = await repo.load(name);
              const targetVersion = workerCfg?.last_seen_target_version ?? 0;

              pending = await (images as import("mongodb").Collection<ImageDoc>).countDocuments({
                [`stages.${name}.dead`]: { $ne: true },
                $or: [
                  { [`stages.${name}.version`]: { $lt: targetVersion } },
                  { [`stages.${name}.version`]: { $exists: false } },
                ],
              });
              dead = await (images as import("mongodb").Collection<ImageDoc>).countDocuments({
                [`stages.${name}.dead`]: true,
              });
            }
          } catch {
            // DB unavailable — return zeros
          }
          return {
            name,
            status: s.status,
            pid: s.pid,
            lastError: s.lastError,
            restartCount: s.restartCount,
            inFlight: s.inFlight,
            throughput: s.throughput,
            pending,
            dead,
          };
        }),
      );
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
        return { ok: true, resetCount: result.modifiedCount };
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
          return { ok: true };
        } catch (err) {
          set.status = 500;
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
      {
        body: t.Partial(
          t.Object({
            concurrency: t.Number(),
            pollIntervalMs: t.Number(),
            batchSize: t.Number(),
            maxAttempts: t.Number(),
            paused: t.Boolean(),
          }),
        ),
      },
    );
}
