/**
 * Slow-tier OCR worker. Mirrors the geocode worker's claim-and-lease
 * loop (`geocode-worker.ts`) but reads the asset's thumbnail from disk
 * (via `cachePathFor`) and runs it through the OCR engine instead of
 * Nominatim.
 *
 * Why thumbnails (not full RAWs)?
 *   - The fast-tier indexer already produces a JPEG thumb at every
 *     library root (`<folder>/.maple/thumbs/<sha>.jpg`). Tesseract
 *     reads it fine and avoids paying the RAW decode cost again here.
 *   - Most OCR-relevant content (signs, menus, screenshots) is legible
 *     at thumb resolution — the fast-tier thumb is currently
 *     long-edge-1024 which is well above tesseract's resolution floor
 *     for English text.
 *
 * Why a separate stage state instead of piggy-backing on `describe`?
 *   - The two stages can run in parallel (different inputs, different
 *     CPU budgets) and they have independent retry budgets. Treating
 *     them as separate workers keeps the bookkeeping clean and makes
 *     dead-letter triage actionable per failure mode.
 *
 * Lease + dead-letter semantics: identical to the geocode worker.
 * `LEASE_MS = 10 * 60_000` covers a slow tesseract pass on a busy host.
 *
 * Spec mirror: see `docs/indexer-enrichment.md` §1.2.
 */

import * as fs from "node:fs/promises";
import type { Collection } from "mongodb";
import { assetsCollection } from "../db/client.ts";
import type { AssetDoc, Place } from "../db/schema.ts";
import { cachePathFor } from "../fs/xmp.ts";
import { child as childLogger } from "../log.ts";
import {
  meilisearchClient,
  type MeilisearchClient,
} from "./meilisearch-client.ts";
import { ocrEngine, OCR_ENGINE_VERSION, type OcrEngine } from "./ocr-engine.ts";
import {
  composeSearchBlob,
  searchBlobUpdateExpression,
} from "./search-blob.ts";

const defaultLog = childLogger("enrichment:ocr-worker");

/** Stage handler version. Bump to re-process every asset on the next loop. */
export const OCR_HANDLER_VERSION = 1;

const POLL_MS_DEFAULT = 1_000;
const LEASE_MS_DEFAULT = 10 * 60 * 1_000;
const MAX_ATTEMPTS_DEFAULT = 5;

export interface OcrWorkerConfig {
  engine?: OcrEngine;
  /** Optional override for tests. Defaults to the module-level singleton
   * which reads `MAPLE_MEILISEARCH_URL` from env (no-op when unset). */
  meilisearch?: MeilisearchClient;

  workerId?: string;
  pollMs?: number;
  leaseMs?: number;
  maxAttempts?: number;

  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

interface ClaimedAsset {
  _id: AssetDoc["folder_id"]; // ObjectId
  folder_id_hex: string;
  maple_id: string;
  abs_path: string;
  captured_at: string | null;
  enrichment_attempts: number;
  /** Sibling enrichment outputs already on the row when we claimed it.
   * Used to seed the JS-side Meilisearch upsert; the Mongo `$set`
   * pipeline reads them off the live row directly. */
  place: Place | null;
  description: string | null;
}

export type TickResult =
  | { kind: "no-claim" }
  | {
      kind: "completed";
      textLength: number;
    }
  | {
      kind: "failed";
      retryable: boolean;
      deadLettered: boolean;
      error: string;
    };

export class OcrWorker {
  private readonly engine: OcrEngine;
  private readonly meilisearch: MeilisearchClient;
  private readonly workerId: string;
  private readonly pollMs: number;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (msg: string) => void;

  private shuttingDown = false;
  private loopPromise: Promise<void> | null = null;

  constructor(config: OcrWorkerConfig = {}) {
    this.engine = config.engine ?? ocrEngine();
    this.meilisearch = config.meilisearch ?? meilisearchClient();
    this.workerId =
      config.workerId ??
      `ocr-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
    this.pollMs = config.pollMs ?? POLL_MS_DEFAULT;
    this.leaseMs = config.leaseMs ?? LEASE_MS_DEFAULT;
    this.maxAttempts = config.maxAttempts ?? MAX_ATTEMPTS_DEFAULT;
    this.now = config.now ?? (() => new Date());
    this.sleep =
      config.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.log = config.log ?? ((msg) => defaultLog.info(msg));
  }

  start(): void {
    if (this.loopPromise) return;
    this.loopPromise = this.runLoop().catch((err) => {
      this.log(
        JSON.stringify({
          component: "ocr-worker",
          event: "loop-crashed",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    });
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.loopPromise) await this.loopPromise;
  }

  async tick(): Promise<TickResult> {
    const claim = await this.claim();
    if (!claim) return { kind: "no-claim" };
    try {
      const result = await this.process(claim);
      await this.complete(claim, result);
      return { kind: "completed", textLength: result.text.length };
    } catch (err) {
      const retryable = isRetryable(err);
      const message = err instanceof Error ? err.message : String(err);
      const deadLettered = await this.fail(claim, message, retryable);
      return { kind: "failed", retryable, deadLettered, error: message };
    }
  }

  private async runLoop(): Promise<void> {
    while (!this.shuttingDown) {
      const result = await this.tick();
      if (result.kind === "no-claim") {
        await this.sleep(this.pollMs);
      }
    }
    this.log(
      JSON.stringify({ component: "ocr-worker", event: "loop-stopped" }),
    );
  }

  private async coll(): Promise<Collection<AssetDoc>> {
    return assetsCollection();
  }

  /**
   * Atomic claim. Filter is intentionally agnostic to whether
   * `enrichment.ocr` exists yet — old rows that pre-date the field
   * will have `enrichment.ocr.done_at` resolve to `undefined`, which
   * matches `null` under Mongo's equality semantics.
   */
  private async claim(): Promise<ClaimedAsset | null> {
    const c = await this.coll();
    const nowIso = this.now().toISOString();
    const leaseExpiresAt = new Date(
      this.now().getTime() + this.leaseMs,
    ).toISOString();

    const filter = {
      "enrichment.ocr.done_at": null,
      "enrichment.ocr.dead_letter_at": null,
      $or: [
        { "enrichment.ocr.locked_by": null },
        { "enrichment.ocr.lease_expires_at": { $lt: nowIso } },
      ],
    };

    const update = {
      $set: {
        "enrichment.ocr.locked_by": this.workerId,
        "enrichment.ocr.lease_expires_at": leaseExpiresAt,
      },
    };

    // Sort newest-captured first — same UX argument as the geocode
    // worker, the operator wants their visible-photo backlog to feel
    // fresh.
    const result = await c.findOneAndUpdate(filter, update, {
      sort: { "exif.captured_at": -1, _id: 1 },
      returnDocument: "after",
    });
    if (!result) return null;

    return {
      _id: result._id,
      folder_id_hex: result.folder_id.toHexString(),
      maple_id:
        (result as unknown as { maple_id?: string }).maple_id ?? "",
      abs_path: result.abs_path,
      captured_at: result.exif?.captured_at ?? null,
      enrichment_attempts: result.enrichment?.ocr?.attempts ?? 0,
      place: result.place ?? null,
      description: result.description ?? null,
    };
  }

  /** Read the thumbnail and run OCR. */
  private async process(
    claim: ClaimedAsset,
  ): Promise<{ text: string; engine: string; engine_version: string }> {
    const thumbPath = cachePathFor(claim.abs_path, "thumbs");
    const bytes = await fs.readFile(thumbPath);
    const out = await this.engine.recognizeText(new Uint8Array(bytes));
    return out;
  }

  /**
   * Single aggregation-pipeline `updateOne` — sets `ocr_text`,
   * `ocr_meta`, the OCR stage state, AND recomputes `asset.search_blob`
   * from the live row state (with the just-computed `ocr_text` injected
   * via the override).
   */
  private async complete(
    claim: ClaimedAsset,
    result: { text: string; engine: string; engine_version: string },
  ): Promise<void> {
    const c = await this.coll();
    const nowIso = this.now().toISOString();
    const ocrMeta = {
      engine: "tesseract" as const,
      engine_version: result.engine_version,
      generated_at: nowIso,
    };
    await c.updateOne({ _id: claim._id }, [
      {
        $set: {
          ocr_text: result.text,
          ocr_meta: ocrMeta,
          search_blob: searchBlobUpdateExpression({
            ocrText: result.text,
          }),
          "enrichment.ocr.done_at": nowIso,
          "enrichment.ocr.version": OCR_HANDLER_VERSION,
          "enrichment.ocr.locked_by": null,
          "enrichment.ocr.lease_expires_at": null,
          "enrichment.ocr.last_error": null,
        },
      },
    ]);

    if (claim.maple_id.length === 0) return;
    try {
      const unified = composeSearchBlob({
        place: claim.place,
        description: claim.description,
        ocrText: result.text,
      });
      await this.meilisearch.upsert({
        id: claim.maple_id,
        searchBlob: unified,
        description: claim.description,
        ocrText: result.text,
        folderId: claim.folder_id_hex,
        capturedAt: claim.captured_at,
        deletedAt: null,
      });
    } catch (err) {
      this.log(
        JSON.stringify({
          component: "ocr-worker",
          event: "meilisearch-upsert-error",
          mapleId: claim.maple_id,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  private async fail(
    claim: ClaimedAsset,
    error: string,
    retryable: boolean,
  ): Promise<boolean> {
    const c = await this.coll();
    const nextAttempts = claim.enrichment_attempts + 1;
    const exhausted = !retryable || nextAttempts >= this.maxAttempts;
    const set: Record<string, unknown> = {
      "enrichment.ocr.attempts": nextAttempts,
      "enrichment.ocr.last_error": error,
      "enrichment.ocr.locked_by": null,
      "enrichment.ocr.lease_expires_at": this.now().toISOString(),
    };
    if (exhausted) {
      set["enrichment.ocr.dead_letter_at"] = this.now().toISOString();
    }
    await c.updateOne({ _id: claim._id }, { $set: set });
    return exhausted;
  }
}

/** Whether an OCR error should be retried. Disk read errors are
 * retryable (the thumb may not have been written yet for a freshly
 * indexed asset); engine errors are NOT retryable on the same input. */
function isRetryable(err: unknown): boolean {
  if (err instanceof Error) {
    // Node fs codes for "transient" filesystem issues. ENOENT is
    // retryable here because the fast-tier thumb job runs concurrently
    // and may not have written the file yet — give it another lease.
    const code = (err as NodeJS.ErrnoException).code;
    if (
      code === "ENOENT" ||
      code === "EBUSY" ||
      code === "EAGAIN" ||
      code === "EMFILE"
    ) {
      return true;
    }
  }
  // Default: not retryable. A tesseract crash on a specific image is a
  // bad-input case, not a transient outage; dead-letter and move on.
  return false;
}

// Exported for tests so the smoke test in ocr-worker.test.ts can keep
// the engine version assertion in sync without importing ocr-engine.
export { OCR_ENGINE_VERSION };
