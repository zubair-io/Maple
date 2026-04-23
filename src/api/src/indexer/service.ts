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
import * as images from "./images.repo.ts";
import { foldersCollection } from "../db/client.ts";

export const SUPPORTED_EXTS = new Set([
  ".dng", ".cr2", ".cr3", ".nef", ".arw", ".raf", ".orf", ".rw2",
  ".pef", ".srw", ".x3f", ".3fr", ".mef", ".erf", ".mrw",
  ".jpg", ".jpeg", ".tif", ".tiff", ".heic", ".heif",
]);

/** Thirty-day GC retention for soft-deleted assets. */
const GC_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const GC_INTERVAL_MS = 60 * 60 * 1000; // once an hour

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

    this.pipeline.start();

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

  status(): PipelineStatus & { started: boolean; folders: number } {
    return {
      ...this.pipeline.status(),
      started: this.started,
      folders: this.watchers.size,
    };
  }

  setConfig(patch: WorkerConfigPatch): void {
    const stages: Array<keyof WorkerConfigPatch> = [
      "discover", "hash", "exif", "thumb", "ai", "mongo",
    ];
    for (const s of stages) {
      const v = patch[s];
      if (v !== undefined) this.pipeline.setPool(s as Stage, v);
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
      if (needsWalk) {
        await this.walkOnce(folderId, folderPath);
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

  private async runGc(): Promise<void> {
    const cutoffIso = new Date(Date.now() - GC_RETENTION_MS).toISOString();
    const expired = await images.listExpiredDeletions(cutoffIso);
    for (const doc of expired) {
      // TODO(T7-gc): sweep .maple/thumbs + .maple/previews files for this id.
      if (doc.maple_id) {
        await images.hardDelete(doc.maple_id);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance: IndexerService | null = null;

export function getIndexerService(): IndexerService {
  if (!_instance) _instance = new IndexerService();
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
