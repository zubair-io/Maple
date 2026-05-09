/**
 * Indexer pipeline — stages wired with bounded channels.
 *
 *   discover -> hash -> exif -> thumb -> ai -> mongo
 *
 * Each stage is an `async` worker pool that reads from one channel and
 * writes to the next. Errors are retried with exponential backoff up to
 * `MAX_ATTEMPTS`; after that the job moves to the dead-letter collection.
 *
 * The pipeline is deliberately small and side-effect-friendly: the
 * `IndexerService` owns the channels and wires the workers. Tests can
 * construct a pipeline with their own channels and mock handlers.
 */

import * as fs from "node:fs/promises";
import * as pathMod from "node:path";
import { ObjectId } from "mongodb";
import {
  createBoundedQueue,
  CHANNEL_CAPACITY,
  poolSizes,
  type BoundedQueue,
  type Stage,
} from "./channel.ts";
import { deriveId } from "./id.ts";
import { sha1 } from "@noble/hashes/legacy.js";
import * as images from "./images.repo.ts";
import { recordDeadLetter } from "./indexer.repo.ts";
import { cachePathFor } from "../fs/xmp.ts";
import { child as childLogger } from "../log.ts";
import type { AssetExif } from "../db/schema.ts";
import { resolve as resolveHandler } from "../handler-registry/registry.ts";
import { dispatchAi } from "../handler-registry/http-transport.ts";
import { CONTRACT_VERSION } from "../handler-registry/contract.ts";

const log = childLogger("indexer:pipeline");

export type JobKind = "index" | "remove" | "rename";

/** A single unit moving through the pipeline. */
export interface PipelineJob {
  kind: JobKind;
  folderId: string;
  absPath: string;
  /** Populated at the `hash` stage (fallback form) and finalised at the `exif` stage. */
  mapleId?: string;
  sha1Head?: string;
  size?: number;
  mtime?: number;
  /**
   * First 64 KB of the file. Set at the `hash` stage so the `exif` stage can
   * re-derive a primary-form `mapleId` once `capturedAt` is parsed. Cleared
   * once exif has run to avoid holding buffers through the rest of the pipeline.
   */
  headBytes?: Uint8Array;
  /**
   * Parsed capture timestamp (EXIF DateTimeOriginal, spec format). When present,
   * the exif stage re-derives `mapleId` as the primary form (tag byte 0x01).
   */
  capturedAt?: string | null;
  /** Camera body serial, if present in EXIF. Feeds primary-id derivation. */
  cameraSerial?: string | null;
  /** Shutter count at capture, if present. Feeds primary-id derivation. */
  shutterCount?: bigint | number | null;
  /** Structured face detections produced by the `ai` stage. Empty today. */
  faces?: AiFace[];
  /** Text tags produced by the `ai` stage. Empty today. */
  aiTags?: string[];
  /**
   * EXIF subdocument extracted at the exif stage (camera/lens/exposure/GPS).
   * The exif stage's default handler populates this from `exifr`. The mongo
   * stage's default upsert passes it through to the asset doc. Stays
   * `undefined` if exif has not run yet; becomes `null` on parse failure.
   */
  exif?: AssetExif | null;
  /** Present only for rename jobs. */
  fromPath?: string;
  /**
   * Skip the thumb stage's `generateThumb` handler call. Used by the
   * browse-triggered enqueue path: `/api/fs/thumb` already renders thumbs
   * lazily on demand, so re-doing the work in the indexer would just waste
   * the FFI worker pool. The thumb stage still runs (the job moves on to
   * `ai`) — only the side-effect is skipped.
   */
  skipThumb?: boolean;
}

/** Face detection output from the ai stage. Shape is frozen so future ONNX wiring is additive only. */
export interface AiFace {
  /** Bounding box in normalised [0..1] image coordinates. */
  bbox: { x: number; y: number; w: number; h: number };
  /** Optional linked person id (MongoDB ObjectId hex) — null until reviewer confirms. */
  personId: string | null;
  /** Detector confidence in [0..1]. */
  confidence: number;
  /** MobileFaceNet 512-D embedding. Omitted for pass-through today. */
  embedding?: Float32Array;
}

export interface StageCounters {
  inFlight: number;
  errors: number;
  deadLetter: number;
}

export interface PipelineHandlers {
  /** Override: load first 64 KB of a file. Defaults to fs.read. */
  readHead?: (absPath: string) => Promise<Uint8Array>;
  /** Override: read exif. Default no-op. */
  readExif?: (job: PipelineJob) => Promise<void>;
  /** Override: generate thumb + preview. Default no-op. */
  generateThumb?: (job: PipelineJob) => Promise<void>;
  /** Override: run AI stub. */
  runAi?: (job: PipelineJob) => Promise<void>;
  /** Override: mongo upsert. Default calls images.upsertByMapleId. */
  upsertMongo?: (job: PipelineJob) => Promise<void>;
}

const MAX_ATTEMPTS = 3;

async function defaultReadHead(absPath: string): Promise<Uint8Array> {
  const fd = await fs.open(absPath, "r");
  try {
    const buf = new Uint8Array(64 * 1024);
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fd.close();
  }
}

async function defaultUpsert(job: PipelineJob): Promise<void> {
  if (!job.mapleId || !job.sha1Head || job.size === undefined || job.mtime === undefined) {
    throw new Error("[pipeline] mongo stage missing fields");
  }
  // Phase 1 skeleton upsert: the fast tier writes only fast-tier fields. The
  // enrichment outputs (`faces`, `place`, `description`) are seeded on insert
  // by `upsertByMapleId` and only ever written by Phase 2+ workers afterwards.
  // `job.faces` / `job.aiTags` remain on the PipelineJob shape (Phase 2's diff
  // is cleaner with them in place) but are no longer persisted from this stage.
  await images.upsertByMapleId({
    folderId: new ObjectId(job.folderId),
    filename: pathMod.basename(job.absPath),
    absPath: job.absPath,
    size: job.size,
    mtime: job.mtime,
    mapleId: job.mapleId,
    sha1Head: job.sha1Head,
    // exif may be undefined (handler unwired in tests) or null (parse failure).
    // Pass the exact value through so the upsert can decide whether to write it.
    exif: job.exif,
  });
}

/**
 * Default exif handler used by the IndexerService at runtime: parses EXIF and
 * sets `job.exif`, plus `job.capturedAt` so the maple:id can upgrade to the
 * primary form. Tests typically supply their own readExif handler and skip
 * this entirely.
 */
async function defaultReadExif(job: PipelineJob): Promise<void> {
  const { readExif } = await import("./exif.ts");
  const exif = await readExif(job.absPath);
  job.exif = exif;
  if (exif?.captured_at) {
    job.capturedAt = exif.captured_at;
  }
}

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, "0");
  return s;
}

export interface PipelineChannels {
  discover: BoundedQueue<PipelineJob>;
  hash: BoundedQueue<PipelineJob>;
  exif: BoundedQueue<PipelineJob>;
  thumb: BoundedQueue<PipelineJob>;
  ai: BoundedQueue<PipelineJob>;
  mongo: BoundedQueue<PipelineJob>;
}

export function createChannels(): PipelineChannels {
  return {
    discover: createBoundedQueue<PipelineJob>(CHANNEL_CAPACITY.discover),
    hash: createBoundedQueue<PipelineJob>(CHANNEL_CAPACITY.hash),
    exif: createBoundedQueue<PipelineJob>(CHANNEL_CAPACITY.exif),
    thumb: createBoundedQueue<PipelineJob>(CHANNEL_CAPACITY.thumb),
    ai: createBoundedQueue<PipelineJob>(CHANNEL_CAPACITY.ai),
    mongo: createBoundedQueue<PipelineJob>(CHANNEL_CAPACITY.mongo),
  };
}

/** Public status snapshot — matches what the status route returns. */
export interface PipelineStatus {
  channels: Record<Stage, { depth: number; capacity: number }>;
  stages: Record<Stage, StageCounters>;
  pools: Record<Stage, number>;
  paused: boolean;
  /** Currently-processing file paths per stage (snapshot). Capped per stage
   * to keep status payloads small even when the indexer is under heavy load. */
  inFlightPaths: Record<Stage, string[]>;
  /** Cumulative count of jobs that have completed (success or fail) per
   * stage since the server started. Resets on process restart — not
   * persisted to Mongo. */
  processed: Record<Stage, number>;
}

export class Pipeline {
  readonly channels: PipelineChannels;
  readonly counters: Record<Stage, StageCounters> = {
    discover: { inFlight: 0, errors: 0, deadLetter: 0 },
    hash: { inFlight: 0, errors: 0, deadLetter: 0 },
    exif: { inFlight: 0, errors: 0, deadLetter: 0 },
    thumb: { inFlight: 0, errors: 0, deadLetter: 0 },
    ai: { inFlight: 0, errors: 0, deadLetter: 0 },
    mongo: { inFlight: 0, errors: 0, deadLetter: 0 },
  };

  /** Currently-processing absolute paths per stage. Sets so `delete` is O(1)
   * when a worker finishes; the status snapshot iterates and slices to a cap. */
  private readonly inFlight: Record<Stage, Set<string>> = {
    discover: new Set(), hash: new Set(), exif: new Set(),
    thumb: new Set(), ai: new Set(), mongo: new Set(),
  };
  /** Cumulative completed count per stage (success + fail). Process-local. */
  private readonly processedCounts: Record<Stage, number> = {
    discover: 0, hash: 0, exif: 0, thumb: 0, ai: 0, mongo: 0,
  };
  /** Cap on the in-flight path list returned by `status()` per stage. The
   * pool size never exceeds this in practice, so the cap is just a guard. */
  private static readonly INFLIGHT_PATHS_CAP = 64;

  private pools: Record<Stage, number>;
  private workers: Map<Stage, Promise<void>[]> = new Map();
  private running = false;
  private paused = false;
  private gate: Promise<void> = Promise.resolve();
  private gateResolver: () => void = () => {};

  constructor(
    channels: PipelineChannels | undefined = undefined,
    pools: Record<Stage, number> | undefined = undefined,
    private readonly handlers: PipelineHandlers = {}
  ) {
    this.channels = channels ?? createChannels();
    this.pools = pools ?? poolSizes();
  }

  status(): PipelineStatus {
    const channels: PipelineStatus["channels"] = {
      discover: { depth: this.channels.discover.depth, capacity: this.channels.discover.capacity },
      hash: { depth: this.channels.hash.depth, capacity: this.channels.hash.capacity },
      exif: { depth: this.channels.exif.depth, capacity: this.channels.exif.capacity },
      thumb: { depth: this.channels.thumb.depth, capacity: this.channels.thumb.capacity },
      ai: { depth: this.channels.ai.depth, capacity: this.channels.ai.capacity },
      mongo: { depth: this.channels.mongo.depth, capacity: this.channels.mongo.capacity },
    };
    const cap = Pipeline.INFLIGHT_PATHS_CAP;
    const snap = (s: Stage): string[] => {
      const arr: string[] = [];
      for (const p of this.inFlight[s]) {
        if (arr.length >= cap) break;
        arr.push(p);
      }
      return arr;
    };
    return {
      channels,
      stages: {
        discover: { ...this.counters.discover },
        hash: { ...this.counters.hash },
        exif: { ...this.counters.exif },
        thumb: { ...this.counters.thumb },
        ai: { ...this.counters.ai },
        mongo: { ...this.counters.mongo },
      },
      pools: { ...this.pools },
      paused: this.paused,
      inFlightPaths: {
        discover: snap("discover"),
        hash: snap("hash"),
        exif: snap("exif"),
        thumb: snap("thumb"),
        ai: snap("ai"),
        mongo: snap("mongo"),
      },
      processed: { ...this.processedCounts },
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.spawnStage("discover", (job) => this.runDiscover(job));
    this.spawnStage("hash", (job) => this.runHash(job));
    this.spawnStage("exif", (job) => this.runExif(job));
    this.spawnStage("thumb", (job) => this.runThumb(job));
    this.spawnStage("ai", (job) => this.runAi(job));
    this.spawnStage("mongo", (job) => this.runMongo(job));
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.channels.discover.close();
    this.channels.hash.close();
    this.channels.exif.close();
    this.channels.thumb.close();
    this.channels.ai.close();
    this.channels.mongo.close();
    const all: Promise<void>[] = [];
    for (const arr of this.workers.values()) all.push(...arr);
    await Promise.allSettled(all);
    this.workers.clear();
  }

  /** Live resize of one stage's worker pool. Grows only (shrinking is natural as workers drain). */
  setPool(stage: Stage, size: number): void {
    const clamped = Math.max(1, Math.floor(size));
    const cur = this.pools[stage];
    this.pools[stage] = clamped;
    if (!this.running) return;
    for (let i = cur; i < clamped; i++) {
      this.spawnOne(stage);
    }
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.gate = new Promise<void>((resolve) => {
      this.gateResolver = resolve;
    });
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.gateResolver();
    this.gate = Promise.resolve();
  }

  private spawnStage(stage: Stage, handler: (job: PipelineJob) => Promise<void>): void {
    const arr: Promise<void>[] = [];
    this.workers.set(stage, arr);
    const runner = async (): Promise<void> => {
      const iter = this.channelFor(stage).take();
      while (true) {
        const result = await iter.next();
        if (result.done) break;
        // Gate: wait here (after dequeue, before processing) so pause() halts
        // workers between jobs. In-flight work already underway is unaffected.
        await this.gate;
        const job = result.value;
        this.counters[stage].inFlight++;
        this.inFlight[stage].add(job.absPath);
        try {
          await withRetry(stage, job, handler, (err) => {
            this.counters[stage].errors++;
            void recordDeadLetter({
              key: job.mapleId ?? job.absPath,
              stage,
              absPath: job.absPath,
              error: err.message,
              attempts: MAX_ATTEMPTS,
            }).catch(() => {});
            this.counters[stage].deadLetter++;
          });
        } finally {
          this.counters[stage].inFlight--;
          this.inFlight[stage].delete(job.absPath);
          this.processedCounts[stage]++;
        }
        // Yield to the event loop between jobs so HTTP handlers and other
        // queued microtasks get a tick. Critical for the `thumb` stage where
        // the FFI symbol call is synchronous from JS — without a yield, a
        // busy stage can starve `/api/*` requests entirely.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    };
    // Attach the handler once per stage. We replay `spawnOne` for live pool grow.
    this.currentHandlers.set(stage, handler);
    for (let i = 0; i < this.pools[stage]; i++) {
      arr.push(runner());
    }
  }

  private currentHandlers: Map<Stage, (job: PipelineJob) => Promise<void>> = new Map();

  private spawnOne(stage: Stage): void {
    const handler = this.currentHandlers.get(stage);
    if (!handler) return;
    const arr = this.workers.get(stage);
    if (!arr) return;
    const run = async (): Promise<void> => {
      const iter = this.channelFor(stage).take();
      while (true) {
        const result = await iter.next();
        if (result.done) break;
        // Gate: wait here (after dequeue, before processing) so pause() halts
        // workers between jobs. In-flight work already underway is unaffected.
        await this.gate;
        const job = result.value;
        this.counters[stage].inFlight++;
        this.inFlight[stage].add(job.absPath);
        try {
          await withRetry(stage, job, handler, (err) => {
            this.counters[stage].errors++;
            void recordDeadLetter({
              key: job.mapleId ?? job.absPath,
              stage,
              absPath: job.absPath,
              error: err.message,
              attempts: MAX_ATTEMPTS,
            }).catch(() => {});
            this.counters[stage].deadLetter++;
          });
        } finally {
          this.counters[stage].inFlight--;
          this.inFlight[stage].delete(job.absPath);
          this.processedCounts[stage]++;
        }
        // Yield to the event loop between jobs so HTTP handlers and other
        // queued microtasks get a tick. Critical for the `thumb` stage where
        // the FFI symbol call is synchronous from JS — without a yield, a
        // busy stage can starve `/api/*` requests entirely.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    };
    arr.push(run());
  }

  private channelFor(stage: Stage): BoundedQueue<PipelineJob> {
    switch (stage) {
      case "discover": return this.channels.discover;
      case "hash": return this.channels.hash;
      case "exif": return this.channels.exif;
      case "thumb": return this.channels.thumb;
      case "ai": return this.channels.ai;
      case "mongo": return this.channels.mongo;
    }
  }

  // ---- Stage handlers ------------------------------------------------------

  private async runDiscover(job: PipelineJob): Promise<void> {
    if (job.kind === "remove") {
      // Removal bypasses hashing; go straight to mongo for soft-delete.
      await this.channels.mongo.push(job);
      return;
    }
    await this.channels.hash.push(job);
  }

  private async runHash(job: PipelineJob): Promise<void> {
    if (job.kind === "remove") {
      await this.channels.exif.push(job);
      return;
    }
    const read = this.handlers.readHead ?? defaultReadHead;
    const head = await read(job.absPath);
    const stat = await fs.stat(job.absPath);

    // The hash stage only derives sha1Head (cheap). The primary maple:id is
    // finalised at the exif stage once capturedAt is parsed — see spec §04.
    // We stash the head bytes on the job so exif can re-derive without reading
    // the file twice; they are cleared again before the thumb stage.
    const sha1HeadHex = toHex(sha1(head));
    job.sha1Head = sha1HeadHex;
    job.size = stat.size;
    job.mtime = stat.mtimeMs;
    job.headBytes = head;
    await this.channels.exif.push(job);
  }

  private async runExif(job: PipelineJob): Promise<void> {
    if (job.kind === "remove") {
      await this.channels.thumb.push(job);
      return;
    }
    // Tests can override readExif. At runtime, the IndexerService leaves it
    // unset and we fall through to the default exifr-backed parser.
    const h = this.handlers.readExif ?? defaultReadExif;
    await h(job);

    // Finalise maple:id now that the exif fields are on the job.
    //   capturedAt present -> primary (tag 0x01, BLAKE3 of sha1Head||ts||serial||shutter)
    //   capturedAt missing -> fallback (tag 0x02, BLAKE3 of sha1Full||filesize)
    // See `./id.ts` and spec §04 for the byte layout.
    const head = job.headBytes;
    if (head) {
      const id = deriveId(
        head,
        job.capturedAt ?? null,
        job.cameraSerial ?? null,
        job.shutterCount ?? null
      );
      job.mapleId = id.hex;
      // Release the 64 KB buffer; it is no longer needed downstream.
      job.headBytes = undefined;
    }
    await this.channels.thumb.push(job);
  }

  private async runThumb(job: PipelineJob): Promise<void> {
    if (job.kind === "remove") {
      await this.channels.ai.push(job);
      return;
    }
    const h = this.handlers.generateThumb;
    if (h && !job.skipThumb) await h(job);
    await this.channels.ai.push(job);
  }

  private async runAi(job: PipelineJob): Promise<void> {
    // Test override always wins — keeps the existing pipeline tests working
    // without touching the handler registry collection.
    const h = this.handlers.runAi;
    if (h) {
      await h(job);
    } else if (job.kind === "index" && job.mapleId) {
      // Consult the registry to see if this stage is routed to an external
      // implementation. The lookup is cached after the first call, so this
      // is a Map hit on the hot path.
      const resolved = await resolveHandler("ai");
      if (resolved.impl === "http" && resolved.url) {
        const out = await dispatchAi(
          {
            contractVersion: CONTRACT_VERSION,
            stage: "ai",
            mapleId: job.mapleId,
            absPath: job.absPath,
            exif: job.exif ?? null,
          },
          { url: resolved.url, timeoutMs: resolved.timeoutMs ?? undefined },
        );
        job.faces = out.faces;
        job.aiTags = out.aiTags;
      }
    }
    // Pass-through today: empty arrays keep the downstream schema stable so
    // consumers can index `faces.personId` even while detection is stubbed.
    // TODO(T7-ai-onnx): swap `[]` for ONNX RetinaFace + MobileFaceNet output.
    job.faces = job.faces ?? [];
    job.aiTags = job.aiTags ?? [];
    if (process.env.MAPLE_INDEXER_VERBOSE === "1") {
      log.debug(
        {
          stage: "ai",
          id: job.mapleId ?? null,
          absPath: job.absPath,
          faces: job.faces.length,
          aiTags: job.aiTags.length,
        },
        "pass-through",
      );
    }
    await this.channels.mongo.push(job);
  }

  private async runMongo(job: PipelineJob): Promise<void> {
    if (job.kind === "remove") {
      await images.softDelete(job.absPath);
      return;
    }
    if (job.kind === "rename" && job.mapleId) {
      await images.updatePath(job.mapleId, job.absPath, pathMod.basename(job.absPath));
      // A rename preserves the maple:id but the on-disk thumb + preview at
      // the old path are now orphaned — they will never be served again and
      // the GC sweep would not touch them (the row isn't soft-deleted).
      // Best-effort unlink here; ENOENT is expected when the files never existed.
      if (job.fromPath) {
        for (const kind of ["thumbs", "previews"] as const) {
          const file = cachePathFor(job.fromPath, kind);
          try {
            await fs.unlink(file);
          } catch (e) {
            const code = (e as NodeJS.ErrnoException).code;
            if (code !== "ENOENT") {
              log.warn(
                {
                  stage: "mongo",
                  id: job.mapleId,
                  file,
                  action: "rename-orphan-unlink-failed",
                  error: e instanceof Error ? e.message : String(e),
                },
                "rename-orphan-unlink-failed",
              );
            }
          }
        }
      }
      return;
    }
    const h = this.handlers.upsertMongo ?? defaultUpsert;
    await h(job);
  }
}

async function withRetry(
  stage: Stage,
  job: PipelineJob,
  handler: (job: PipelineJob) => Promise<void>,
  onDeadLetter: (err: Error) => void
): Promise<void> {
  let attempt = 0;
  while (true) {
    try {
      await handler(job);
      return;
    } catch (e) {
      attempt++;
      const err = e instanceof Error ? e : new Error(String(e));
      if (attempt >= MAX_ATTEMPTS) {
        log.error(
          { stage, absPath: job.absPath, err: err.message },
          "giving up",
        );
        onDeadLetter(err);
        return;
      }
      const backoffMs = 100 * 2 ** (attempt - 1);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
}
