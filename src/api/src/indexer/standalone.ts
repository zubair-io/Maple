/**
 * Standalone indexer process — runs the IndexerService on its own event loop.
 *
 * Spawned by the parent HTTP server (see `control.ts`) as
 *   bun src/api/src/indexer/standalone.ts
 *
 * Listens on 127.0.0.1:${MAPLE_INDEXER_PORT} (default 3100). Localhost-only —
 * the parent is the gatekeeper, so no auth is needed on this surface.
 *
 * Routes (NB: NO `/api/indexer` prefix — the parent proxies under that prefix):
 *   GET  /status          — pipeline snapshot
 *   POST /pause           — pause the pipeline
 *   POST /resume          — resume the pipeline
 *   PUT  /config          — update worker pool sizes live
 *   GET  /dead-letter     — paginated dead-letter list
 *   POST /exif-backfill   — kick off an EXIF backfill run
 *
 * On SIGTERM/SIGINT: stops the IndexerService, closes Mongo, exits 0.
 */

import { Elysia, t } from "elysia";
import { getDb, ensureIndexes, closeDb } from "../db/client.ts";
import { getIndexerService } from "./service.ts";
import { listDeadLetter } from "./indexer.repo.ts";

const PORT = Number(process.env.MAPLE_INDEXER_PORT ?? 3100);

const ConfigBody = t.Object({
  workers: t.Object({
    discover: t.Optional(t.Integer({ minimum: 1, maximum: 64 })),
    hash: t.Optional(t.Integer({ minimum: 1, maximum: 64 })),
    exif: t.Optional(t.Integer({ minimum: 1, maximum: 64 })),
    thumb: t.Optional(t.Integer({ minimum: 1, maximum: 64 })),
    ai: t.Optional(t.Integer({ minimum: 1, maximum: 64 })),
    mongo: t.Optional(t.Integer({ minimum: 1, maximum: 64 })),
  }),
});

const app = new Elysia()
  .onError(({ error, set, request }) => {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(
      `[indexer] ${request.method} ${new URL(request.url).pathname} →`,
      msg,
    );
    const preset = typeof set.status === "number" ? set.status : 0;
    if (preset >= 400 && preset < 600) return { error: msg };
    set.status = 500;
    return { error: "Internal indexer error", detail: msg };
  })

  .get("/status", () => getIndexerService().status())

  .post("/pause", () => {
    const svc = getIndexerService();
    svc.pause();
    return { ok: true, status: svc.status() };
  })

  .post("/resume", () => {
    const svc = getIndexerService();
    svc.resume();
    return { ok: true, status: svc.status() };
  })

  .put(
    "/config",
    async ({ body }) => {
      const svc = getIndexerService();
      await svc.setConfig(body.workers);
      return { ok: true, status: svc.status() };
    },
    { body: ConfigBody },
  )

  .get(
    "/dead-letter",
    async ({ query }) => {
      const limit = Math.min(1000, Math.max(1, Number(query.limit ?? 200)));
      try {
        const docs = await listDeadLetter(limit);
        return { items: docs, total: docs.length };
      } catch (e) {
        return {
          items: [],
          total: 0,
          warning: e instanceof Error ? e.message : String(e),
        };
      }
    },
    { query: t.Object({ limit: t.Optional(t.String()) }) },
  )

  .post(
    "/exif-backfill",
    async ({ query }) => {
      const limit = query.limit !== undefined ? Number(query.limit) : undefined;
      if (limit !== undefined && (!Number.isFinite(limit) || limit < 0)) {
        return { ok: false, error: "limit must be a non-negative integer" };
      }
      const svc = getIndexerService();
      svc
        .runExifBackfill(limit)
        .catch((e) =>
          console.warn(
            "[indexer] manual EXIF backfill error:",
            e instanceof Error ? e.message : e,
          ),
        );
      return { ok: true, status: svc.status() };
    },
    { query: t.Object({ limit: t.Optional(t.String()) }) },
  );

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function start(): Promise<void> {
  console.log(`[indexer] starting on http://127.0.0.1:${PORT}`);

  // Connect to Mongo + start the service in the background. The HTTP server
  // (the supervisor's `waitReady` poll) needs `/status` to return 200 ASAP,
  // even before Mongo is up — the service degrades gracefully if Mongo is
  // offline.
  getDb()
    .then(ensureIndexes)
    .then(() => console.log("[indexer] DB ready"))
    .then(() => getIndexerService().start())
    .then(() => console.log("[indexer] service started"))
    .catch((err) => {
      console.warn(
        "[indexer] MongoDB not available:",
        err instanceof Error ? err.message : err,
      );
      console.warn("[indexer] indexer continues without DB; retry on first job.");
    });

  app.listen({ port: PORT, hostname: "127.0.0.1" });
}

// Graceful shutdown.
async function shutdown(signal: string): Promise<void> {
  console.log(`[indexer] ${signal} received — stopping service`);
  try {
    await getIndexerService().stop();
  } catch (e) {
    console.warn(
      "[indexer] error stopping service:",
      e instanceof Error ? e.message : e,
    );
  }
  try {
    await closeDb();
  } catch {
    /* ignore */
  }
  process.exit(0);
}

process.on("SIGTERM", () => {
  shutdown("SIGTERM").catch((e) => {
    console.error("[indexer] shutdown error:", e);
    process.exit(1);
  });
});
process.on("SIGINT", () => {
  shutdown("SIGINT").catch((e) => {
    console.error("[indexer] shutdown error:", e);
    process.exit(1);
  });
});

start().catch((err) => {
  console.error("[indexer] fatal startup error:", err);
  process.exit(1);
});
