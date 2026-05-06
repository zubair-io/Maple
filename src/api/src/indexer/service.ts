/**
 * Top-level indexer service.
 *
 * Owns:
 *   - the bounded-channel pipeline
 *   - the chokidar watcher (one per registered folder)
 *   - the per-folder checkpoint repo + resume logic
 *   - the periodic GC sweep for soft-deleted assets (30-day retention)
 *
 * Routes call into this singleton for status + config. The WS route
 * subscribes to its progress bus for live updates.
 */

import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as pathMod from "node:path";
import { ObjectId } from "mongodb";
import {
  Pipeline,
  type PipelineJob,
  type PipelineStatus,
} from "./pipeline.ts";
import type { PipelineHandlers } from "./pipeline.ts";
import { Watcher, type WatchEvent } from "./watcher.ts";
import { poolSizes, type Stage } from "./channel.ts";
import {
  readCheckpoint,
  writeCheckpoint,
  ensureCheckpointIndexes,
} from "./checkpoint.ts";
import { ensureIndexerIndexes } from "./indexer.repo.ts";
import { loadWorkerConfig, saveWorkerConfig } from "./indexer-config.repo.ts";
import * as images from "./images.repo.ts";
import { assetsCollection, foldersCollection } from "../db/client.ts";
import { cachePathFor } from "../fs/xmp.ts";
import { backfillAssetExif } from "./exif.ts";
import { generateThumb } from "./thumbnailer.ts";

export const SUPPORTED_EXTS = new Set([
  ".dng", ".cr2", ".cr3", ".nef", ".arw", ".raf", ".orf", ".rw2",
  ".pef", ".srw", ".x3f", ".3fr", ".mef", ".erf", ".mrw",
  ".jpg", ".jpeg", ".tif", ".tiff", ".heic", ".heif",
]);

/** Thirty-day GC retention for soft-deleted assets. */
const GC_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const GC_INTERVAL_MS = 60 * 60 * 1000; // once an hour

/** One-shot EXIF backfill cap (rows per startup). Override with MAPLE_EXIF_BACKFILL_LIMIT. */
const EXIF_BACKFILL_LIMIT_DEFAULT = 1000;

export type IndexerEvent =
  | {
      type: "progress";
      stage: Stage;
      queueDepth: number;
      inFlight: number;
      errors: number;
      deadLetter: number;
    }
  | {
      type: "fs";
      event: "created" | "modified" | "renamed" | "removed";
      path: string;
    };

export interface WorkerConfigPatch {
  hash?: number;
  exif?: number;
  thumb?: number;
  mongo?: number;
  discover?: number;
  ai?: number;
}

export class IndexerService {
  readonly pipeline: Pipeline;
  readonly events: EventEmitter = new EventEmitter();

  private watchers: Map<string, Watcher> = new Map(); // folderId -> Watcher
  private progressTimer: ReturnType<typeof setInterval> | null = null;
  private gcTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(handlers: PipelineHandlers = {}) {
    this.events.setMaxListeners(200);
    this.pipeline = new Pipeline(undefined, poolSizes(), handlers);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    try {
      await ensureCheckpointIndexes();
      await ensureIndexerIndexes();
    } catch (e) {
      console.warn(
        "[indexer] could not ensure indexes (DB offline?):",
        e instanceof Error ? e.message : e
      );
    }

    // One-shot backfill: upgrade existing rows that pre-date EXIF support.
    // OPT-IN at startup via `MAPLE_EXIF_BACKFILL_ON_START=1`. The default is
    // OFF because on a real-world library (thousands of un-EXIF'd assets)
    // the inline `exifr.parse(absPath)` loop pegs the event loop hard
    // enough at boot that incoming HTTP requests time out — even on
    // /api/health, before the user can sign in. The same logic is exposed
    // as a manual "Reindex EXIF" button on /settings/indexer (POST
    // /api/indexer/exif-backfill) so the user can run it on demand
    // without blocking sign-in.
    if (process.env.MAPLE_EXIF_BACKFILL_ON_START === "1") {
      this.runExifBackfill().catch((e) =>
        console.warn(
          "[indexer] EXIF backfill error:",
          e instanceof Error ? e.message : e
        )
      );
    }

    this.pipeline.start();

    // Re-apply persisted worker pool sizes from a previous tuning session.
    try {
      const saved = await loadWorkerConfig();
      if (saved) {
        for (const [stage, count] of Object.entries(saved)) {
          if (count !== undefined) this.pipeline.setPool(stage as Stage, count);
        }
        console.log(`[indexer] restored worker config: ${JSON.stringify(saved)}`);
      }
    } catch (e) {
      console.warn(
        "[indexer] failed to load worker config:",
        e instanceof Error ? e.message : e
      );
    }

    // Kick off watchers + resume per folder.
    try {
      const folders = await foldersCollection();
      const docs = await folders.find({}).toArray();
      for (const f of docs) {
        await this.watchFolder(f._id.toHexString(), f.path);
      }
    } catch (e) {
      console.warn(
        "[indexer] skipping watcher setup (DB offline?):",
        e instanceof Error ? e.message : e
      );
    }

    // Throttled progress broadcast every 250 ms.
    this.progressTimer = setInterval(() => this.broadcastProgress(), 250);
    // GC sweep once an hour.
    this.gcTimer = setInterval(() => {
      this.runGc().catch((e) =>
        console.warn("[indexer] GC sweep error:", e instanceof Error ? e.message : e)
      );
    }, GC_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.progressTimer) clearInterval(this.progressTimer);
    if (this.gcTimer) clearInterval(this.gcTimer);
    this.progressTimer = null;
    this.gcTimer = null;
    for (const w of this.watchers.values()) await w.close();
    this.watchers.clear();
    await this.pipeline.stop();
  }

  status(): PipelineStatus & {
    started: boolean;
    folders: number;
    exifBackfill: ReturnType<IndexerService["exifBackfillStatus"]>;
  } {
    return {
      ...this.pipeline.status(),
      started: this.started,
      folders: this.watchers.size,
      exifBackfill: this.exifBackfillStatus(),
    };
  }

  pause(): void {
    this.pipeline.pause();
  }

  resume(): void {
    this.pipeline.resume();
  }

  async setConfig(patch: WorkerConfigPatch): Promise<void> {
    const stages: Array<keyof WorkerConfigPatch> = [
      "discover", "hash", "exif", "thumb", "ai", "mongo",
    ];
    const applied: WorkerConfigPatch = {};
    for (const s of stages) {
      const v = patch[s];
      if (v !== undefined) {
        this.pipeline.setPool(s as Stage, v);
        applied[s] = v;
      }
    }
    try {
      await saveWorkerConfig(applied);
    } catch (e) {
      console.warn(
        "[indexer] failed to persist worker config:",
        e instanceof Error ? e.message : e
      );
    }
  }

  /** Start watching a folder. Resumes inflight jobs + walks if needed. */
  async watchFolder(folderId: string, folderPath: string): Promise<void> {
    if (this.watchers.has(folderId)) return;

    // Resume step: re-enqueue inflight ids and walk if folder has changed.
    try {
      const cp = await readCheckpoint(folderId);
      for (const mapleId of cp?.inflightIds ?? []) {
        const asset = await images.findByMapleId(mapleId);
        if (asset) {
          await this.pipeline.channels.discover.push({
            kind: "index",
            folderId,
            absPath: asset.abs_path,
          });
        }
      }

      let needsWalk = true;
      if (cp) {
        try {
          const stat = await fs.stat(folderPath);
          needsWalk = stat.mtimeMs > cp.lastWalkedAt;
        } catch {
          needsWalk = true;
        }
      }
      console.log(`[indexer] watch ${folderPath}: walk=${needsWalk}`);
      if (needsWalk) {
        const enqueued = await this.walkOnce(folderId, folderPath);
        console.log(`[indexer] walk ${folderPath}: enqueued ${enqueued} files`);
        await writeCheckpoint({
          folderId,
          path: folderPath,
          lastWalkedAt: Date.now(),
          inflightIds: [],
          updatedAt: Date.now(),
        });
      }
    } catch (e) {
      console.warn(
        "[indexer] checkpoint resume failed:",
        e instanceof Error ? e.message : e
      );
    }

    const w = new Watcher({
      roots: [folderPath],
      include: SUPPORTED_EXTS,
      onEvent: (ev) => this.handleFsEvent(folderId, ev),
    });
    this.watchers.set(folderId, w);
  }

  /** Walk a folder once, enqueueing every supported file into discover. */
  async walkOnce(folderId: string, folderPath: string): Promise<number> {
    let count = 0;
    const walk = async (dir: string): Promise<void> => {
      let entries: string[];
      try {
        entries = await fs.readdir(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        if (name.startsWith(".")) continue;
        const abs = pathMod.join(dir, name);
        let stat;
        try {
          stat = await fs.stat(abs);
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          await walk(abs);
          continue;
        }
        if (!stat.isFile()) continue;
        if (!SUPPORTED_EXTS.has(pathMod.extname(name).toLowerCase())) continue;
        await this.pipeline.channels.discover.push({
          kind: "index",
          folderId,
          absPath: abs,
        });
        count++;
      }
    };
    await walk(folderPath);
    return count;
  }

  /** Stop watching one folder (used on folder removal). */
  async unwatchFolder(folderId: string): Promise<void> {
    const w = this.watchers.get(folderId);
    if (!w) return;
    await w.close();
    this.watchers.delete(folderId);
  }

  // ---- Private helpers -----------------------------------------------------

  private async handleFsEvent(folderId: string, ev: WatchEvent): Promise<void> {
    this.events.emit("event", {
      type: "fs",
      event: ev.kind,
      path: ev.absPath,
    } satisfies IndexerEvent);

    const job: PipelineJob = (() => {
      if (ev.kind === "removed") {
        return { kind: "remove", folderId, absPath: ev.absPath };
      }
      if (ev.kind === "renamed") {
        return {
          kind: "rename",
          folderId,
          absPath: ev.absPath,
          fromPath: ev.fromPath,
        };
      }
      return { kind: "index", folderId, absPath: ev.absPath };
    })();

    // Modified: short-circuit if mtime + sha1Head haven't changed.
    if (ev.kind === "modified") {
      const existing = await images.findByAbsPath(ev.absPath);
      if (existing) {
        try {
          const stat = await fs.stat(ev.absPath);
          if (existing.mtime === stat.mtimeMs) return;
        } catch {
          // fall through to re-index
        }
      }
    }

    // For rename, look up the maple:id by old path so we can preserve it.
    if (ev.kind === "renamed" && ev.fromPath) {
      const existing = await images.findByAbsPath(ev.fromPath);
      if (existing && existing.maple_id) {
        job.mapleId = existing.maple_id;
      }
    }

    try {
      await this.pipeline.channels.discover.push(job);
    } catch (e) {
      console.warn(
        "[indexer] failed to enqueue job:",
        e instanceof Error ? e.message : e
      );
    }
  }

  private broadcastProgress(): void {
    const s = this.pipeline.status();
    const stages: Stage[] = ["discover", "hash", "exif", "thumb", "ai", "mongo"];
    for (const st of stages) {
      this.events.emit("event", {
        type: "progress",
        stage: st,
        queueDepth: s.channels[st].depth,
        inFlight: s.stages[st].inFlight,
        errors: s.stages[st].errors,
        deadLetter: s.stages[st].deadLetter,
      } satisfies IndexerEvent);
    }
  }

  /**
   * Test hook: run one GC sweep synchronously. Exposed for `indexer-gc.test.ts`;
   * in production the hourly timer drives this.
   */
  async runGcSweep(): Promise<void> {
    return this.runGc();
  }

  /**
   * One-shot EXIF backfill. Finds rows with no `exif` field (i.e. indexed
   * before EXIF support landed) and re-runs the parser inline. Bounded at
   * `MAPLE_EXIF_BACKFILL_LIMIT` (default 1000) per startup so a million-row
   * library does not block boot.
   *
   * Returns the number of rows successfully upgraded.
   */
  /** Live progress so the indexer settings page can render a meter while
   * a backfill run is in flight. Snapshot is included in `status()`. */
  private backfillProgress: {
    running: boolean;
    scanned: number;
    upgraded: number;
    /** Estimated remaining (`assets where exif missing`) at the start of the
     * run; not refreshed continuously. -1 if not yet measured. */
    pending: number;
    /** ISO timestamp of last completion, or null if never run. */
    lastFinishedAt: string | null;
    /** Why the most recent run stopped, if any. */
    lastError: string | null;
  } = {
    running: false,
    scanned: 0,
    upgraded: 0,
    pending: -1,
    lastFinishedAt: null,
    lastError: null,
  };

  /** Snapshot for the status route — copy so callers can't mutate ours. */
  exifBackfillStatus(): typeof this.backfillProgress {
    return { ...this.backfillProgress };
  }

  async runExifBackfill(limitOverride?: number): Promise<number> {
    if (this.backfillProgress.running) {
      // Don't double-run; return whatever the previous run upgraded.
      return this.backfillProgress.upgraded;
    }
    const limit = Math.max(
      0,
      limitOverride ??
        Number(process.env.MAPLE_EXIF_BACKFILL_LIMIT ?? EXIF_BACKFILL_LIMIT_DEFAULT)
    );
    if (limit === 0) return 0;

    let coll;
    try {
      coll = await assetsCollection();
    } catch {
      return 0;
    }

    this.backfillProgress = {
      running: true,
      scanned: 0,
      upgraded: 0,
      pending: -1,
      lastFinishedAt: null,
      lastError: null,
    };
    // Best-effort initial pending count so the UI can render a sensible
    // meter. Bounded to avoid pegging mongo on huge collections.
    try {
      this.backfillProgress.pending = await coll.countDocuments(
        { exif: { $exists: false } },
        { limit: 1_000_000 }
      );
    } catch {
      this.backfillProgress.pending = -1;
    }

    const cursor = coll
      .find(
        { exif: { $exists: false } },
        { projection: { abs_path: 1 } }
      )
      .limit(limit);

    try {
      for await (const doc of cursor) {
        this.backfillProgress.scanned++;
        try {
          const ok = await backfillAssetExif(doc.abs_path);
          if (ok) this.backfillProgress.upgraded++;
        } catch (e) {
          console.warn(
            "[indexer] backfill failed for",
            doc.abs_path,
            e instanceof Error ? e.message : e
          );
        }
        if (
          this.backfillProgress.upgraded > 0 &&
          this.backfillProgress.upgraded % 100 === 0
        ) {
          console.log(
            `[indexer] EXIF backfill progress: ${this.backfillProgress.upgraded}/${this.backfillProgress.scanned} upgraded (limit ${limit})`
          );
        }
        // Yield to the event loop between rows so an in-flight HTTP request
        // gets a tick. exifr.parse already awaits I/O, but the rapid burst
        // of awaits without a setImmediate keeps node's macrotask queue at
        // the bottom — health checks and bootstrap can timeout otherwise.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (this.backfillProgress.scanned > 0) {
        console.log(
          `[indexer] EXIF backfill done: ${this.backfillProgress.upgraded}/${this.backfillProgress.scanned} rows upgraded`
        );
      }
    } catch (e) {
      this.backfillProgress.lastError = e instanceof Error ? e.message : String(e);
    } finally {
      this.backfillProgress.running = false;
      this.backfillProgress.lastFinishedAt = new Date().toISOString();
    }
    return this.backfillProgress.upgraded;
  }

  /**
   * Unlink derived-cache artefacts (.maple/thumbs + .maple/previews) for an
   * asset. Best-effort: ENOENT is swallowed, other errors are logged at warn.
   * If the containing folder is unreachable (mounted volume offline) we log
   * and skip — the row is already gone, and stranding one file beats blocking
   * the sweep on a single bad folder.
   *
   * Exported as a method so both the GC sweep and the rename handler can
   * reuse it (rename: stale files at the old path).
   */
  async unlinkAssetCache(id: string, assetAbsPath: string): Promise<void> {
    try {
      await fs.access(pathMod.dirname(assetAbsPath));
    } catch (e) {
      console.warn(
        JSON.stringify({
          stage: "gc",
          id,
          absPath: assetAbsPath,
          action: "gc-unreachable",
          error: e instanceof Error ? e.message : String(e),
        })
      );
      return;
    }
    for (const kind of ["thumbs", "previews"] as const) {
      const file = cachePathFor(assetAbsPath, kind);
      try {
        await fs.unlink(file);
        console.log(
          JSON.stringify({ stage: "gc", id, file, action: "gc-unlink" })
        );
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ENOENT") continue; // already gone
        console.warn(
          JSON.stringify({
            stage: "gc",
            id,
            file,
            action: "gc-unlink-failed",
            error: e instanceof Error ? e.message : String(e),
          })
        );
      }
    }
  }

  private async runGc(): Promise<void> {
    const cutoffIso = new Date(Date.now() - GC_RETENTION_MS).toISOString();
    const expired = await images.listExpiredDeletions(cutoffIso);
    for (const doc of expired) {
      if (!doc.maple_id) continue;
      await images.hardDelete(doc.maple_id);
      await this.unlinkAssetCache(doc.maple_id, doc.abs_path);
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance: IndexerService | null = null;

export function getIndexerService(): IndexerService {
  if (!_instance) {
    _instance = new IndexerService({
      generateThumb: (job) => generateThumb(job.absPath),
    });
    console.log("[indexer] singleton constructed — handlers wired: generateThumb");
  }
  return _instance;
}

/**
 * For tests: substitute a fresh service with handler overrides. Returns the
 * new instance. The caller is responsible for `stop()`ing the previous one.
 */
export function _replaceIndexerServiceForTests(svc: IndexerService): void {
  _instance = svc;
}

/**
 * Enqueue a discover job by folder+path. Used by the folders POST route so
 * existing callers can keep working while the watcher boots up in the bg.
 */
export async function enqueueIndex(folderId: string, absPath: string): Promise<void> {
  const svc = getIndexerService();
  await svc.pipeline.channels.discover.push({
    kind: "index",
    folderId,
    absPath,
  });
}

/** Folder-level scan kickoff: walks everything once via the service. */
export async function scanFolder(folderId: string, folderPath: string): Promise<number> {
  const svc = getIndexerService();
  return svc.walkOnce(folderId, folderPath);
}

/** Used by folders route after a new folder is registered. */
export async function registerFolderWatch(folderId: string, folderPath: string): Promise<void> {
  const svc = getIndexerService();
  await svc.watchFolder(folderId, folderPath);
}

/** Lazy helper for tests + callers that need a fresh ObjectId-friendly id. */
export function asObjectId(hex: string): ObjectId {
  return new ObjectId(hex);
}
