/**
 * Workers-status WS broadcaster (#674).
 *
 * One shared timer fans the worker-pipeline status out to every subscribed
 * client, instead of each browser tab independently polling `GET /status`
 * (which costs ~4×nStages `countDocuments` per tab per tick).
 *
 * Split of concerns:
 *   - CHEAP registry fields (status / inFlight / throughput / lastError) come
 *     straight from the in-process `stageRegistry` — no DB, no gating. A client
 *     gets one immediately on subscribe so its UI paints without waiting.
 *   - EXPENSIVE counts (pending / ready / blocked / dead) are the
 *     `countDocuments` half. They run ONLY while ≥1 client is subscribed, on a
 *     single shared ~2s timer, and the result is broadcast ONCE to all
 *     subscribers. With zero subscribers the timer is stopped, so the counts
 *     never run. Reuses the 2s cache in `routes.ts` (`computeWorkersStatus`).
 *
 * The broadcaster is transport-agnostic: a subscriber is just a `send`
 * callback, so `routes/events.ts` wires WS sockets in and unit tests wire
 * plain functions in.
 */

import { stageRegistry } from './registry.ts';
import { deriveBatchSize } from './run-stage.ts';
import { computeWorkersStatus, type StageStatusRow, type WorkersStatusPayload } from './routes.ts';
import { child } from '../log.ts';

const log = child('workers:status-broadcast');

/** The WS frame this module emits. */
export interface WorkersStatusFrame {
  type: 'workers-status';
  status: WorkersStatusPayload;
  /** True when `status` carries fresh DB-derived counts; false when it's a
   * cheap registry-only snapshot (counts zeroed/stale). Lets the FE avoid
   * flashing "0 pending" before the first counted tick lands. */
  counted: boolean;
  ts: number;
}

type Send = (frame: WorkersStatusFrame) => void;

/** ~2s cadence for the expensive DB counts — matches the old FE poll interval
 * and the `STATUS_CACHE_TTL_MS` in routes.ts. */
export const COUNT_INTERVAL_MS = 2000;

/**
 * Build a cheap, DB-free status payload from the registry alone. `pending`,
 * `ready`, `blocked`, and `dead` are zeroed (no counts run); `config` is null
 * because it lives in Mongo. Used for the immediate on-subscribe push.
 */
export function cheapStatus(): WorkersStatusPayload {
  const statuses = stageRegistry.statuses();
  const stages: StageStatusRow[] = Object.entries(statuses).map(([name, s]) => ({
    name,
    status: s.status,
    inFlight: s.inFlight,
    configured: 0,
    pending: 0,
    ready: 0,
    blocked: 0,
    dead: 0,
    throughput: s.throughput,
    lastError: s.lastError,
    config: null,
    batchSize: deriveBatchSize(0),
  }));
  return { stages };
}

class WorkersStatusBroadcaster {
  private readonly subscribers = new Set<Send>();
  private timer: ReturnType<typeof setInterval> | null = null;

  /**
   * Source of the expensive counted payload. Defaults to the real
   * `computeWorkersStatus` (DB + 2s cache); tests inject a fake so the gating
   * and fan-out can be exercised without a live Mongo.
   */
  constructor(
    private readonly computeStatus: () => Promise<WorkersStatusPayload> = computeWorkersStatus,
  ) {}

  /** Number of live subscribers — exposed for tests / diagnostics. */
  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /** Whether the shared count timer is currently armed. */
  get isCounting(): boolean {
    return this.timer !== null;
  }

  /**
   * Add a subscriber. Immediately sends a cheap registry-only snapshot so the
   * client paints without waiting for the first counted tick, then arms the
   * shared count timer if it wasn't already running. Returns an unsubscribe fn.
   */
  subscribe(send: Send): () => void {
    this.subscribers.add(send);
    try {
      send({ type: 'workers-status', status: cheapStatus(), counted: false, ts: Date.now() });
    } catch {
      /* socket may already be gone */
    }
    this.ensureTimer();
    return () => this.unsubscribe(send);
  }

  private unsubscribe(send: Send): void {
    this.subscribers.delete(send);
    if (this.subscribers.size === 0) this.stopTimer();
  }

  private ensureTimer(): void {
    if (this.timer !== null) return;
    // Fire one counted tick right away so the first subscriber doesn't wait a
    // full interval for real counts, then settle into the shared cadence.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), COUNT_INTERVAL_MS);
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run the expensive counts once (via the shared 2s cache) and broadcast a
   * single counted frame to every subscriber. Guarded so a tick that races a
   * full unsubscribe does no DB work.
   */
  private async tick(): Promise<void> {
    if (this.subscribers.size === 0) return;
    let status: WorkersStatusPayload;
    try {
      status = await this.computeStatus();
    } catch (err) {
      log.warn({ err }, 'workers-status count tick failed — skipping broadcast');
      return;
    }
    this.broadcast({ type: 'workers-status', status, counted: true, ts: Date.now() });
  }

  private broadcast(frame: WorkersStatusFrame): void {
    for (const send of this.subscribers) {
      try {
        send(frame);
      } catch {
        // A dead socket: the WS close handler removes it. Don't let one bad
        // send abort the fan-out to the rest.
      }
    }
  }

  /** Test-only: run a single counted tick now (awaits the broadcast). */
  async _tickForTests(): Promise<void> {
    await this.tick();
  }

  /** Test-only: drop all subscribers and stop the timer. */
  _resetForTests(): void {
    this.subscribers.clear();
    this.stopTimer();
  }
}

export { WorkersStatusBroadcaster };
export const workersStatusBroadcaster = new WorkersStatusBroadcaster();
