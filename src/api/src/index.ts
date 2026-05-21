/**
 * Maple Self Hosted — Bun + Elysia HTTP server.
 *
 * Start: bun src/index.ts
 *
 * Env vars:
 *   PORT               — listen port (default: 3000)
 *   MAPLE_MONGO_URI    — MongoDB connection string (default: mongodb://localhost:27017)
 *   MAPLE_MONGO_DB     — MongoDB database name (default: maple)
 *   MAPLE_ROOTS        — colon-separated allowed FS roots for browsing &
 *                        registered-folder access. Defaults to '/' (Docker
 *                        mount is the jail). Set explicitly when running
 *                        natively to limit reach.
 *   MAPLE_INDEXER_WORKERS — concurrent indexer workers (default: 2)
 *   MAPLE_DEV          — set to "1" to proxy UI to Angular dev server
 *   MAPLE_DEV_ORIGIN   — Angular dev server origin (default: http://localhost:4200)
 *   MAPLE_DEV_AUTH     — set to "1" to expose /api/auth/dev-login (passkey
 *                        bypass for local development). NEVER set in production.
 *   MAPLE_UI_DIST      — override UI dist directory path
 *   MAPLE_NOMINATIM_URL — base URL of a self-hosted Nominatim instance for
 *                        the slow-tier geocode worker. Worker is skipped
 *                        when unset.
 *   MAPLE_GEOCODE_WORKER_ENABLED — set to "false" to disable the geocode
 *                        worker even when a URL is provided. Default on.
 *   MAPLE_MEILISEARCH_URL — base URL of a Meilisearch sidecar for typo-
 *                        tolerant place search. When unset, the search
 *                        route uses the Mongo $text fallback only. See
 *                        `docs/operations/meilisearch.md`.
 *   MAPLE_MEILISEARCH_API_KEY — bearer key for the Meilisearch instance.
 *   MAPLE_FACE_ORT_INTRA_OP_THREADS — intra-op thread count passed to
 *                        onnxruntime-node when creating the face InferenceSession
 *                        instances. Defaults to `min(4, availableParallelism())`.
 *                        Set explicitly to suppress the host-CPU-count default,
 *                        which spams `pthread_setaffinity_np failed` errors in
 *                        cgroup-restricted containers.
 *   MAPLE_FACE_ORT_INTER_OP_THREADS — inter-op thread count for the same.
 *                        Defaults to 1 (sequential execution mode).
 */

import { Elysia } from "elysia";
import { swagger } from "@elysiajs/swagger";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { child as childLogger } from "./log.ts";
import { healthRoutes } from "./routes/health.ts";
import { foldersRoutes } from "./routes/folders.ts";
import { assetsRoutes } from "./routes/assets.ts";
import { eventsRoutes } from "./routes/events.ts";
import { authRoutes } from "./routes/auth.ts";
import { fsRoutes } from "./routes/fs.ts";
import { fsThumbsRoutes } from "./routes/fs-thumbs.ts";
import { searchRoutes } from "./routes/search.ts";
import { jobsRoutes } from "./routes/jobs.ts";
import { enrichmentRoutes } from "./routes/enrichment.ts";
import { meilisearchBackfillRoutes } from "./routes/admin-backfill-meilisearch.ts";
import { peopleRoutes } from "./routes/people.ts";
import { geocodeReverseRoutes } from "./routes/geocode-reverse.ts";
import { backupIngestRoutes } from "./routes/backup-ingest.ts";
import { backupStateRoutes } from "./routes/backup-state.ts";
import { backupSidecarRoutes } from "./routes/backup-sidecar.ts";
import { backupRenderedRoutes } from "./routes/backup-rendered.ts";
import { backupNotifyDeletedRoutes } from "./routes/backup-notify-deleted.ts";
import { changesRoutes } from "./routes/changes.ts";
import { assetsListRoutes } from "./routes/assets-list.ts";
import { requireAuth } from "./auth/middleware.ts";
import { staticUiPlugin } from "./routes/static_ui.ts";
import { getDb, ensureIndexes, closeDb, foldersCollection } from "./db/client.ts";
import { startTrashGc, type TrashGcHandle } from "./workers/trash-gc.ts";
import { startAllStages, stopAllStages } from "./workers/orchestrator.ts";
import { stageRegistry } from "./workers/registry.ts";
import { startDiscover, type DiscoverHandle } from "./workers/discover/index.ts";
import { workerRoutes } from "./workers/routes.ts";
import {
  startGeocodeWorker,
  stopGeocodeWorker,
} from "./enrichment/bootstrap.ts";
import {
  startFaceWorker,
  stopFaceWorker,
} from "./enrichment/face-bootstrap.ts";
import {
  startDescribeWorker,
  stopDescribeWorker,
} from "./enrichment/describe-bootstrap.ts";
import { meilisearchClient } from "./enrichment/meilisearch-client.ts";
import { startJobRunner, stopJobRunner } from "./job-runner/runner.ts";
import { getChangeFeedTailer } from "./runtime/change-feed-tailer.ts";

const PORT = Number(process.env.PORT ?? 3000);
const CORS_ORIGIN = process.env.MAPLE_CORS_ORIGIN ?? "*";

const log = childLogger("server");

// ---------------------------------------------------------------------------
// JWT secret bootstrap
// ---------------------------------------------------------------------------
//
// Resolves MAPLE_JWT_SECRET in priority order:
//   1. Explicit env var (caller-managed; e.g. CI, secret store).
//   2. File on disk at MAPLE_JWT_SECRET_FILE or `./.maple/jwt.secret`.
//   3. Generate 32 random bytes (base64url), persist with mode 0o600,
//      and use that. The .maple/ directory is gitignored.
function ensureJwtSecret(): void {
  if (process.env.MAPLE_JWT_SECRET) return;
  const path = process.env.MAPLE_JWT_SECRET_FILE ?? "./.maple/jwt.secret";
  if (existsSync(path)) {
    process.env.MAPLE_JWT_SECRET = readFileSync(path, "utf8").trim();
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const secret = randomBytes(32).toString("base64url");
  writeFileSync(path, secret, { mode: 0o600 });
  process.env.MAPLE_JWT_SECRET = secret;
  log.info({ path }, "generated JWT secret");
}

// ---------------------------------------------------------------------------
// Build the Elysia app
// ---------------------------------------------------------------------------

export function buildApp(_opts: { stageNames?: string[] } = {}): Elysia {
  const app = new Elysia()
    // CORS + cross-origin isolation headers for every response.
    //
    // T10: COOP: same-origin + COEP: require-corp are required so the hosted
    // Angular bundle can use SharedArrayBuffer for the WASM rayon thread pool.
    // Both the API responses and the static-UI responses share this middleware
    // because the page becomes cross-origin-isolated only when *every* top-level
    // document response carries both headers.
    .onBeforeHandle(({ set }) => {
      set.headers["Access-Control-Allow-Origin"] = CORS_ORIGIN;
      set.headers["Access-Control-Allow-Methods"] =
        "GET, POST, PUT, DELETE, OPTIONS";
      set.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
      set.headers["Cross-Origin-Opener-Policy"] = "same-origin";
      set.headers["Cross-Origin-Embedder-Policy"] = "require-corp";
    })
    // Mirror the isolation headers onto OPTIONS preflight too, so that any
    // cross-origin check counts them as present.
    .options("/*", ({ set }) => {
      set.headers["Access-Control-Allow-Origin"] = CORS_ORIGIN;
      set.headers["Access-Control-Allow-Methods"] =
        "GET, POST, PUT, DELETE, OPTIONS";
      set.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
      set.headers["Cross-Origin-Opener-Policy"] = "same-origin";
      set.headers["Cross-Origin-Embedder-Policy"] = "require-corp";
      set.status = 204;
      return;
    })

    // Error handler
    .onError(({ error, set, request }) => {
      const msg = error instanceof Error ? error.message : String(error);
      const isDbErr = msg.includes("[db]") || msg.includes("MongoDB");

      // Pass the raw `error` to pino so its serializer preserves the
      // stack + structured driver fields (e.g. MongoDB error codes).
      log.error(
        {
          method: request.method,
          path: new URL(request.url).pathname,
          err: error,
        },
        "request error",
      );

      if (isDbErr) {
        set.status = 503;
        return {
          error: "Database unavailable",
          detail: msg,
          tip: "Start MongoDB with: docker compose up -d mongo",
        };
      }

      // Preserve status codes set by middleware (e.g. requireAuth sets 401
      // before throwing). Only fall back to 500 for errors with no explicit
      // status — otherwise an auth rejection surfaces to the client as a
      // generic 500 and the SPA can't react to it.
      const preset = typeof set.status === "number" ? set.status : 0;
      if (preset >= 400 && preset < 600) {
        return { error: msg };
      }
      set.status = 500;
      return { error: "Internal server error", detail: msg };
    })

    // Public API routes (no bearer required) — health + the session-bootstrap
    // half of /api/auth (login/register/refresh/logout). The /api/auth/me +
    // credentials + invites routes wrap themselves in their own `.use(requireAuth)`
    // sub-tree internally, so the whole authRoutes plugin can sit outside the gate.
    .use(healthRoutes)
    .use(authRoutes)
    // Read-only geocode cache lookup — used by PhotoKit-backup clients to
    // determine a destination folder path before uploading; no auth required
    // since it returns no user data (only Place metadata keyed by lat/lon).
    .use(geocodeReverseRoutes)
    // Chunked, resumable backup ingest from PhotoKit-backed devices. No auth
    // gate yet — the passkey auth design (PR 2026-04-26) hasn't landed. Once
    // it does, this route should move behind requireAuth.
    .use(backupIngestRoutes)
    // Reconciliation feed — device calls this on launch / periodic walks to
    // learn which assets are already backed up. No auth gate for the same
    // reason as backupIngestRoutes above.
    .use(backupStateRoutes)
    // XMP sidecar upload — writes a .xmp file next to a previously-uploaded
    // asset. No auth gate (same rationale as backupIngestRoutes).
    .use(backupSidecarRoutes)
    // Rendered companion upload — chunked + resumable, mirrors ingest.
    .use(backupRenderedRoutes)
    // Deletion reconciliation — marks assets deleted from Apple Photos.
    .use(backupNotifyDeletedRoutes)
    // /api/events self-authenticates via a `?token=` query parameter on the
    // WS handshake (browsers can't send Authorization headers on
    // `new WebSocket()`). Mounting it here keeps it outside the bearer-only
    // sub-app's `requireAuth` derive.
    .use(eventsRoutes)

    // Authenticated API routes — wrapped in a sub-app so the `requireAuth`
    // scoped-derive only applies to these. Without the sub-app the derive
    // would leak forward to `staticUiPlugin`, breaking unauthenticated cold
    // loads (you can't reach /sign-in if the server demands a bearer to
    // serve index.html).
    .use(
      new Elysia({ name: "authedApi" })
        .use(requireAuth)
        .use(foldersRoutes)
        // Mounted BEFORE assetsRoutes so the bare `GET /api/assets` list
        // endpoint matches before the `:id`-prefixed routes shadow it.
        .use(assetsListRoutes)
        .use(assetsRoutes)
        .use(fsRoutes)
        .use(fsThumbsRoutes)
        .use(searchRoutes)
        .use(jobsRoutes)
        .use(enrichmentRoutes)
        .use(meilisearchBackfillRoutes)
        .use(peopleRoutes)
        .use(changesRoutes)
        .use(workerRoutes()),
    )

    // OpenAPI spec + Scalar docs UI. Source-of-truth for HTTP DTOs that
    // web + apple clients codegen from (issue #131). Mounted outside the
    // requireAuth sub-app so the spec is reachable without a bearer — the
    // schema itself is not sensitive and clients fetching it for codegen
    // run unauthenticated. Routes show up with full schemas where the
    // owner has declared TypeBox `t.Object(...)` on the route definition,
    // and as `any`-typed bodies otherwise; tightening schemas is a
    // per-route follow-up.
    .use(
      swagger({
        // Scalar UI at /docs (human-readable), spec JSON at /openapi.json.
        path: "/docs",
        specPath: "/openapi.json",
        documentation: {
          info: {
            title: "Maple API",
            version: "0.1.0",
            description:
              "Maple Self Hosted HTTP API. See https://github.com/zubair-io/Maple/issues/131.",
          },
        },
      }),
    )

    // Static UI (catch-all — must be last so specific API routes match first).
    // NOT auth-gated: serves the Angular bundle's index.html + assets, and the
    // SPA itself walks the user through sign-in via /api/auth/* calls.
    .use(staticUiPlugin);

  return app;
}

/**
 * Singleton app instance used by tests that import `{ app }` directly.
 * Stages are started by `start()` below — never during a test-driven import.
 */
export const app = buildApp({ stageNames: [] });

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

/** Background handles whose lifecycle is owned by start()/shutdown(). */
let _trashGcHandle: TrashGcHandle | null = null;
let _discoverHandle: DiscoverHandle | null = null;

async function start(): Promise<void> {
  ensureJwtSecret();
  log.info(
    {
      version: "0.1.0",
      port: PORT,
      mongo_uri: process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017",
    },
    "Maple Self Hosted starting",
  );
  if (process.env.MAPLE_DEV === "1") {
    log.info(
      { dev_origin: process.env.MAPLE_DEV_ORIGIN ?? "http://localhost:4200" },
      "UI: proxying to dev origin",
    );
  }
  if (process.env.MAPLE_DEV_AUTH === "1") {
    log.warn(
      "*** MAPLE_DEV_AUTH=1 — passkey bypass enabled. /api/auth/dev-login is exposed. Do NOT set this in production.",
    );
  }

  // Boot sequence runs in the background — don't block server start.
  // Each phase is isolated: a failure (e.g. an IndexOptionsConflict during
  // ensureIndexes, or a dup-key during a unique-index build) is logged
  // and the next phase still runs. Only the DB connection itself is
  // hard-required; without it, downstream phases are skipped.
  void (async () => {
    try {
      await getDb();
    } catch (err) {
      log.warn(
        { err },
        "MongoDB not available — server continues, DB-bound routes will 503",
      );
      return;
    }

    try {
      await ensureIndexes();
      log.info("DB ready");
    } catch (err) {
      log.error(
        { err },
        "ensureIndexes failed — continuing without all indexes; affected routes may be slower until resolved",
      );
    }

    try {
      // Republishes `asset_changes` rows onto the in-process bus so SSE
      // clients see worker-emitted changes.
      await getChangeFeedTailer().start();
    } catch (err) {
      log.error(
        { err },
        "change feed tailer failed to start",
      );
    }

    // Auto-start the in-process stage runners unless explicitly disabled.
    if (process.env.MAPLE_INDEXER_AUTOSTART === "0") {
      log.info("Indexer autostart disabled (MAPLE_INDEXER_AUTOSTART=0)");
    } else {
      try {
        await startAllStages();
        log.info(stageRegistry.statuses(), "Worker stages running");
      } catch (err) {
        log.warn(
          { err },
          "Worker stages failed to start",
        );
      }

      try {
        const foldersColl = await foldersCollection();
        const folders = await foldersColl
          .find({}, { projection: { path: 1 } })
          .toArray();
        const discoverRoots = folders.map((f) => f.path).filter(Boolean);
        if (discoverRoots.length > 0) {
          _discoverHandle = await startDiscover({ roots: discoverRoots });
        }
      } catch (err) {
        log.warn(
          { err },
          "Discover failed to start",
        );
      }
    }

    // Slow-tier enrichment workers run in-process. Each one's failure is
    // isolated — the operator recovers via /settings/enrichment without a
    // restart.
    try {
      await startGeocodeWorker();
    } catch (err) {
      log.error(
        { err },
        "geocode worker failed to start; fix via /settings/enrichment",
      );
    }

    try {
      await startFaceWorker();
    } catch (err) {
      log.error(
        { err },
        "face worker failed to start; fix via /settings/enrichment",
      );
    }

    try {
      await startDescribeWorker();
    } catch (err) {
      log.error(
        { err },
        "describe worker failed to start; fix via /settings/enrichment",
      );
    }

    try {
      // Meilisearch sidecar. Search falls back to Mongo $text when
      // unconfigured / unreachable / index build fails.
      const meili = meilisearchClient();
      if (!meili.isConfigured()) {
        log.info("MAPLE_MEILISEARCH_URL unset — Meilisearch sidecar disabled");
      } else if (!(await meili.health())) {
        log.warn(
          "Meilisearch health check failed; search will fall back to Mongo $text until the service is reachable",
        );
      } else {
        await meili.ensureIndex();
        log.info("Meilisearch sidecar ready");
      }
    } catch (err) {
      log.warn(
        { err },
        "Meilisearch boot failed; search will fall back to Mongo $text",
      );
    }

    try {
      // JobRunner — sibling subsystem to the indexer pipeline for
      // user-triggered long-running work (export, batch reprocess).
      startJobRunner();
    } catch (err) {
      log.warn(
        { err },
        "JobRunner failed to start",
      );
    }
  })();

  const app = buildApp();
  app.listen(PORT);
  // Phase 3 trash-gc — fire once at boot, then once a day. The handle's
  // stop() is invoked during shutdown so a clean exit cancels the timer.
  _trashGcHandle = startTrashGc({});
  // shutdown() handles stage drain via stopAllStages(); no separate hook needed.
}

// Graceful shutdown.
async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, "shutting down");
  // Stop the change-feed tailer first — its self-scheduling setTimeout
  // would otherwise keep the event loop alive after Mongo closes.
  try {
    getChangeFeedTailer().stop();
  } catch (e) {
    log.warn(
      { err: e },
      "error stopping change feed tailer",
    );
  }
  // Stop the trash-gc loop next so its daily timer doesn't fire mid-shutdown.
  try { _trashGcHandle?.stop(); _trashGcHandle = null; }
  catch (e) {
    log.warn({ err: e }, "error stopping trash-gc");
  }
  // Stop the file-system watcher so it stops producing new docs while we drain.
  try {
    await _discoverHandle?.stop();
    _discoverHandle = null;
  } catch (e) {
    log.warn(
      { err: e },
      "error stopping discover",
    );
  }
  // Stop the in-process stage runners so any in-flight handler can drain
  // before the process exits.
  try {
    await stopAllStages();
  } catch (e) {
    log.warn(
      { err: e },
      "error stopping worker stages",
    );
  }
  try {
    await stopGeocodeWorker();
  } catch (e) {
    log.warn(
      { err: e },
      "error stopping geocode worker",
    );
  }
  try {
    await stopFaceWorker();
  } catch (e) {
    log.warn(
      { err: e },
      "error stopping face worker",
    );
  }
  try {
    await stopDescribeWorker();
  } catch (e) {
    log.warn(
      { err: e },
      "error stopping describe worker",
    );
  }
  try {
    await stopJobRunner();
  } catch (e) {
    log.warn(
      { err: e },
      "error stopping job runner",
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
    log.error({ err: e }, "shutdown error");
    process.exit(1);
  });
});
process.on("SIGINT", () => {
  shutdown("SIGINT").catch((e) => {
    log.error({ err: e }, "shutdown error");
    process.exit(1);
  });
});

// Only kick off the boot sequence when this module is run as the process
// entry point — `bun src/index.ts`. Importing the module (tests reaching
// for `app` / `buildApp` / route handlers) must not trigger the background
// boot, otherwise its `ensureIndexes()` races with the test harness's
// `closeDb()` calls and randomly skips index builds downstream tests rely
// on. Bun sets `import.meta.main = true` for the entry module.
if ((import.meta as { main?: boolean }).main) {
  start();
}
