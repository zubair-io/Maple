/**
 * ChangeFeedTailer — bridges Mongo-persisted `asset_changes` rows to the
 * in-process ChangeBus.
 *
 * Why this exists: worker stages run in CHILD processes spawned by the
 * supervisor. When a worker calls `recordAndPublishAssetChange` the
 * Mongo insert succeeds (visible to every process) but the
 * `getChangeBus().publish()` only fires on the child's local bus —
 * the parent API process (where SSE clients are connected) never sees
 * it. Without the tailer, every worker-emitted change is invisible to
 * the File Provider extension.
 *
 * Strategy: every `intervalMs`, query `asset_changes` for rows with
 * `cursor > localMax` and republish each via the bus's idempotent
 * `publish()`. The bus dedupes by cursor so events that ALSO came in
 * through the in-process route (e.g. an XMP write from the same API
 * process) are not delivered twice.
 *
 * The tailer is also the source of truth for the bus's persisted
 * high-watermark — it bumps the watermark on every batch so the SSE
 * 409 path can refuse stale clients after a server restart even when
 * the in-memory buffer hasn't been populated yet.
 */

import { child as childLogger } from "../log.ts";
import { assetChangesCollection } from "../db/client.ts";
import { highestCursor } from "../db/changes.repo.ts";
import { getChangeBus } from "./change-bus.ts";
import type { AssetChangeWithId } from "../db/schema.ts";

const log = childLogger("change-feed-tailer");

export interface ChangeFeedTailerOptions {
  /** Polling interval in ms. Default 500ms — keeps SSE latency under
   * one second on average without hammering Mongo. */
  intervalMs?: number;
  /** Max rows per tick. Caps a backlog burst so a busy worker batch
   * doesn't translate into a single giant query. Default 500. */
  batchSize?: number;
}

export class ChangeFeedTailer {
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private localMax = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;

  constructor(opts: ChangeFeedTailerOptions = {}) {
    this.intervalMs = Math.max(50, opts.intervalMs ?? 500);
    this.batchSize = Math.max(1, opts.batchSize ?? 500);
  }

  /**
   * Start the tailer. Initialises `localMax` from Mongo's current high
   * watermark so we don't re-publish historical rows on boot, sets the
   * bus's persisted high-watermark to the same value, then schedules
   * the polling loop.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    try {
      this.localMax = await highestCursor();
      getChangeBus().setPersistedHighWatermark(this.localMax);
      log.info({ localMax: this.localMax }, "tailer started");
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : err },
        "tailer boot: highestCursor failed; starting from 0",
      );
      this.localMax = 0;
    }
    this.scheduleNext();
  }

  /** Stop polling. Safe to call multiple times. */
  stop(): void {
    this.stopped = true;
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run one tick. Public for tests — production code uses the timer.
   * Returns the number of rows republished.
   */
  async tickOnce(): Promise<number> {
    const coll = await assetChangesCollection();
    const rows = (await coll
      .find({ cursor: { $gt: this.localMax } })
      .sort({ cursor: 1 })
      .limit(this.batchSize)
      .toArray()) as AssetChangeWithId[];
    if (rows.length === 0) return 0;
    const bus = getChangeBus();
    for (const r of rows) {
      // Bus publish() is cursor-idempotent — workers that happened to
      // share the API process bus won't get their events doubled here.
      bus.publish(r);
    }
    this.localMax = rows[rows.length - 1]!.cursor;
    bus.setPersistedHighWatermark(this.localMax);
    return rows.length;
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tickOnce()
        .catch((err) => {
          log.error(
            { err: err instanceof Error ? err.message : err },
            "tick failed",
          );
        })
        .finally(() => this.scheduleNext());
    }, this.intervalMs);
  }
}

// Process-wide singleton.
let _instance: ChangeFeedTailer | null = null;

export function getChangeFeedTailer(): ChangeFeedTailer {
  if (!_instance) _instance = new ChangeFeedTailer();
  return _instance;
}

/** Test helper. */
export function __resetChangeFeedTailerForTests(): void {
  if (_instance) _instance.stop();
  _instance = null;
}
