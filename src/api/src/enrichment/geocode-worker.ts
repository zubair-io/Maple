/**
 * Slow-tier reverse-geocoder. Pulls assets that have GPS but no `place`,
 * calls Nominatim (via the cache), and patches the asset row.
 *
 * Implements the worker shape from `docs/indexer-enrichment.md` §1.2:
 *
 *     while (!shutdown) {
 *       const job = await claim();
 *       if (!job) { sleep(POLL_MS); continue; }
 *       try {
 *         const result = await process(job);
 *         await complete(job, result);
 *       } catch (err) {
 *         await fail(job, err);
 *       }
 *     }
 *
 * Concurrency is via the per-stage state document, not an external queue.
 * `findOneAndUpdate` claims one asset atomically; the lease (`leaseExpiresAt`)
 * makes crashed workers safe to recover from. See §3.1.
 */

import type { Collection } from "mongodb";
import { assetsCollection } from "../db/client.ts";
import type { AssetDoc, Place } from "../db/schema.ts";
import { child as childLogger } from "../log.ts";
import { CircuitBreaker } from "./circuit-breaker.ts";
import { CoordinateCache } from "./coordinate-cache.ts";
import { NominatimClient, NominatimError } from "./nominatim-client.ts";
import { parseNominatimResponse } from "./place-parser.ts";

const defaultLog = childLogger("enrichment:geocode-worker");

/** Stage handler version. Bump to re-process every asset on the next loop
 * (paired with a `db.assets.updateMany(...)` per §7.3). */
export const GEOCODE_HANDLER_VERSION = 1;

const POLL_MS_DEFAULT = 1_000;
const LEASE_MS_DEFAULT = 5 * 60 * 1_000;
const MAX_ATTEMPTS_DEFAULT = 5;

export interface GeocodeWorkerConfig {
  client: NominatimClient;
  cache: CoordinateCache;
  breaker?: CircuitBreaker;

  /** Unique id for this worker instance — written to `enrichment.geocode.locked_by`
   * so multi-instance deployments can spot which worker owns a stuck claim.
   * Defaults to `geocode-${process.pid}-${random}`. */
  workerId?: string;

  /** Idle poll interval when no claim is available. Default 1_000 ms. */
  pollMs?: number;
  /** Lease duration for a claim. Default 5 min. */
  leaseMs?: number;
  /** Retry budget before dead-letter. Default 5. */
  maxAttempts?: number;

  /** Time source. Override in tests. */
  now?: () => Date;
  /** Sleep helper. Override in tests so we can step the loop deterministically. */
  sleep?: (ms: number) => Promise<void>;
  /** Logger. Defaults to the `enrichment:geocode-worker` child logger. */
  log?: (msg: string) => void;
}

interface ClaimedAsset {
  _id: AssetDoc["folder_id"]; // ObjectId
  exif: { gps: { lat: number; lng: number } };
  enrichment_attempts: number;
}

/** Per-loop status. Returned by `tick()` to keep tests deterministic. */
export type TickResult =
  | { kind: "no-claim" }
  | { kind: "circuit-open" }
  | { kind: "completed"; place: Place; cacheHit: boolean }
  | { kind: "failed"; retryable: boolean; deadLettered: boolean; error: string };

export class GeocodeWorker {
  private readonly client: NominatimClient;
  private readonly cache: CoordinateCache;
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

  constructor(config: GeocodeWorkerConfig) {
    this.client = config.client;
    this.cache = config.cache;
    this.breaker = config.breaker ?? new CircuitBreaker();
    this.workerId =
      config.workerId ??
      `geocode-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
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
      // The loop itself shouldn't throw — `tick()` catches everything. If
      // we get here it's a programming error, not a remote outage.
      this.log(
        JSON.stringify({
          component: "geocode-worker",
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
      const { place, cacheHit } = await this.process(claim);
      await this.complete(claim, place);
      this.breaker.recordSuccess();
      return { kind: "completed", place, cacheHit };
    } catch (err) {
      const retryable =
        err instanceof NominatimError ? err.retryable : false;
      const message = err instanceof Error ? err.message : String(err);
      if (retryable) this.breaker.recordFailure();
      else this.breaker.recordSuccess();
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
    this.log(JSON.stringify({ component: "geocode-worker", event: "loop-stopped" }));
  }

  private async coll(): Promise<Collection<AssetDoc>> {
    return assetsCollection();
  }

  /**
   * Atomic claim: filter on (has GPS, geocode pending, lock free or expired)
   * and bump `locked_by` + `lease_expires_at` in one operation. Mongo
   * guarantees only one worker wins.
   */
  private async claim(): Promise<ClaimedAsset | null> {
    const c = await this.coll();
    const nowIso = this.now().toISOString();
    const leaseExpiresAt = new Date(
      this.now().getTime() + this.leaseMs,
    ).toISOString();

    const filter = {
      "exif.gps.lat": { $ne: null },
      "exif.gps.lng": { $ne: null },
      "enrichment.geocode.done_at": null,
      "enrichment.geocode.dead_letter_at": null,
      $or: [
        { "enrichment.geocode.locked_by": null },
        { "enrichment.geocode.lease_expires_at": { $lt: nowIso } },
      ],
    };

    const update = {
      $set: {
        "enrichment.geocode.locked_by": this.workerId,
        "enrichment.geocode.lease_expires_at": leaseExpiresAt,
      },
    };

    // Sort newest-captured first so visible-photo backlog feels fresh; ties
    // are broken by _id so the sort is stable.
    const result = await c.findOneAndUpdate(filter, update, {
      sort: { "exif.captured_at": -1, _id: 1 },
      returnDocument: "after",
    });
    if (!result) return null;

    const gps = result.exif?.gps;
    if (!gps || typeof gps.lat !== "number" || typeof gps.lng !== "number") {
      // Defensive: filter should have excluded this. Release lock and skip.
      await this.releaseLock(result._id);
      return null;
    }
    return {
      _id: result._id,
      exif: { gps: { lat: gps.lat, lng: gps.lng } },
      enrichment_attempts: result.enrichment?.geocode.attempts ?? 0,
    };
  }

  /** Cache lookup → Nominatim call → parse. */
  private async process(
    claim: ClaimedAsset,
  ): Promise<{ place: Place; cacheHit: boolean }> {
    const { lat, lng } = claim.exif.gps;
    const cached = await this.cache.get(lat, lng);
    if (cached) return { place: cached, cacheHit: true };

    const raw = await this.client.reverse(lat, lng);
    const place = parseNominatimResponse(
      raw,
      lat,
      lng,
      GEOCODE_HANDLER_VERSION,
      this.now,
    );
    await this.cache.set(lat, lng, place);
    return { place, cacheHit: false };
  }

  /** Single `updateOne` so the success state is atomic — `place`,
   * `enrichment.geocode.done_at`, and the lock release all flip together. */
  private async complete(claim: ClaimedAsset, place: Place): Promise<void> {
    const c = await this.coll();
    await c.updateOne(
      { _id: claim._id },
      {
        $set: {
          place,
          "enrichment.geocode.done_at": this.now().toISOString(),
          "enrichment.geocode.version": GEOCODE_HANDLER_VERSION,
          "enrichment.geocode.locked_by": null,
          "enrichment.geocode.lease_expires_at": null,
          "enrichment.geocode.last_error": null,
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
      "enrichment.geocode.attempts": nextAttempts,
      "enrichment.geocode.last_error": error,
      "enrichment.geocode.locked_by": null,
      "enrichment.geocode.lease_expires_at": this.now().toISOString(),
    };
    if (exhausted) {
      set["enrichment.geocode.dead_letter_at"] = this.now().toISOString();
    }
    await c.updateOne({ _id: claim._id }, { $set: set });
    return exhausted;
  }

  private async releaseLock(id: AssetDoc["folder_id"]): Promise<void> {
    const c = await this.coll();
    await c.updateOne(
      { _id: id },
      {
        $set: {
          "enrichment.geocode.locked_by": null,
          "enrichment.geocode.lease_expires_at": null,
        },
      },
    );
  }
}
