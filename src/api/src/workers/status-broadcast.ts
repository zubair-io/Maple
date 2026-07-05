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

import { deriveBatchSize } from './run-stage.ts';
import { computeWorkersStatus, type StageStatusRow, type WorkersStatusPayload } from './routes.ts';
import { readWorkerStatus } from './worker-status.repo.ts';
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
 * Build a stage-status payload from the cross-process `worker_status` Mongo
 * snapshot. `pending`, `ready`, `blocked`, `dead`, and `damaged` are zeroed
 * (no count queries run); `config` is null because it lives in Mongo.
 * Used for the immediate on-subscribe push so the client paints without
 * waiting for the first full counted tick.
 *
 * Workers run in a separate child process; the in-process `stageRegistry` is
 * empty in the API process — read `worker_status` instead.
 */
export async function cheapStatus(): Promise<WorkersStatusPayload> {
  const snap = await readWorkerStatus();
  const statuses = snap?.statuses ?? {};
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
  // No count queries in the cheap path — the real counts land on the next
  // counted tick (computeWorkersStatus). Zero until then, like the other counts.
  return { stages, damaged: 0, newlyHiddenTotal: 0 };
}

class WorkersStatusBroadcaster {
  private readonly subscribers = new Set<Send>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** True while a `tick()` is mid-flight. `setInterval` fires on a fixed
   * cadence regardless of whether the previous async tick has settled, so a
   * count pass that runs longer than `COUNT_INTERVAL_MS` would otherwise stack
   * up — multiple `countDocuments` fan-outs in flight at once, defeating the
   * shared-count guarantee. The guard makes overlapping ticks a no-op. */
  private tickInFlight = false;

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
   * Add a subscriber. Kicks off an async cheap snapshot from worker_status
   * Mongo so the client paints quickly without waiting for the first full
   * counted tick, then arms the shared count timer if it wasn't already
   * running. Returns an unsubscribe fn.
   */
  subscribe(send: Send): () => void {
    this.subscribers.add(send);
    // Fire-and-forget — the cheap push is now async (reads worker_status).
    // The subscriber gets the frame as soon as the Mongo read resolves.
    void cheapStatus()
      .then((status) => {
        send({
          type: 'workers-status',
          status,
          counted: false,
          ts: Date.now(),
        });
      })
      .catch(() => {
        /* socket may already be gone or DB unavailable */
      });
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
    // In-flight guard: if a previous count pass hasn't settled yet, skip this
    // one rather than letting two `computeStatus()` fan-outs overlap.
    if (this.tickInFlight) {
      log.debug('workers-status count tick already in flight — skipping overlap');
      return;
    }
    this.tickInFlight = true;
    let status: WorkersStatusPayload;
    try {
      status = await this.computeStatus();
    } catch (err) {
      log.warn({ err }, 'workers-status count tick failed — skipping broadcast');
      return;
    } finally {
      this.tickInFlight = false;
    }
    this.broadcast({
      type: 'workers-status',
      status,
      counted: true,
      ts: Date.now(),
    });
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
