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

  publish(event: AssetChangeWithId): void {
    this.buf.push(event);
    if (this.buf.length > this.capacity) this.buf.shift();
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
   * True when `since` is within the buffer's reach (i.e. we can serve a
   * replay without going to Mongo). An empty buffer is considered
   * always-replayable (no events to miss).
   *
   * The check is `since + 1 >= floor` — if the next event the client
   * needs is cursor `since + 1`, we can serve it as long as the buffer
   * still holds it.
   */
  isCursorReplayable(since: number): boolean {
    if (this.buf.length === 0) return true;
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
