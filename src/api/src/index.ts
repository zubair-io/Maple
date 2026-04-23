/**
 * Maple Self Hosted — Bun + Elysia HTTP server.
 *
 * Start: bun src/index.ts
 *
 * Env vars:
 *   PORT               — listen port (default: 3000)
 *   MAPLE_MONGO_URI    — MongoDB connection string (default: mongodb://localhost:27017)
 *   MAPLE_MONGO_DB     — MongoDB database name (default: maple_self_hosted)
 *   MAPLE_ROOTS        — colon-separated allowed FS roots (optional)
 *   MAPLE_INDEXER_WORKERS — concurrent indexer workers (default: 2)
 *   MAPLE_DEV          — set to "1" to proxy UI to Angular dev server
 *   MAPLE_DEV_ORIGIN   — Angular dev server origin (default: http://localhost:4200)
 *   MAPLE_UI_DIST      — override UI dist directory path
 */

import { Elysia } from "elysia";
import { healthRoutes } from "./routes/health.ts";
import { foldersRoutes } from "./routes/folders.ts";
import { assetsRoutes } from "./routes/assets.ts";
import { indexerRoutes } from "./routes/indexer.ts";
import { eventsRoutes } from "./routes/events.ts";
import { authRoutes } from "./routes/auth.ts";
import { staticUiPlugin } from "./routes/static_ui.ts";
import { getDb, ensureIndexes, closeDb } from "./db/client.ts";
import { getIndexerService } from "./indexer/service.ts";

const PORT = Number(process.env.PORT ?? 3000);
const CORS_ORIGIN = process.env.MAPLE_CORS_ORIGIN ?? "*";

// ---------------------------------------------------------------------------
// Build the Elysia app
// ---------------------------------------------------------------------------

const app = new Elysia()
  // CORS headers for all responses.
  .onBeforeHandle(({ set }) => {
    set.headers["Access-Control-Allow-Origin"] = CORS_ORIGIN;
    set.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS";
    set.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
  })
  // Preflight
  .options("/*", ({ set }) => {
    set.headers["Access-Control-Allow-Origin"] = CORS_ORIGIN;
    set.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS";
    set.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
    set.status = 204;
    return;
  })

  // Error handler
  .onError(({ error, set, request }) => {
    const msg = error instanceof Error ? error.message : String(error);
    const isDbErr = msg.includes("[db]") || msg.includes("MongoDB");

    console.error(`[server] ${request.method} ${new URL(request.url).pathname} →`, msg);

    if (isDbErr) {
      set.status = 503;
      return {
        error: "Database unavailable",
        detail: msg,
        tip: 'Start MongoDB with: docker compose up -d mongo',
      };
    }

    set.status = 500;
    return { error: "Internal server error", detail: msg };
  })

  // API routes (registered before static UI so they take priority)
  .use(healthRoutes)
  .use(foldersRoutes)
  .use(assetsRoutes)
  .use(indexerRoutes)
  .use(eventsRoutes)
  .use(authRoutes)

  // Static UI (catch-all — must be last)
  .use(staticUiPlugin);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function start(): Promise<void> {
  console.log(`\nMaple Self Hosted v0.1.0`);
  console.log(`Listening on http://localhost:${PORT}`);
  console.log(`MongoDB: ${process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017"}`);
  if (process.env.MAPLE_DEV === "1") {
    console.log(`UI: proxying to ${process.env.MAPLE_DEV_ORIGIN ?? "http://localhost:4200"}`);
  }

  // Connect to MongoDB in the background — don't block server start.
  getDb()
    .then(ensureIndexes)
    .then(() => console.log("[server] DB ready"))
    .then(() => getIndexerService().start())
    .then(() => console.log("[server] Indexer started"))
    .catch((err) => {
      console.warn(
        "[server] MongoDB not available:",
        err instanceof Error ? err.message : err
      );
      console.warn(
        "[server] Server continues without DB. API routes that need DB will return 503."
      );
    });

  app.listen(PORT);
}

// Graceful shutdown.
function shutdown(signal: string): void {
  console.log(`\n[server] ${signal} received — shutting down`);
  closeDb().finally(() => process.exit(0));
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

start();
