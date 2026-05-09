/**
 * Slow-tier vision-LLM caption worker. Pulls assets that have a thumb but
 * no description, calls the configured provider (Ollama by default), and
 * patches the asset row with the caption + provider metadata.
 *
 * Mirrors the geocode worker shape (`docs/indexer-enrichment.md` §1.2,
 * §6) — same atomic claim, lease, retry, dead-letter mechanics. Only
 * `process()` and the cost-cap check are new.
 *
 * Spend tracking lives in `describe-spend.repo.ts`. Before each call the
 * worker reads today's UTC total and compares against the configured
 * cap; over the cap, the loop sleeps and `tick()` returns
 * `circuit-pause` (mirrors the breaker shape so the runtime loop and
 * tests can react with one branch). The cap rolls over at 00:00 UTC
 * because the spend doc is keyed by day.
 */

import { promises as fs } from "node:fs";
import type { Collection } from "mongodb";
import { assetsCollection } from "../db/client.ts";
import type { AssetDoc } from "../db/schema.ts";
import { child as childLogger } from "../log.ts";
import { cachePathFor } from "../fs/xmp.ts";
import {
  RemoteError,
  type DescribeProvider,
} from "./describe-providers/index.ts";
import {
  getTodaySpend,
  incrementSpend,
} from "./describe-spend.repo.ts";

const defaultLog = childLogger("enrichment:describe-worker");

/** Stage handler version. Bump to re-process every asset on the next loop
 * (paired with a `db.assets.updateMany(...)` per §7.3). */
export const DESCRIBE_HANDLER_VERSION = 1;
/** Prompt-content hash bumped whenever the default prompt changes. Stored
 * on `asset.description_meta.prompt_version` so versioned re-runs can
 * sweep stale captions. */
export const DESCRIBE_PROMPT_VERSION = 1;

const POLL_MS_DEFAULT = 1_000;
const LEASE_MS_DEFAULT = 10 * 60 * 1_000;
const MAX_ATTEMPTS_DEFAULT = 5;

export interface DescribeWorkerConfig {
  provider: DescribeProvider;
  /** Caption-generation prompt. Wired through to the provider verbatim. */
  systemPrompt: string;
  /** Model id for the selected provider. */
  model: string;
  /** Per-day USD cap. The worker pauses (returns `circuit-pause`) for the
   * rest of the UTC day once this is reached. */
  dailyCapUsd: number;

  /** Unique id for this worker instance — written to
   * `enrichment.describe.locked_by`. Defaults to
   * `describe-${process.pid}-${random}`. */
  workerId?: string;
  /** Idle poll interval when no claim is available. Default 1_000 ms. */
  pollMs?: number;
  /** Lease duration for a claim. Default 10 min. */
  leaseMs?: number;
  /** Retry budget before dead-letter. Default 5. */
  maxAttempts?: number;

  /** Time source. Override in tests. */
  now?: () => Date;
  /** Sleep helper. Override in tests so we can step the loop deterministically. */
  sleep?: (ms: number) => Promise<void>;
  /** Logger. Defaults to the `enrichment:describe-worker` child logger. */
  log?: (msg: string) => void;
  /** Test override. Defaults to reading from disk via `cachePathFor`. */
  readThumb?: (absPath: string) => Promise<Buffer>;
}

interface ClaimedAsset {
  _id: AssetDoc["folder_id"]; // ObjectId
  abs_path: string;
  enrichment_attempts: number;
}

/** Per-loop status. Returned by `tick()` to keep tests deterministic. */
export type DescribeTickResult =
  | { kind: "no-claim" }
  | { kind: "circuit-pause"; reason: "cap-exceeded"; spendUsd: number }
  | { kind: "completed"; cost_usd: number }
  | { kind: "failed"; retryable: boolean; deadLettered: boolean; error: string };

export class DescribeWorker {
  private readonly provider: DescribeProvider;
  private readonly systemPrompt: string;
  private readonly model: string;
  private readonly dailyCapUsd: number;
  private readonly workerId: string;
  private readonly pollMs: number;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (msg: string) => void;
  private readonly readThumb: (absPath: string) => Promise<Buffer>;

  private shuttingDown = false;
  private loopPromise: Promise<void> | null = null;

  constructor(config: DescribeWorkerConfig) {
    this.provider = config.provider;
    this.systemPrompt = config.systemPrompt;
    this.model = config.model;
    this.dailyCapUsd = config.dailyCapUsd;
    this.workerId =
      config.workerId ??
      `describe-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
    this.pollMs = config.pollMs ?? POLL_MS_DEFAULT;
    this.leaseMs = config.leaseMs ?? LEASE_MS_DEFAULT;
    this.maxAttempts = config.maxAttempts ?? MAX_ATTEMPTS_DEFAULT;
    this.now = config.now ?? (() => new Date());
    this.sleep =
      config.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.log = config.log ?? ((msg) => defaultLog.info(msg));
    this.readThumb =
      config.readThumb ??
      (async (absPath) =>
        fs.readFile(cachePathFor(absPath, "thumbs")));
  }

  /** Start the loop. Returns immediately; the loop runs in the background. */
  start(): void {
    if (this.loopPromise) return;
    this.loopPromise = this.runLoop().catch((err) => {
      this.log(
        JSON.stringify({
          component: "describe-worker",
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

  /** One iteration. Exposed for tests so we don't drive the timing
   * primitives — the runtime loop just calls this on a poll interval. */
  async tick(): Promise<DescribeTickResult> {
    // Check the cap BEFORE claiming. Claim-then-bail would burn a lock + a
    // poll cycle every tick once the cap is hit; this keeps the loop
    // cheap. We re-check after claim too (tests / multi-instance races).
    const spend = await getTodaySpend(this.now());
    if (spend >= this.dailyCapUsd) {
      return { kind: "circuit-pause", reason: "cap-exceeded", spendUsd: spend };
    }

    const claim = await this.claim();
    if (!claim) return { kind: "no-claim" };
    try {
      const result = await this.process(claim);
      await this.complete(claim, result);
      const newTotal = await incrementSpend(result.cost_usd, this.now());
      this.log(
        JSON.stringify({
          component: "describe-worker",
          event: "completed",
          assetId: String(claim._id),
          provider: this.provider.name,
          cost_usd: result.cost_usd,
          today_total_usd: newTotal,
        }),
      );
      return { kind: "completed", cost_usd: result.cost_usd };
    } catch (err) {
      const retryable = err instanceof RemoteError ? err.retryable : false;
      const message = err instanceof Error ? err.message : String(err);
      const deadLettered = await this.fail(claim, message, retryable);
      return { kind: "failed", retryable, deadLettered, error: message };
    }
  }

  private async runLoop(): Promise<void> {
    while (!this.shuttingDown) {
      const result = await this.tick();
      if (
        result.kind === "no-claim" ||
        result.kind === "circuit-pause"
      ) {
        await this.sleep(this.pollMs);
      }
    }
    this.log(
      JSON.stringify({ component: "describe-worker", event: "loop-stopped" }),
    );
  }

  private async coll(): Promise<Collection<AssetDoc>> {
    return assetsCollection();
  }

  /**
   * Atomic claim: filter on (describe pending, lock free or expired) and
   * bump `locked_by` + `lease_expires_at` in one operation. We don't
   * filter on `description: null` — the worker overwrites whatever's
   * there, and `enrichment.describe.done_at` is the single source of
   * truth for "needs work."
   */
  private async claim(): Promise<ClaimedAsset | null> {
    const c = await this.coll();
    const nowIso = this.now().toISOString();
    const leaseExpiresAt = new Date(
      this.now().getTime() + this.leaseMs,
    ).toISOString();

    const filter = {
      "enrichment.describe.done_at": null,
      "enrichment.describe.dead_letter_at": null,
      $or: [
        { "enrichment.describe.locked_by": null },
        { "enrichment.describe.lease_expires_at": { $lt: nowIso } },
      ],
    };

    const update = {
      $set: {
        "enrichment.describe.locked_by": this.workerId,
        "enrichment.describe.lease_expires_at": leaseExpiresAt,
      },
    };

    const result = await c.findOneAndUpdate(filter, update, {
      sort: { "exif.captured_at": -1, _id: 1 },
      returnDocument: "after",
    });
    if (!result) return null;
    return {
      _id: result._id,
      abs_path: result.abs_path,
      enrichment_attempts: result.enrichment?.describe.attempts ?? 0,
    };
  }

  /** Read the cached thumb → call provider.describe. */
  private async process(claim: ClaimedAsset): Promise<{
    text: string;
    cost_usd: number;
    provider_info: Record<string, string>;
  }> {
    const jpegBytes = await this.readThumb(claim.abs_path);
    const result = await this.provider.describe(jpegBytes, {
      systemPrompt: this.systemPrompt,
      model: this.model,
    });
    return result;
  }

  /** Single `updateOne` so the success state is atomic — `description`,
   * `description_meta`, and the lock release all flip together. */
  private async complete(
    claim: ClaimedAsset,
    result: { text: string; cost_usd: number; provider_info: Record<string, string> },
  ): Promise<void> {
    const c = await this.coll();
    await c.updateOne(
      { _id: claim._id },
      {
        $set: {
          description: result.text,
          description_meta: {
            provider: this.provider.name,
            model: this.model,
            prompt_version: DESCRIBE_PROMPT_VERSION,
            generated_at: this.now().toISOString(),
            cost_usd: result.cost_usd,
            ...result.provider_info,
          },
          "enrichment.describe.done_at": this.now().toISOString(),
          "enrichment.describe.version": DESCRIBE_HANDLER_VERSION,
          "enrichment.describe.locked_by": null,
          "enrichment.describe.lease_expires_at": null,
          "enrichment.describe.last_error": null,
        },
      },
    );
  }

  /** Increment `attempts`, release the lock, and dead-letter once the
   * budget is exhausted. Returns `true` when the asset was dead-lettered. */
  private async fail(
    claim: ClaimedAsset,
    error: string,
    retryable: boolean,
  ): Promise<boolean> {
    const c = await this.coll();
    const nextAttempts = claim.enrichment_attempts + 1;
    const exhausted = !retryable || nextAttempts >= this.maxAttempts;
    const set: Record<string, unknown> = {
      "enrichment.describe.attempts": nextAttempts,
      "enrichment.describe.last_error": error,
      "enrichment.describe.locked_by": null,
      "enrichment.describe.lease_expires_at": this.now().toISOString(),
    };
    if (exhausted) {
      set["enrichment.describe.dead_letter_at"] = this.now().toISOString();
    }
    await c.updateOne({ _id: claim._id }, { $set: set });
    return exhausted;
  }
}
