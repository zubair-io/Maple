/**
 * Stage controller runtime.
 *
 * Imported by every stage child process (via the entry shim main.ts).
 * Handles: boot, version-bump reset, poll loop, worker pool, atomic writeback,
 * throughput rolling window, pause/resume, reload-config, and graceful drain on SIGTERM.
 *
 * This file is built incrementally across Tasks 4–8 of the plan.
 */

import type { Collection, Filter, ObjectId } from "mongodb";
import { child as childLogger } from "../../log.ts";
import type { WorkerConfig } from "./define-stage.ts";
import type { ImageDoc, StageConfig } from "./define-stage.ts";
import type { WorkerConfigDoc } from "../worker-config.repo.ts";
import { WorkerConfigRepo } from "../worker-config.repo.ts";

// ---------------------------------------------------------------------------
// Boot: load or seed worker_config for this stage.
// ---------------------------------------------------------------------------

/**
 * Load the saved config for this stage from the worker_config collection.
 * If no document exists (first boot), seed from stage.defaults respecting
 * pausedOnFirstBoot. Returns the effective WorkerConfig.
 *
 * On re-boot, the saved document wins over defaults — operator changes persist.
 */
export async function bootConfig(
  stage: StageConfig,
  coll: Collection<WorkerConfigDoc>,
): Promise<WorkerConfig> {
  const repo = new WorkerConfigRepo(coll);
  const existing = await repo.load(stage.name);
  if (existing) return existing;

  // First boot: seed from defaults, respecting pausedOnFirstBoot.
  const initial: WorkerConfig = {
    concurrency: stage.defaults.concurrency,
    pollIntervalMs: stage.defaults.pollIntervalMs,
    batchSize: stage.defaults.batchSize,
    maxAttempts: stage.defaults.maxAttempts,
    paused: stage.defaults.pausedOnFirstBoot,
    last_seen_target_version: 0,
  };
  await repo.upsert(stage.name, initial);
  return initial;
}

// ---------------------------------------------------------------------------
// Version-bump reset: re-queue dead docs when targetVersion was bumped.
// ---------------------------------------------------------------------------

/**
 * If stage.targetVersion > lastSeenVersion, run an updateMany that resets
 * all docs at a lower version (including previously dead ones) so they become
 * eligible for the new version's claim query.
 *
 * Idempotent: if the API crashes between the updateMany and the config write,
 * the reset will run again on the next boot — harmless because the predicate
 * only matches docs whose version < targetVersion.
 */
export async function versionBumpReset(
  stage: StageConfig,
  lastSeenVersion: number,
  images: Collection<ImageDoc>,
): Promise<void> {
  if (stage.targetVersion <= lastSeenVersion) return;

  const stageKey = `stages.${stage.name}`;
  await images.updateMany(
    { [`${stageKey}.version`]: { $lt: stage.targetVersion } },
    {
      $set: {
        [`${stageKey}.dead`]: false,
        [`${stageKey}.attempts`]: 0,
        [`${stageKey}.last_error`]: null,
      },
    },
  );
}

// ---------------------------------------------------------------------------
// Claim query construction.
// ---------------------------------------------------------------------------

/**
 * Build the MongoDB filter that selects docs eligible for this stage:
 *   - stages.<name>.version < targetVersion OR stages.<name>.version is missing
 *   - stages.<name>.dead != true
 *   - For each dep: stages.<dep>.version >= dep.minVersion
 *   - _id not in the current in-flight set
 */
export function buildClaimQuery(
  name: string,
  targetVersion: number,
  dependsOn: Array<{ name: string; minVersion: number }>,
  inFlight: Set<ObjectId>,
): Filter<ImageDoc> {
  const filter: Filter<ImageDoc> = {
    $or: [
      { [`stages.${name}.version`]: { $lt: targetVersion } },
      { [`stages.${name}.version`]: { $exists: false } },
    ],
    [`stages.${name}.dead`]: { $ne: true },
  };
  for (const dep of dependsOn) {
    (filter as Record<string, unknown>)[`stages.${dep.name}.version`] = { $gte: dep.minVersion };
  }
  if (inFlight.size > 0) {
    (filter as Record<string, unknown>)["_id"] = {
      $nin: [...inFlight],
    };
  }
  return filter;
}

// ---------------------------------------------------------------------------
// Promise pool helper — limits concurrency to at most `limit` in-flight.
// ---------------------------------------------------------------------------

async function dispatchPool<T>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers: Promise<void>[] = [];
  const concurrency = Math.max(1, Math.min(limit, queue.length));
  for (let i = 0; i < concurrency; i++) {
    workers.push(
      (async () => {
        while (queue.length > 0) {
          const item = queue.shift();
          if (item === undefined) return;
          await run(item);
        }
      })(),
    );
  }
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// Single poll tick: claim + dispatch + writeback.
// ---------------------------------------------------------------------------

/**
 * Run one poll tick: find eligible docs, dispatch each to the handler,
 * write back results. Used by the full poll loop and directly from tests.
 *
 * `resolvedDeps` carries each dependency's name and the minimum version it
 * must have reached before this stage may process a doc. Defaults to
 * `{ name, minVersion: 1 }` for each entry in `stage.dependsOn` so callers
 * that don't yet pass manifest-resolved versions get the previous behaviour.
 *
 * `signal` is the runStage AbortController's signal so handlers can observe
 * shutdown. Defaults to a new never-aborted signal for test calls.
 *
 * `inFlightSet` and `throughput` are threaded in from runStage so the IPC
 * /status endpoint sees live counts. In tests they default to no-ops.
 */
export async function runOnce(
  stage: StageConfig,
  config: WorkerConfig,
  images: Collection<ImageDoc>,
  _configColl: Collection<WorkerConfigDoc>,
  resolvedDeps: Array<{ name: string; minVersion: number }> = stage.dependsOn.map((n) => ({ name: n, minVersion: 1 })),
  signal?: AbortSignal,
  inFlightSet?: Set<string>,
  throughput?: ThroughputWindow,
): Promise<void> {
  if (config.paused) return;

  const log = childLogger(`workers:${stage.name}`);
  const effectiveSignal = signal ?? new AbortController().signal;
  const ctx = { log, signal: effectiveSignal };

  // Use an empty local set for the claim-query exclusion (per-tick overlap
  // avoidance). The runStage inFlightSet is for IPC reporting.
  const claimSet = new Set<ObjectId>();

  const query = buildClaimQuery(
    stage.name,
    stage.targetVersion,
    resolvedDeps,
    claimSet,
  );

  const docs = await images
    .find(query)
    .limit(config.batchSize)
    .toArray();

  await dispatchPool(docs, config.concurrency, async (doc) => {
    const id = (doc as { _id: ObjectId })._id;
    const idStr = String(id);
    inFlightSet?.add(idStr);
    try {
      const result = await stage.handler(doc, ctx);
      const stageState = {
        version: stage.targetVersion,
        attempts: 0,
        last_error: null,
        processed_at: new Date(),
        dead: false,
      };

      if ("patch" in result) {
        const forbiddenKeys = Object.keys(result.patch).filter((k) =>
          k.startsWith("stages."),
        );
        if (forbiddenKeys.length > 0) {
          throw new Error(
            `Handler returned patch with forbidden stage keys: ${forbiddenKeys.join(", ")}`,
          );
        }
        await images.updateOne(
          { _id: id },
          {
            $set: {
              [`stages.${stage.name}`]: stageState,
              ...result.patch,
            },
          },
        );
      } else if ("wrote" in result) {
        await images.updateOne(
          { _id: id },
          { $set: { [`stages.${stage.name}`]: stageState } },
        );
      } else if ("skip" in result) {
        await images.updateOne(
          { _id: id },
          {
            $set: {
              [`stages.${stage.name}`]: {
                ...stageState,
                last_error: `skip: ${result.skip}`,
              },
            },
          },
        );
      }
      throughput?.record(new Date());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const current = await images.findOne(
        { _id: id },
        { projection: { [`stages.${stage.name}`]: 1 } },
      );
      const currentAttempts =
        (current?.stages?.[stage.name]?.attempts ?? 0) + 1;
      const dead = currentAttempts >= config.maxAttempts;
      await images.updateOne(
        { _id: id },
        {
          $set: {
            [`stages.${stage.name}.attempts`]: currentAttempts,
            [`stages.${stage.name}.last_error`]: msg,
            [`stages.${stage.name}.dead`]: dead,
          },
        },
      );
    } finally {
      inFlightSet?.delete(idStr);
    }
  });
}

// ---------------------------------------------------------------------------
// ThroughputWindow — rolling 5-minute completion counter.
// ---------------------------------------------------------------------------

/**
 * Ring buffer of processed_at timestamps. Exposed by the IPC status endpoint.
 * `windowMs` defaults to 5 minutes (300_000 ms).
 */
export class ThroughputWindow {
  private timestamps: number[] = [];
  private readonly windowMs: number;

  constructor(windowMs: number = 300_000) {
    this.windowMs = windowMs;
  }

  /** Record a completion at the given time (typically the handler's processed_at). */
  record(processedAt: Date): void {
    this.timestamps.push(processedAt.getTime());
  }

  /**
   * Count completions within the rolling window ending at `nowMs`.
   * Evicts old entries as a side effect so the buffer stays bounded.
   */
  countInWindow(nowMs: number = Date.now()): number {
    const cutoff = nowMs - this.windowMs;
    this.timestamps = this.timestamps.filter((t) => t >= cutoff);
    return this.timestamps.length;
  }
}

// ---------------------------------------------------------------------------
// IpcServer — localhost HTTP server for supervisor ↔ child communication.
// ---------------------------------------------------------------------------

interface IpcServerOptions {
  name: string;
  throughput: ThroughputWindow;
  getInFlight: () => number;
  onPause?: () => Promise<void> | void;
  onResume?: () => Promise<void> | void;
  /**
   * Called when the supervisor sends POST /reload-config.
   * The implementation should re-read worker_config[name] from Mongo
   * and update the running config reference so the next poll tick uses
   * the new concurrency, pollIntervalMs, batchSize, maxAttempts, and paused.
   */
  onReloadConfig?: () => Promise<void>;
}

/**
 * Small HTTP server listening on 127.0.0.1 only. The supervisor discovers
 * the port by reading the child's stdout line "__MAPLE_IPC_PORT__=<port>".
 * Responds to:
 *   GET  /status         → { status, inFlight, throughput }
 *   POST /pause          → calls onPause callback (awaited)
 *   POST /resume         → calls onResume callback (awaited)
 *   POST /reload-config  → calls onReloadConfig callback (re-reads config from Mongo)
 */
export class IpcServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private readonly opts: IpcServerOptions;

  constructor(opts: IpcServerOptions) {
    this.opts = opts;
  }

  /** Start the server on an ephemeral port. Returns the port assigned. */
  async start(): Promise<number> {
    const opts = this.opts;
    const server = Bun.serve({
      port: 0, // OS assigns an ephemeral port
      hostname: "127.0.0.1",
      async fetch(req: Request): Promise<Response> {
        const url = new URL(req.url);
        if (req.method === "GET" && url.pathname === "/status") {
          return Response.json({
            status: "running",
            inFlight: opts.getInFlight(),
            throughput: opts.throughput.countInWindow(),
          });
        }
        if (req.method === "POST" && url.pathname === "/pause") {
          await opts.onPause?.();
          return Response.json({ ok: true });
        }
        if (req.method === "POST" && url.pathname === "/resume") {
          await opts.onResume?.();
          return Response.json({ ok: true });
        }
        if (req.method === "POST" && url.pathname === "/reload-config") {
          try {
            await opts.onReloadConfig?.();
          } catch {
            return Response.json({ ok: false, error: "reload failed" }, { status: 500 });
          }
          return Response.json({ ok: true });
        }
        return new Response("not found", { status: 404 });
      },
    });
    this.server = server;
    return server.port;
  }

  async stop(): Promise<void> {
    await this.server?.stop();
    this.server = null;
  }
}

// ---------------------------------------------------------------------------
// _test export — internal helpers exposed unconditionally for testing.
// Test-only export. Adds no runtime cost; production builds simply don't import it.
// ---------------------------------------------------------------------------

export const _test = { bootConfig, versionBumpReset, runOnce };

// ---------------------------------------------------------------------------
// runStage — full entry point.
// ---------------------------------------------------------------------------

/**
 * Main entry point called by the stage child's entry shim (main.ts).
 * Connects to Mongo, boots config, starts the IPC server, emits the port
 * signal, starts the poll loop, and handles SIGTERM for graceful drain.
 */
export async function runStage(stage: StageConfig): Promise<void> {
  const log = childLogger(`workers:${stage.name}`);
  const { getDb } = await import("../../db/client.ts");
  const db = await getDb();
  const images = db.collection<ImageDoc>("assets");
  const configCollRaw = db.collection<WorkerConfigDoc>("worker_config");

  // ── Boot ──────────────────────────────────────────────────────────────────
  let config = await bootConfig(stage, configCollRaw);
  log.info({ config }, `${stage.name} stage booted`);

  // ── Version-bump reset ────────────────────────────────────────────────────
  if (stage.targetVersion > config.last_seen_target_version) {
    log.info(
      { from: config.last_seen_target_version, to: stage.targetVersion },
      `${stage.name} version bump — resetting dead docs`,
    );
    await versionBumpReset(stage, config.last_seen_target_version, images);
    const repo = new WorkerConfigRepo(configCollRaw);
    await repo.patch(stage.name, {
      last_seen_target_version: stage.targetVersion,
    });
    config = { ...config, last_seen_target_version: stage.targetVersion };
  }

  const throughput = new ThroughputWindow();
  const inFlightSet = new Set<string>();

  // ── IPC server ────────────────────────────────────────────────────────────
  const repo = new WorkerConfigRepo(configCollRaw);

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  // Declare before IPC server + poll loop so the shutdown handler can
  // reference them without TDZ issues.
  let shuttingDown = false;
  const abortController = new AbortController();
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  const ipc = new IpcServer({
    name: stage.name,
    throughput,
    getInFlight: () => inFlightSet.size,
    onPause: async () => {
      await repo.patch(stage.name, { paused: true });
      config = { ...config, paused: true };
      log.info(`${stage.name} paused via IPC`);
    },
    onResume: async () => {
      await repo.patch(stage.name, { paused: false });
      config = { ...config, paused: false };
      log.info(`${stage.name} resumed via IPC`);
    },
    onReloadConfig: async () => {
      // Re-read the full config from Mongo — the supervisor called this after
      // the PATCH /api/workers/:name/config handler updated the DB.
      const updated = await repo.load(stage.name);
      if (updated) {
        config = updated;
        log.info({ config }, `${stage.name} config reloaded via IPC`);
      }
    },
  });

  const ipcPort = await ipc.start();
  // Signal the supervisor with the IPC port so it can send IPC commands.
  process.stdout.write(`__MAPLE_IPC_PORT__=${ipcPort}\n`);
  log.info({ ipcPort }, `${stage.name} IPC server started`);

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${stage.name} received SIGTERM — draining`);
    abortController.abort();
    if (pollTimer) clearTimeout(pollTimer);
    await ipc.stop().catch(() => {});
  };
  process.on("SIGTERM", () => { shutdown().catch(() => {}); });

  // ── Poll loop (self-scheduling setTimeout to avoid overlap and re-read
  //   pollIntervalMs every tick so reload-config takes effect) ───────────────
  const poll = async (): Promise<void> => {
    if (shuttingDown) return;
    if (!config.paused) {
      try {
        await runOnce(
          stage,
          config,
          images,
          configCollRaw,
          undefined,
          abortController.signal,
          inFlightSet,
          throughput,
        );
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err.message : err },
          `${stage.name} poll tick error`,
        );
      }
    }
    if (!shuttingDown) {
      pollTimer = setTimeout(poll, config.pollIntervalMs);
    }
  };

  pollTimer = setTimeout(poll, config.pollIntervalMs);

  // ── Drain on shutdown ─────────────────────────────────────────────────────
  await new Promise<void>((resolve) => {
    abortController.signal.addEventListener("abort", () => {
      const deadline = setTimeout(() => {
        log.warn(`${stage.name} drain timeout 30s — force exiting`);
        resolve();
      }, 30_000);
      if (inFlightSet.size === 0) {
        clearTimeout(deadline);
        resolve();
      }
    });
  });

  log.info(`${stage.name} shut down cleanly`);
  process.exit(0);
}
