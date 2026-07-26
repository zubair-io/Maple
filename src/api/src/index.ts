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

import { Elysia } from 'elysia';
import { swagger } from '@elysiajs/swagger';
import { child as childLogger } from './log.ts';
import { ensureJwtSecret } from './auth/jwt-bootstrap.ts';
import { requestContext } from './middleware/request-context.ts';
import { healthRoutes } from './routes/health.ts';
import { networkPublicRoutes, networkSettingsRoutes } from './routes/network.ts';
import { foldersRoutes } from './routes/folders.ts';
import { assetsRoutes } from './routes/assets.ts';
import { xmpPathRoutes } from './routes/xmp.ts';
import { previewPathRoutes } from './routes/preview.ts';
import { eventsRoutes } from './routes/events.ts';
import { videoRoutes } from './routes/video.ts';
import { authRoutes } from './routes/auth.ts';
import { nativeCodeRedeemRoutes, nativeCodeIssueRoutes } from './routes/auth-native-code.ts';
import { lanHandoffIssueRoutes, lanHandoffRedeemRoutes } from './routes/auth-lan-handoff.ts';
import { accountRoutes } from './routes/auth-account.ts';
import { authDeviceSessionRoutes } from './routes/auth-device-sessions.ts';
import { fsRoutes } from './routes/fs.ts';
import { fsThumbsRoutes } from './routes/fs-thumbs.ts';
import { fsPreviewsRoutes } from './routes/fs-previews.ts';
import { searchRoutes } from './routes/search.ts';
import { jobsRoutes } from './routes/jobs.ts';
import { importsRoutes } from './routes/imports.ts';
import { enrichmentRoutes } from './routes/enrichment.ts';
import { cloudflareRoutes } from './routes/cloudflare.ts';
import { observabilityRoutes } from './routes/observability.ts';
import { meilisearchBackfillRoutes } from './routes/admin-backfill-meilisearch.ts';
import { adminMeilisearchStatusRoutes } from './routes/admin-meilisearch-status.ts';
import { serviceApiKeyAdminRoutes } from './routes/service-api-keys.ts';
import { serviceAssetSearchRoutes } from './routes/service-asset-search.ts';
import { purgeSubthresholdFacesRoutes } from './routes/admin-purge-subthreshold-faces.ts';
import { peopleRoutes } from './routes/people.ts';
import { presetsRoutes } from './routes/presets.ts';
import { panoRoutes } from './routes/pano.ts';
import { geocodeReverseRoutes } from './routes/geocode-reverse.ts';
import { batchMetadataRoutes } from './routes/batch-metadata.ts';
import { backupIngestRoutes } from './routes/backup-ingest.ts';
import { BACKUP_CHUNK_DIR, clearBackupChunkDir } from './backup/config.ts';
import { uploadSessions } from './backup/upload-session.ts';
import { backupStateRoutes } from './routes/backup-state.ts';
import { backupExistsRoutes } from './routes/backup-exists.ts';
import { backupSidecarRoutes } from './routes/backup-sidecar.ts';
import { backupRenderedRoutes } from './routes/backup-rendered.ts';
import { backupNotifyDeletedRoutes } from './routes/backup-notify-deleted.ts';
import { changesRoutes } from './routes/changes.ts';
import { mirrorRoutes } from './routes/mirror.ts';
import { derivativeAuditRoutes } from './routes/derivative-audit.ts';
import { assetsListRoutes } from './routes/assets-list.ts';
import { photosRoutes } from './routes/photos.ts';
import { displayRoutes } from './routes/display.ts';
import { requireAuth } from './auth/middleware.ts';
import { staticUiPlugin } from './routes/static_ui.ts';
import { getDb, ensureIndexes, closeDb } from './db/client.ts';
import { loadMirrorConfig } from './fs/mirror-config.ts';
import { flushPendingMirrorOps } from './fs/mirrored.ts';
import { installMirrorQueueSink } from './workers/mirror/sink.ts';
import { workerRoutes } from './workers/routes.ts';
import { libraryRoutes } from './routes/library/index.ts';
import { initializeHttpSearch } from './enrichment/meilisearch-http-bootstrap.ts';
import {
  loadObservabilityConfig,
  resolveObservabilityConfig,
} from './observability/observability-config.repo.ts';
import { initOtel, shutdownOtel } from './otel.ts';
import { getChangeFeedTailer } from './runtime/change-feed-tailer.ts';
import { startEventLoopLagMonitor, stopEventLoopLagMonitor } from './runtime/diag-eventloop.ts';
import {
  ChildProcessWorker,
  childScriptPath,
  DEFAULT_NATIVE_CHILD_NICE,
} from './runtime/child-process-worker.ts';
import { SERVER_PORT } from './runtime/server-port.ts';

const PORT = SERVER_PORT;
const CORS_ORIGIN = process.env.MAPLE_CORS_ORIGIN ?? '*';

const log = childLogger('server');

// JWT secret bootstrap lives in `./auth/jwt-bootstrap.ts` (extracted to keep
// this file under the line budget). `ensureJwtSecret()` is awaited in start().

// ---------------------------------------------------------------------------
// Build the Elysia app
// ---------------------------------------------------------------------------

export function buildApp(_opts: { stageNames?: string[] } = {}): Elysia {
  const app = new Elysia()
    // Request-id + uniform error envelope. Mounted first so its onRequest
    // / derive / onError / mapResponse hooks see every downstream request
    // (including the authedApi sub-tree and the staticUiPlugin catch-all).
    // See `middleware/request-context.ts` for envelope shape + status→code
    // mapping. Issue #133.
    .use(requestContext)
    // CORS + cross-origin isolation headers for every response.
    //
    // T10: COOP: same-origin + COEP: require-corp are required so the hosted
    // Angular bundle can use SharedArrayBuffer for the WASM rayon thread pool.
    // Both the API responses and the static-UI responses share this middleware
    // because the page becomes cross-origin-isolated only when *every* top-level
    // document response carries both headers.
    .onBeforeHandle(({ set }) => {
      set.headers['Access-Control-Allow-Origin'] = CORS_ORIGIN;
      set.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
      set.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
      set.headers['Cross-Origin-Opener-Policy'] = 'same-origin';
      set.headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
    })
    // Mirror the isolation headers onto OPTIONS preflight too, so that any
    // cross-origin check counts them as present.
    .options('/*', ({ headers, set }) => {
      set.headers['Access-Control-Allow-Origin'] = CORS_ORIGIN;
      set.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
      set.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
      set.headers['Cross-Origin-Opener-Policy'] = 'same-origin';
      set.headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
      // Chrome's Private Network Access: only echo this back when the
      // browser's preflight actually asked for it — a page only sets this
      // header when it resolved the target to a private-network address in
      // the first place, so this only ever fires for the LAN discovery flow
      // (see routes/network.ts), not for every cross-origin request this
      // server answers. Blanket-setting it (as an earlier version of this
      // change did) would let ANY public webpage bypass PNA for every route,
      // not just the intentionally-public one — a meaningfully wider
      // exposure than the feature needs.
      if (headers['access-control-request-private-network'] === 'true') {
        set.headers['Access-Control-Allow-Private-Network'] = 'true';
      }
      set.status = 204;
      return;
    })

    // Error handler is registered by `requestContext` above (it owns the
    // envelope shape + request-id plumbing). See `middleware/request-context.ts`.

    // Public API routes (no bearer required) — health + the session-bootstrap
    // half of /api/auth (login/register/refresh/logout). The /api/auth/me +
    // credentials + invites routes wrap themselves in their own `.use(requireAuth)`
    // sub-tree internally, so the whole authRoutes plugin can sit outside the gate.
    .use(healthRoutes)
    .use(networkPublicRoutes)
    .use(authRoutes)
    // Wraps itself in `.use(requireAuth).use(requireOwner)` internally
    // (mirrors authRoutes' /invites sub-tree above), so it sits outside
    // the authedApi gate the same way.
    .use(cloudflareRoutes)
    // Service-key management self-gates with owner auth; service search
    // self-gates with a dedicated scoped API key rather than a user JWT.
    .use(serviceApiKeyAdminRoutes)
    .use(serviceAssetSearchRoutes)
    // Native PKCE code redeem (public) — the Apple shell exchanges its one-time
    // code for tokens here; no bearer (this is how the app first gets tokens).
    .use(nativeCodeRedeemRoutes)
    // Web-to-web-LAN session handoff redeem (public) — the LAN-origin page
    // exchanges its one-time code for tokens here; no bearer (this is how
    // that origin first gets tokens). See routes/auth-lan-handoff.ts.
    .use(lanHandoffRedeemRoutes)
    // Read-only geocode cache lookup — used by PhotoKit-backup clients to
    // determine a destination folder path before uploading; no auth required
    // since it returns no user data (only Place metadata keyed by lat/lon).
    .use(geocodeReverseRoutes)
    // /api/events self-authenticates via a `?token=` query parameter on the
    // WS handshake (browsers can't send Authorization headers on
    // `new WebSocket()`). Mounting it here keeps it outside the bearer-only
    // sub-app's `requireAuth` derive.
    .use(eventsRoutes)
    .use(videoRoutes)

    // Authenticated API routes — wrapped in a sub-app so the `requireAuth`
    // scoped-derive only applies to these. Without the sub-app the derive
    // would leak forward to `staticUiPlugin`, breaking unauthenticated cold
    // loads (you can't reach /sign-in if the server demands a bearer to
    // serve index.html).
    .use(
      new Elysia({ name: 'authedApi' })
        .use(requireAuth)
        // PhotoKit-backup routes — chunked ingest, reconciliation/dedup
        // probes, sidecar + rendered-companion uploads, and deletion
        // reconciliation. Gated behind requireAuth (#853): they accept file
        // writes and destructive deletes, so they must never be reachable
        // without a bearer. The Apple backup clients attach the access token
        // (#855); path containment on the writes is tightened in #854.
        .use(backupIngestRoutes)
        .use(backupStateRoutes)
        .use(backupExistsRoutes)
        .use(backupSidecarRoutes)
        .use(backupRenderedRoutes)
        .use(backupNotifyDeletedRoutes)
        .use(foldersRoutes)
        // M1 unified library addressing routes (slug:relPath).
        // Mounted before assetsRoutes so /api/folder|image|thumb|preview
        // are not shadowed by other prefixes.
        .use(libraryRoutes)
        // Mounted BEFORE assetsRoutes so the bare `GET /api/assets` list
        // endpoint matches before the `:id`-prefixed routes shadow it.
        .use(assetsListRoutes)
        .use(assetsRoutes)
        .use(xmpPathRoutes)
        .use(previewPathRoutes)
        .use(batchMetadataRoutes)
        .use(fsRoutes)
        .use(fsThumbsRoutes)
        .use(fsPreviewsRoutes)
        .use(searchRoutes)
        .use(jobsRoutes)
        .use(importsRoutes)
        .use(enrichmentRoutes)
        .use(observabilityRoutes)
        .use(networkSettingsRoutes)
        .use(meilisearchBackfillRoutes)
        .use(adminMeilisearchStatusRoutes)
        .use(purgeSubthresholdFacesRoutes)
        .use(peopleRoutes)
        .use(presetsRoutes)
        .use(photosRoutes)
        .use(displayRoutes)
        .use(panoRoutes)
        .use(changesRoutes)
        .use(mirrorRoutes)
        .use(derivativeAuditRoutes)
        .use(workerRoutes()),
    )

    // Native PKCE code issue (authed) — wrapped in its own sub-app so its
    // `requireAuth` scoped-derive stays contained (same isolation as authedApi).
    .use(new Elysia({ name: 'authedNativeCode' }).use(nativeCodeIssueRoutes))

    // Web-to-web-LAN session handoff issue (authed) — wrapped in its own
    // sub-app so its `requireAuth` scoped-derive stays contained.
    .use(new Elysia({ name: 'authedLanHandoff' }).use(lanHandoffIssueRoutes))

    // Authenticated account self-service (#861): /me, step-up re-auth, credential
    // management. Wrapped so its `requireAuth` scoped-derive stays contained.
    .use(new Elysia({ name: 'authedAccount' }).use(accountRoutes))

    // Paired-device sessions (Maple TV pairing, milestone B, #2075): mint
    // (proof-of-refresh-token), list, step-up-gated revoke. Wrapped so its
    // `requireAuth` scoped-derive stays contained — same isolation as
    // authedAccount / authedNativeCode above.
    .use(new Elysia({ name: 'authedDeviceSessions' }).use(authDeviceSessionRoutes))

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
        path: '/docs',
        specPath: '/openapi.json',
        documentation: {
          info: {
            title: 'Maple API',
            version: '0.1.0',
            description:
              'Maple Self Hosted HTTP API. See https://github.com/zubair-io/Maple/issues/131.',
          },
        },
      }),
    )

    // Static UI (catch-all — must be last so specific API routes match first).
    // NOT auth-gated: serves the Angular bundle's index.html + assets, and the
    // SPA itself walks the user through sign-in via /api/auth/* calls.
    .use(staticUiPlugin);

  // The accumulated route/schema generics on `app` at this point exceed
  // TypeScript's structural-comparison depth (TS2589) once every plugin
  // (now including photosRoutes/displayRoutes) is chained in — this
  // function's declared return type is deliberately the bare `Elysia`
  // (callers never rely on precise per-route inference here), so widen
  // explicitly rather than asking the compiler to prove the full
  // structural match.
  return app as unknown as Elysia;
}

/**
 * Singleton app instance used by tests that import `{ app }` directly.
 * Stages are started by `start()` below — never during a test-driven import.
 */
export const app = buildApp({ stageNames: [] });

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

/** Handle for the spawned worker-tier child process (Task 3). */
let _workerChild: ChildProcessWorker | null = null;

/** Set to true at the start of shutdown() so the respawn guard doesn't
 * re-spawn a worker that we intentionally terminated. */
let shuttingDown = false;

async function start(): Promise<void> {
  await ensureJwtSecret();
  log.info(
    {
      version: '0.1.0',
      port: PORT,
      mongo_uri: process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017',
    },
    'Maple Self Hosted starting',
  );
  if (process.env.MAPLE_DEV === '1') {
    log.info(
      { dev_origin: process.env.MAPLE_DEV_ORIGIN ?? 'http://localhost:4200' },
      'UI: proxying to dev origin',
    );
  }
  if (process.env.MAPLE_DEV_AUTH === '1') {
    log.warn(
      '*** MAPLE_DEV_AUTH=1 — passkey bypass enabled. /api/auth/dev-login is exposed. Do NOT set this in production.',
    );
  }

  // Boot sequence runs in the background — don't block server start. Each phase
  // is isolated: a failure (e.g. an IndexOptionsConflict during ensureIndexes) is
  // logged and the next phase still runs. Only the DB connection is hard-required.
  void (async () => {
    // RAW decode (thumb / preview / histogram) runs in isolated child
    // processes — see `ffi/ffi-pool.ts`. The dylib is `dlopen`'d inside each
    // child on first spawn, deliberately NEVER in this HTTP process, so a
    // libraw segfault on a malformed RAW can only ever kill a child (which the
    // pool respawns) and never the server. Nothing to warm here; the pool
    // spawns its first child lazily on the first decode request.

    try {
      await getDb();
    } catch (err) {
      log.warn({ err }, 'MongoDB not available — server continues, DB-bound routes will 503');
      return;
    }

    try {
      await ensureIndexes();
      log.info('DB ready');
    } catch (err) {
      log.error(
        { err },
        'ensureIndexes failed — continuing without all indexes; affected routes may be slower until resolved',
      );
    }

    try {
      // Populate the in-memory library→mirror registry so durable writes
      // replicate to configured backup roots. Safe to skip on failure — an
      // unloaded registry just means no mirroring until the next reload.
      await loadMirrorConfig();
      // Route this process's inline replication failures (backup ingest / XMP /
      // uploads) into the durable mirror_queue so the copy worker retries them.
      installMirrorQueueSink();
    } catch (err) {
      log.error({ err }, 'mirror config load failed — mirroring inactive until reloaded');
    }

    try {
      // Republishes `asset_changes` rows onto the in-process bus so SSE
      // clients see worker-emitted changes.
      await getChangeFeedTailer().start();
    } catch (err) {
      log.error({ err }, 'change feed tailer failed to start');
    }

    // Worker tier — spawned as a niced child process so the HTTP event loop can
    // never be starved or crashed by indexer/enrichment load. The child runs
    // `startWorkers()` which owns stages, discover, FFI pool, enrichment, job
    // runner, and import runner. Auto-respawns on crash unless shutting down.
    // Respawn backoff. A worker that dies almost immediately is crash-looping
    // (e.g. a poison asset that aborts the tier on boot per #897, or a bad
    // deploy); a flat 1s respawn just hammers the box and the log pipeline.
    // Grow the delay on each rapid death (capped), and reset it once a worker
    // has run healthily — so a one-off crash still respawns promptly.
    const WORKER_RESPAWN_MIN_MS = 1000;
    const WORKER_RESPAWN_MAX_MS = 30_000;
    const WORKER_HEALTHY_UPTIME_MS = 60_000;
    let workerRespawnMs = WORKER_RESPAWN_MIN_MS;
    function spawnWorker(): void {
      if (shuttingDown) return;
      try {
        const spawnedAt = Date.now();
        const w = new ChildProcessWorker(
          childScriptPath(import.meta.url, './workers/worker-main.ts'),
          { nice: DEFAULT_NATIVE_CHILD_NICE, label: 'worker' },
        );
        w.addEventListener('error', (e) => {
          const uptimeMs = Date.now() - spawnedAt;
          // Ran healthily then died → one-off, reset backoff. Died fast → grow it.
          if (uptimeMs >= WORKER_HEALTHY_UPTIME_MS) workerRespawnMs = WORKER_RESPAWN_MIN_MS;
          const delayMs = workerRespawnMs;
          workerRespawnMs = Math.min(workerRespawnMs * 2, WORKER_RESPAWN_MAX_MS);
          log.error(
            { msg: e.message, uptimeMs, respawnInMs: delayMs },
            'worker process died — respawning',
          );
          _workerChild = null;
          if (!shuttingDown) setTimeout(spawnWorker, delayMs);
        });
        _workerChild = w;
        log.info('worker process spawned');
      } catch (err) {
        log.error({ err }, 'failed to spawn worker process');
      }
    }
    if (process.env.MAPLE_INDEXER_AUTOSTART === '0') {
      log.info('Worker process disabled (MAPLE_INDEXER_AUTOSTART=0)');
    } else {
      spawnWorker();
    }

    await initializeHttpSearch();

    try {
      // OpenTelemetry → SigNoz. The backend ships its own logs + traces over
      // OTLP/HTTP. Config is DB-backed (set it via the Settings → Observability
      // page or PUT /api/observability/config). initOtel is a no-op when
      // telemetry is disabled or no endpoint is configured.
      const resolvedObs = resolveObservabilityConfig(await loadObservabilityConfig());
      await initOtel(resolvedObs);
    } catch (err) {
      log.warn({ err }, 'OpenTelemetry init failed; continuing without telemetry');
    }
  })();

  // Wipe leftover chunk-staging files from any previous run before we
  // start accepting backup uploads. Awaited so we never serve a request
  // against a half-cleared staging dir; the route is already self-healing
  // on missing `.part` files (returns 409 expected_offset: 0).
  //
  // Failure is logged at `error` (operator-visible) but non-fatal — the
  // pattern matches the surrounding subsystem boots (workers, discover,
  // meili, jobrunner all log + continue). A missing success line is the
  // operator's signal that the backup subsystem is degraded; promoting to
  // process exit would be inconsistent with the rest of the boot.
  try {
    await clearBackupChunkDir();
    log.info({ dir: BACKUP_CHUNK_DIR }, 'cleared backup chunk staging dir');
  } catch (err) {
    log.error(
      { err, dir: BACKUP_CHUNK_DIR },
      'failed to clear backup chunk staging dir — backup uploads may be inconsistent until fixed',
    );
  }

  // Reset received_bytes on every `state: 'open'` Mongo row. We just deleted
  // their on-disk bytes; without this, a client retrying a previously
  // in-progress session would see 409 expected_offset > 0 and (when
  // received_bytes == total) fall out of the upload loop entirely.
  try {
    const reset = await uploadSessions.resetAllInProgressBytes();
    if (reset > 0) log.info({ count: reset }, 'reset in-progress upload sessions');
  } catch (err) {
    log.error(
      { err },
      'failed to reset in-progress upload sessions — clients may see stale 409s until fixed',
    );
  }

  // Event-loop lag probe — strict no-op unless MAPLE_DIAG_EVENTLOOP=1. Started
  // before listen() so it observes the whole request-serving lifetime; its
  // timers are unref'd so it never holds the process open. See
  // `runtime/diag-eventloop.ts`.
  startEventLoopLagMonitor();

  const server = buildApp();
  server.listen(PORT);
}

// Graceful shutdown.
async function shutdown(signal: string): Promise<void> {
  shuttingDown = true;
  log.info({ signal }, 'shutting down');
  // Stop the event-loop lag probe (no-op if it was never started).
  try {
    stopEventLoopLagMonitor();
  } catch (e) {
    log.warn({ err: e }, 'error stopping event-loop lag monitor');
  }
  // Stop the change-feed tailer first — its self-scheduling setTimeout
  // would otherwise keep the event loop alive after Mongo closes.
  try {
    getChangeFeedTailer().stop();
  } catch (e) {
    log.warn({ err: e }, 'error stopping change feed tailer');
  }
  // Terminate the worker child process. Its own SIGTERM handler drains all
  // stages, discover, enrichment workers, job/import runners, and FFI pool
  // before exiting. Best-effort — worker may already be dead or not yet spawned.
  try {
    _workerChild?.terminate();
    _workerChild = null;
  } catch (e) {
    log.warn({ err: e }, 'error stopping worker process');
  }
  // Flush + shut down the OpenTelemetry SDK so its batch exporters drain and
  // its timers stop keeping the event loop alive.
  try {
    await shutdownOtel();
  } catch (e) {
    log.warn({ err: e }, 'error stopping OpenTelemetry SDK');
  }
  // Drain any in-flight mirror replication so a backup copy isn't cut off
  // mid-write on shutdown. Best-effort + bounded — never block exit on it.
  try {
    await Promise.race([
      flushPendingMirrorOps(),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
  } catch {
    /* ignore */
  }
  try {
    await closeDb();
  } catch {
    /* ignore */
  }
  process.exit(0);
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch((e) => {
    log.error({ err: e }, 'shutdown error');
    process.exit(1);
  });
});
process.on('SIGINT', () => {
  shutdown('SIGINT').catch((e) => {
    log.error({ err: e }, 'shutdown error');
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
