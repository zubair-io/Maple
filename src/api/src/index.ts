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
 */

import { Elysia } from "elysia";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { child as childLogger } from "./log.ts";
import { healthRoutes } from "./routes/health.ts";
import { foldersRoutes } from "./routes/folders.ts";
import { assetsRoutes } from "./routes/assets.ts";
import { indexerRoutes } from "./routes/indexer.ts";
import { eventsRoutes } from "./routes/events.ts";
import { authRoutes } from "./routes/auth.ts";
import { fsRoutes } from "./routes/fs.ts";
import { fsThumbsRoutes } from "./routes/fs-thumbs.ts";
import { searchRoutes } from "./routes/search.ts";
import { jobsRoutes } from "./routes/jobs.ts";
import { enrichmentRoutes } from "./routes/enrichment.ts";
import { requireAuth } from "./auth/middleware.ts";
import { staticUiPlugin } from "./routes/static_ui.ts";
import { getDb, ensureIndexes, closeDb } from "./db/client.ts";
import {
  spawnChild,
  stopChild,
  waitReady,
  state as indexerState,
} from "./indexer/control.ts";
import {
  startGeocodeWorker,
  stopGeocodeWorker,
} from "./enrichment/bootstrap.ts";
import { startJobRunner, stopJobRunner } from "./job-runner/runner.ts";

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

    log.error(
      {
        method: request.method,
        path: new URL(request.url).pathname,
        err: msg,
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
      .use(assetsRoutes)
      .use(indexerRoutes)
      .use(fsRoutes)
      .use(fsThumbsRoutes)
      .use(searchRoutes)
      .use(jobsRoutes)
      .use(enrichmentRoutes),
  )

  // Static UI (catch-all — must be last so specific API routes match first).
  // NOT auth-gated: serves the Angular bundle's index.html + assets, and the
  // SPA itself walks the user through sign-in via /api/auth/* calls.
  .use(staticUiPlugin);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

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

  // Connect to MongoDB in the background — don't block server start.
  getDb()
    .then(ensureIndexes)
    .then(() => log.info("DB ready"))
    .then(() => {
      // Auto-start the standalone indexer child unless explicitly disabled
      // (`MAPLE_INDEXER_AUTOSTART=0`). The child opens its own Mongo
      // connection on its own event loop — see src/indexer/standalone.ts.
      if (process.env.MAPLE_INDEXER_AUTOSTART === "0") {
        log.info("Indexer autostart disabled (MAPLE_INDEXER_AUTOSTART=0)");
        return;
      }
      spawnChild();
      waitReady()
        .then(() =>
          log.info(
            { pid: indexerState().pid },
            "Indexer process running",
          ),
        )
        .catch((e) =>
          log.warn(
            { err: e instanceof Error ? e.message : e },
            "Indexer process failed to start",
          ),
        );
    })
    .then(() =>
      // Slow-tier enrichment workers run in-process. The boot path
      // health-checks the configured Nominatim instance once. A failure no
      // longer exits the process — the operator can fix the URL via the
      // /settings/enrichment UI without a restart. The error is logged so
      // headless deployments still see it.
      startGeocodeWorker().catch((err) => {
        log.error(
          { err: err instanceof Error ? err.message : err },
          "geocode worker failed to start; fix via /settings/enrichment",
        );
      }),
    )
    .then(() => {
      // JobRunner — sibling subsystem to the indexer pipeline for
      // user-triggered long-running work (export, batch reprocess). See
      // `docs/workers-architecture.md` §9, §11. Reuses the FFI pool for
      // heavy lifting; one in-flight job per process is enough for v1.
      startJobRunner();
    })
    .catch((err) => {
      log.warn(
        { err: err instanceof Error ? err.message : err },
        "MongoDB not available",
      );
      log.warn(
        "Server continues without DB. API routes that need DB will return 503.",
      );
    });

  app.listen(PORT);
}

// Graceful shutdown.
async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, "shutting down");
  // Stop the indexer child first so it gets a chance to flush its
  // pipeline and close its own Mongo connection.
  try {
    await stopChild({ graceful: true });
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : e },
      "error stopping indexer child",
    );
  }
  try {
    await stopGeocodeWorker();
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : e },
      "error stopping geocode worker",
    );
  }
  try {
    await stopJobRunner();
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : e },
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

start();
