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
 *   GET  /dead-letter            — paginated dead-letter list (stage / errorPrefix filters)
 *   GET  /dead-letter/groups     — $group rollup by stage + error class
 *   POST /dead-letter/reset      — delete matching rows so the watcher re-attempts
 *   POST /exif-backfill          — kick off an EXIF backfill run
 *
 * On SIGTERM/SIGINT: stops the IndexerService, closes Mongo, exits 0.
 */

import { Elysia, t } from "elysia";
import { ObjectId } from "mongodb";
import { getDb, ensureIndexes, closeDb, foldersCollection } from "../db/client.ts";
import { getIndexerService } from "./service.ts";
import {
  filterDeadLetter,
  groupDeadLetterByError,
  listDeadLetter,
  resetDeadLetter,
} from "./indexer.repo.ts";
import type { Stage } from "./channel.ts";
import { child as childLogger } from "../log.ts";

const log = childLogger("indexer:standalone");

const STAGE_VALUES = ["discover", "hash", "exif", "thumb", "ai", "mongo"] as const;
function isStage(v: unknown): v is Stage {
  return typeof v === "string" && (STAGE_VALUES as readonly string[]).includes(v);
}

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
    log.error(
      {
        method: request.method,
        path: new URL(request.url).pathname,
        err: msg,
      },
      "request error",
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
      const stage = isStage(query.stage) ? query.stage : undefined;
      const errorPrefix =
        typeof query.errorPrefix === "string" && query.errorPrefix.length > 0
          ? query.errorPrefix
          : undefined;
      try {
        const docs =
          stage || errorPrefix
            ? await filterDeadLetter({ stage, errorPrefix, limit })
            : await listDeadLetter(limit);
        return { items: docs, total: docs.length };
      } catch (e) {
        return {
          items: [],
          total: 0,
          warning: e instanceof Error ? e.message : String(e),
        };
      }
    },
    {
      query: t.Object({
        limit: t.Optional(t.String()),
        stage: t.Optional(t.String()),
        errorPrefix: t.Optional(t.String()),
      }),
    },
  )

  .get("/dead-letter/groups", async () => {
    try {
      const groups = await groupDeadLetterByError();
      return { groups };
    } catch (e) {
      return {
        groups: [],
        warning: e instanceof Error ? e.message : String(e),
      };
    }
  })

  .post(
    "/dead-letter/reset",
    async ({ body, set }) => {
      const stage = isStage(body.stage) ? body.stage : undefined;
      const key =
        typeof body.key === "string" && body.key.length > 0 ? body.key : undefined;
      if (!stage && !key) {
        set.status = 400;
        return { error: "Provide at least one of {key, stage}" };
      }
      try {
        const res = await resetDeadLetter({ key, stage });
        return { ok: true, deletedCount: res.deletedCount };
      } catch (e) {
        set.status = 500;
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
    {
      body: t.Object({
        key: t.Optional(t.String()),
        stage: t.Optional(t.String()),
      }),
    },
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
          log.warn(
            { err: e instanceof Error ? e.message : e },
            "manual EXIF backfill error",
          ),
        );
      return { ok: true, status: svc.status() };
    },
    { query: t.Object({ limit: t.Optional(t.String()) }) },
  )

  // Enqueue a batch of paths for indexing. Used by the parent's browse
  // route (`/api/fs/dir`) to opportunistically index files the user has
  // navigated to. `skipThumb=true` is the typical flag here — the lazy
  // `/api/fs/thumb` route already renders thumbs on demand, so we skip
  // the FFI worker pool and let the rest of the pipeline (hash → exif →
  // ai → mongo) write the asset doc.
  .post(
    "/enqueue",
    async ({ body }) => {
      const svc = getIndexerService();
      const skipThumb = body.skipThumb === true;
      let enqueued = 0;
      for (const absPath of body.paths) {
        try {
          await svc.pipeline.channels.discover.push({
            kind: "index",
            folderId: body.folderId,
            absPath,
            skipThumb,
          });
          enqueued++;
        } catch (e) {
          log.warn(
            { absPath, err: e instanceof Error ? e.message : e },
            "enqueue push failed",
          );
        }
      }
      return { ok: true, enqueued };
    },
    {
      body: t.Object({
        folderId: t.String({ minLength: 24, maxLength: 24 }),
        paths: t.Array(t.String({ minLength: 1 })),
        skipThumb: t.Optional(t.Boolean()),
      }),
    },
  )

  // Re-scan one folder. Resolves the folder by id, walks its tree (or
  // an optional sub-folder under it), and pushes every supported file
  // into the discover channel with `priority: true` — every stage uses
  // pushFront() for these jobs so they hop the existing backlog from
  // the initial walk. The upsert is idempotent (Phase 1 skeleton +
  // $setOnInsert) so unchanged files no-op and new files get enqueued.
  //
  // Body:
  //   subPath?: string — optional absolute path under folder.path. When
  //     set, the walker only enters that subtree (the UI uses this to
  //     mean "scan the folder I'm currently looking at, not the whole
  //     library"). When omitted, the entire library root is walked.
  .post(
    "/rescan/:folderId",
    async ({ params, body, set }) => {
      const folderIdStr = params.folderId;
      if (!ObjectId.isValid(folderIdStr)) {
        set.status = 400;
        return { ok: false, error: "Invalid folderId" };
      }
      const id = new ObjectId(folderIdStr);
      const folders = await foldersCollection();
      const folder = await folders.findOne({ _id: id });
      if (!folder) {
        set.status = 404;
        return { ok: false, error: "Folder not found" };
      }
      const subPath = typeof body?.subPath === "string" && body.subPath.length > 0
        ? body.subPath
        : undefined;
      const walkPath = subPath ?? folder.path;
      const svc = getIndexerService();
      // Run the walk in the background — the discover channel can absorb
      // pushes faster than the rest of the pipeline drains, but a 5TB
      // library can take minutes to traverse and we don't want the HTTP
      // call to block. Return immediately with the path so the UI can
      // echo what's being scanned.
      void svc
        .walkOnce(folderIdStr, folder.path, { subPath, priority: true })
        .then((count) => {
          log.info(
            { folderId: folderIdStr, path: walkPath, enqueued: count, priority: true },
            "rescan complete",
          );
        })
        .catch((err) => {
          log.warn(
            {
              folderId: folderIdStr,
              path: walkPath,
              err: err instanceof Error ? err.message : err,
            },
            "rescan failed",
          );
        });
      return { ok: true, folderId: folderIdStr, path: walkPath };
    },
    {
      params: t.Object({ folderId: t.String({ minLength: 24, maxLength: 24 }) }),
      body: t.Optional(
        t.Object({
          subPath: t.Optional(t.String()),
        }),
      ),
    },
  );

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function start(): Promise<void> {
  log.info({ port: PORT }, "starting on http://127.0.0.1");

  // Connect to Mongo + start the service in the background. The HTTP server
  // (the supervisor's `waitReady` poll) needs `/status` to return 200 ASAP,
  // even before Mongo is up — the service degrades gracefully if Mongo is
  // offline.
  getDb()
    .then(ensureIndexes)
    .then(() => log.info("DB ready"))
    .then(() => getIndexerService().start())
    .then(() => log.info("service started"))
    .catch((err) => {
      log.warn(
        { err: err instanceof Error ? err.message : err },
        "MongoDB not available",
      );
      log.warn("indexer continues without DB; retry on first job.");
    });

  app.listen({ port: PORT, hostname: "127.0.0.1" });
}

// Graceful shutdown.
async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, "stopping service");
  try {
    await getIndexerService().stop();
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : e },
      "error stopping service",
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
    log.error({ err: e instanceof Error ? e.message : e }, "shutdown error");
    process.exit(1);
  });
});
process.on("SIGINT", () => {
  shutdown("SIGINT").catch((e) => {
    log.error({ err: e instanceof Error ? e.message : e }, "shutdown error");
    process.exit(1);
  });
});

start().catch((err) => {
  log.error(
    { err: err instanceof Error ? err.message : err },
    "fatal startup error",
  );
  process.exit(1);
});
