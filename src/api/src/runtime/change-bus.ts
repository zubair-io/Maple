/**
 * In-process pub/sub for asset change events with a bounded ring buffer.
 *
 * - The HTTP SSE route (changes.ts) subscribes for fan-out.
 * - Reconnecting clients ask for replay-since-cursor; we serve from the
 *   buffer when the cursor is recent enough (no Mongo round-trip).
 * - When the requested cursor is older than the buffer's floor, the SSE
 *   route returns 409 and the client falls back to a full re-enumeration.
 *
 * Capacity = 10,000 events. At typical mutation rates (handfuls/sec) that
 * covers minutes-to-hours of history — plenty for clients reconnecting
 * after a transient network drop.
 */

import { EventEmitter } from "node:events";
import type { AssetChangeWithId } from "../db/schema.ts";

export interface ChangeBusOptions {
  capacity: number;
}

export class ChangeBus {
  private readonly capacity: number;
  /** Ring buffer of recent events, oldest first. */
  private readonly buf: AssetChangeWithId[] = [];
  private readonly emitter = new EventEmitter();

  constructor(opts: ChangeBusOptions) {
    this.capacity = Math.max(1, opts.capacity);
    // Allow many subscribers — every SSE connection adds one.
    this.emitter.setMaxListeners(0);
  }

  /**
   * Publish an event. Inserts into the buffer in cursor order — handlers
   * that allocate cursors concurrently and then race on the Mongo insert
   * can deliver `publish()` out of cursor order, but the buffer must
   * always be cursor-sorted so `snapshot()` / `replay()` / floor checks
   * are deterministic. Linear scan for the insert position is fine at
   * 10k capacity (worst case: a few µs).
   *
   * Returns silently if the event's cursor already exists in the buffer
   * (idempotency for the change-feed tailer that may replay rows the
   * in-process publisher already enqueued).
   */
  publish(event: AssetChangeWithId): void {
    // Fast path — buffer empty or strictly increasing (the common case).
    const last = this.buf.length > 0 ? this.buf[this.buf.length - 1]! : null;
    if (last === null || event.cursor > last.cursor) {
      this.buf.push(event);
    } else if (event.cursor === last.cursor) {
      return; // dedupe — already in buffer
    } else {
      // Out-of-order arrival — binary-insert. Linear search reads cleanly
      // and stays comfortably fast at this capacity.
      let i = this.buf.length;
      while (i > 0 && this.buf[i - 1]!.cursor > event.cursor) i--;
      if (i > 0 && this.buf[i - 1]!.cursor === event.cursor) return;
      this.buf.splice(i, 0, event);
    }
    while (this.buf.length > this.capacity) this.buf.shift();
    this.emitter.emit("change", event);
  }

  /** Snapshot of the current buffer in cursor order. */
  snapshot(): AssetChangeWithId[] {
    return this.buf.slice();
  }

  replay(query: { since: number }): AssetChangeWithId[] {
    return this.buf.filter((e) => e.cursor > query.since);
  }

  /**
   * Lowest cursor currently held in the buffer, or null if empty.
   */
  bufferFloor(): number | null {
    return this.buf.length === 0 ? null : this.buf[0]!.cursor;
  }

  /**
   * Persisted high-watermark — set by the API process at boot from
   * `highestCursor()` in the asset_changes collection. The bus uses this
   * to refuse replay when the in-memory buffer is empty but the
   * persistent store has events the client never saw (post-restart
   * recovery). Updated by the tailer as it republishes Mongo rows so
   * the bus stays in sync.
   */
  private persistedHighWatermark = 0;

  /** Set the persisted high-watermark (called by the tailer / boot). */
  setPersistedHighWatermark(cursor: number): void {
    if (cursor > this.persistedHighWatermark) {
      this.persistedHighWatermark = cursor;
    }
  }

  getPersistedHighWatermark(): number {
    return this.persistedHighWatermark;
  }

  /**
   * True when `since` is within the buffer's reach (i.e. we can serve a
   * replay without going to Mongo).
   *
   * - When the buffer is non-empty: `since + 1 >= floor`.
   * - When the buffer is empty: replayable iff the client is up-to-date
   *   with the persisted high-watermark. Old buffers post-restart are
   *   NOT replayable — the client has missed everything the prior
   *   process delivered, and would otherwise silently get nothing here.
   */
  isCursorReplayable(since: number): boolean {
    if (this.buf.length === 0) {
      return since >= this.persistedHighWatermark;
    }
    const floor = this.buf[0]!.cursor;
    return since + 1 >= floor;
  }

  subscribe(listener: (event: AssetChangeWithId) => void): () => void {
    this.emitter.on("change", listener);
    return () => {
      this.emitter.off("change", listener);
    };
  }
}

/** Process-wide singleton — created once on first access. */
let _instance: ChangeBus | null = null;
export function getChangeBus(): ChangeBus {
  if (!_instance) _instance = new ChangeBus({ capacity: 10_000 });
  return _instance;
}

/** Test helper. Do not call in production. */
export function __resetChangeBusForTests(): void {
  _instance = null;
}
