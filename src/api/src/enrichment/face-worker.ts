/**
 * Slow-tier face-detection worker. Pulls assets that haven't been face-
 * processed yet, opens the cached thumbnail, runs RetinaFace +
 * MobileFaceNet, and patches `asset.faces`.
 *
 * Mirrors `geocode-worker.ts` line-for-line on the claim/lease/retry
 * mechanics — same `tick()` shape, same single-`updateOne` complete,
 * same dead-letter ratchet. The only domain-specific bits are:
 *
 *   - Claim filter: stage = `face` instead of `geocode`. There's no
 *     `thumb.ready` field on the asset today; the worker checks for the
 *     thumbnail file at process time and dead-letters with a clear
 *     "thumb-missing" reason if it isn't there.
 *
 *   - `process()` returns `AssetFaceDoc[]`. An empty array is a valid,
 *     successful result (asset has no faces).
 *
 *   - `LEASE_MS = 30 minutes` because the first inference is slow with
 *     a cold model. Per-call latency drops to single-digit seconds once
 *     the model is warm; the 30-minute lease is sized for the worst
 *     case so a slow first claim doesn't auto-release mid-flight.
 *
 *   - Pool size 1 (CPU-bound; serialise on the model). To run more
 *     workers, deploy more processes — each one loads its own model
 *     copy. We don't share sessions across processes.
 *
 * Spec: `docs/indexer-enrichment.md` §6 ("Face worker").
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Collection } from "mongodb";
import { assetsCollection } from "../db/client.ts";
import type { AssetDoc, AssetFaceDoc } from "../db/schema.ts";
import { child as childLogger } from "../log.ts";
import { cachePathFor } from "../fs/xmp.ts";
import { CircuitBreaker } from "./circuit-breaker.ts";
import {
  defaultFaceDetector,
  type DetectedFace,
  type FaceDetector,
} from "./face-detector.ts";

const defaultLog = childLogger("enrichment:face-worker");

/** Stage handler version. Bump to re-process every asset on the next loop
 * (paired with a `db.assets.updateMany(...)` per §7.3). */
export const FACE_HANDLER_VERSION = 1;

const POLL_MS_DEFAULT = 1_000;
/** 30 minutes. First inference is slow with a cold ONNX model — the
 * lease is sized for that worst case. See class doc-comment. */
const LEASE_MS_DEFAULT = 30 * 60 * 1_000;
const MAX_ATTEMPTS_DEFAULT = 5;

/** Non-retryable error tag used when the asset's thumbnail is missing on
 * disk. Surfaced as `last_error` so the operator can re-thumb and reset. */
export const THUMB_MISSING_REASON = "thumb-missing";

export interface FaceWorkerConfig {
  /** Detector to use. Defaults to the singleton wired to the ONNX models. */
  detector?: FaceDetector;
  breaker?: CircuitBreaker;

  /** Unique id for this worker instance — written to `enrichment.face.locked_by`
   * so multi-instance deployments can spot which worker owns a stuck claim.
   * Defaults to `face-${process.pid}-${random}`. */
  workerId?: string;

  /** Idle poll interval when no claim is available. Default 1_000 ms. */
  pollMs?: number;
  /** Lease duration for a claim. Default 30 min. */
  leaseMs?: number;
  /** Retry budget before dead-letter. Default 5. */
  maxAttempts?: number;

  /** Time source. Override in tests. */
  now?: () => Date;
  /** Sleep helper. Override in tests so we can step the loop deterministically. */
  sleep?: (ms: number) => Promise<void>;
  /** Logger. Defaults to the `enrichment:face-worker` child logger. */
  log?: (msg: string) => void;
}

interface ClaimedAsset {
  _id: AssetDoc["folder_id"]; // ObjectId
  abs_path: string;
  enrichment_attempts: number;
}

/** Per-loop status. Returned by `tick()` to keep tests deterministic. */
export type TickResult =
  | { kind: "no-claim" }
  | { kind: "circuit-open" }
  | { kind: "completed"; faces: AssetFaceDoc[] }
  | { kind: "failed"; retryable: boolean; deadLettered: boolean; error: string };

export class FaceWorker {
  private readonly detector: FaceDetector;
  private readonly breaker: CircuitBreaker;
  private readonly workerId: string;
  private readonly pollMs: number;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (msg: string) => void;

  private shuttingDown = false;
  private loopPromise: Promise<void> | null = null;

  constructor(config: FaceWorkerConfig = {}) {
    this.detector = config.detector ?? defaultFaceDetector();
    this.breaker = config.breaker ?? new CircuitBreaker();
    this.workerId =
      config.workerId ??
      `face-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
    this.pollMs = config.pollMs ?? POLL_MS_DEFAULT;
    this.leaseMs = config.leaseMs ?? LEASE_MS_DEFAULT;
    this.maxAttempts = config.maxAttempts ?? MAX_ATTEMPTS_DEFAULT;
    this.now = config.now ?? (() => new Date());
    this.sleep =
      config.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.log = config.log ?? ((msg) => defaultLog.info(msg));
  }

  /** Start the loop. Returns immediately; the loop runs in the background. */
  start(): void {
    if (this.loopPromise) return;
    this.loopPromise = this.runLoop().catch((err) => {
      this.log(
        JSON.stringify({
          component: "face-worker",
          event: "loop-crashed",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    });
  }

  /** Signal the loop to exit. Resolves once the current `tick()` completes. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.loopPromise) await this.loopPromise;
  }

  /** One iteration. Exposed for tests so we don't need to drive the timing
   * primitives — the runtime loop just calls this on a poll interval. */
  async tick(): Promise<TickResult> {
    if (!this.breaker.allowRequest()) {
      return { kind: "circuit-open" };
    }
    const claim = await this.claim();
    if (!claim) return { kind: "no-claim" };
    try {
      const faces = await this.process(claim);
      await this.complete(claim, faces);
      this.breaker.recordSuccess();
      return { kind: "completed", faces };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The face pipeline is fully local — there's no remote service to
      // protect against. We treat every failure as retryable EXCEPT the
      // thumb-missing case (no point spinning if the file isn't there).
      const retryable = !message.includes(THUMB_MISSING_REASON);
      // We don't trip the breaker on local failures — local errors are
      // typically per-asset (corrupt JPEG, missing thumb), not systemic.
      this.breaker.recordSuccess();
      const deadLettered = await this.fail(claim, message, retryable);
      return { kind: "failed", retryable, deadLettered, error: message };
    }
  }

  private async runLoop(): Promise<void> {
    while (!this.shuttingDown) {
      const result = await this.tick();
      if (result.kind === "no-claim" || result.kind === "circuit-open") {
        await this.sleep(this.pollMs);
      }
    }
    this.log(JSON.stringify({ component: "face-worker", event: "loop-stopped" }));
  }

  private async coll(): Promise<Collection<AssetDoc>> {
    return assetsCollection();
  }

  /**
   * Atomic claim: filter on (face pending, not dead-lettered, lock free or
   * expired) and bump `locked_by` + `lease_expires_at` in one operation.
   * Mongo guarantees only one worker wins.
   *
   * Note: there's no `thumb.ready` field on the asset today (the indexer
   * doesn't write one). We claim regardless and validate the file exists
   * inside `process()` — see `THUMB_MISSING_REASON`.
   */
  private async claim(): Promise<ClaimedAsset | null> {
    const c = await this.coll();
    const nowIso = this.now().toISOString();
    const leaseExpiresAt = new Date(
      this.now().getTime() + this.leaseMs,
    ).toISOString();

    const filter = {
      "enrichment.face.done_at": null,
      "enrichment.face.dead_letter_at": null,
      $or: [
        { "enrichment.face.locked_by": null },
        { "enrichment.face.lease_expires_at": { $lt: nowIso } },
      ],
    };

    const update = {
      $set: {
        "enrichment.face.locked_by": this.workerId,
        "enrichment.face.lease_expires_at": leaseExpiresAt,
      },
    };

    // Sort newest-captured first so visible-photo backlog feels fresh; ties
    // are broken by _id so the sort is stable. Older rows without an
    // exif.captured_at sort last (Mongo treats missing fields as
    // smaller-than-anything in ascending order, so descending sorts them
    // to the end).
    const result = await c.findOneAndUpdate(filter, update, {
      sort: { "exif.captured_at": -1, _id: 1 },
      returnDocument: "after",
    });
    if (!result) return null;

    return {
      _id: result._id,
      abs_path: result.abs_path,
      enrichment_attempts: result.enrichment?.face.attempts ?? 0,
    };
  }

  /** Read thumbnail → detect → embed each detection → return docs. */
  private async process(claim: ClaimedAsset): Promise<AssetFaceDoc[]> {
    const thumbPath = cachePathFor(claim.abs_path, "thumbs");
    if (!existsSync(thumbPath)) {
      throw new Error(`${THUMB_MISSING_REASON}: ${thumbPath}`);
    }
    const bytes = new Uint8Array(await readFile(thumbPath));
    const detections = await this.detector.detectFaces(bytes);
    if (detections.length === 0) return [];
    const faces: AssetFaceDoc[] = [];
    for (const det of detections) {
      const embedding = await this.detector.embedFace(bytes, det);
      faces.push(detectionToDoc(det, embedding));
    }
    return faces;
  }

  /** Single `updateOne` so the success state is atomic — `faces`,
   * `enrichment.face.done_at`, and the lock release all flip together.
   * Empty `faces` is a valid result (asset has no detected faces).
   */
  private async complete(
    claim: ClaimedAsset,
    faces: AssetFaceDoc[],
  ): Promise<void> {
    const c = await this.coll();
    await c.updateOne(
      { _id: claim._id },
      {
        $set: {
          faces,
          "enrichment.face.done_at": this.now().toISOString(),
          "enrichment.face.version": FACE_HANDLER_VERSION,
          "enrichment.face.locked_by": null,
          "enrichment.face.lease_expires_at": null,
          "enrichment.face.last_error": null,
        },
      },
    );
  }

  /**
   * Increment `attempts`, release the lock, and dead-letter once the budget
   * is exhausted. Returns `true` when the asset was dead-lettered.
   *
   * Releasing `lease_expires_at` to `now` (rather than nulling it) is
   * deliberate: the next claim filter `$or [ locked_by:null,
   * lease_expires_at:<now ]` reaps it on the next tick without us having
   * to wait for the lease's natural expiry.
   */
  private async fail(
    claim: ClaimedAsset,
    error: string,
    retryable: boolean,
  ): Promise<boolean> {
    const c = await this.coll();
    const nextAttempts = claim.enrichment_attempts + 1;
    const exhausted = !retryable || nextAttempts >= this.maxAttempts;
    const set: Record<string, unknown> = {
      "enrichment.face.attempts": nextAttempts,
      "enrichment.face.last_error": error,
      "enrichment.face.locked_by": null,
      "enrichment.face.lease_expires_at": this.now().toISOString(),
    };
    if (exhausted) {
      set["enrichment.face.dead_letter_at"] = this.now().toISOString();
    }
    await c.updateOne({ _id: claim._id }, { $set: set });
    return exhausted;
  }
}

/** Convert a detector hit + its embedding into the schema doc shape. The
 * embedding is stored as `number[]` for Mongo-friendliness; a 512×4 byte
 * BSON Binary would be marginally smaller but harder to inspect. */
function detectionToDoc(
  det: DetectedFace,
  embedding: Float32Array,
): AssetFaceDoc {
  return {
    bbox: det.bbox,
    confidence: det.confidence,
    person_id: null,
    embedding: Array.from(embedding),
  };
}
