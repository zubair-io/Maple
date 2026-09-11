/**
 * Workers-status WS broadcaster (#674).
 *
 * One shared timer fans the worker-pipeline status out to every subscribed
 * client, instead of each browser tab independently polling `GET /status`.
 *
 * Every frame is cheap to build (#3491): `computeWorkersStatus()` is one
 * `worker_status` read (registry snapshot + the counts the worker persisted)
 * plus the tiny `worker_config` and migration-state docs — no `countDocuments`
 * on this path at all. What the timer does, besides fanning out, is keep the
 * worker's demand flag fresh (`requestStatusCounts`) so the worker refreshes
 * its persisted counts quickly for as long as ≥1 client is subscribed. With
 * zero subscribers the timer is stopped and the flag lapses, so an idle
 * deployment never spends DB time on display-only counts.
 *
 * The broadcaster is transport-agnostic: a subscriber is just a `send`
 * callback, so `routes/events.ts` wires WS sockets in and unit tests wire
 * plain functions in.
 */

import { child } from '../log.ts';
import { computeWorkersStatus, requestStatusCounts, type WorkersStatusPayload } from './routes.ts';

const log = child('workers:status-broadcast');

/** The WS frame this module emits. */
export interface WorkersStatusFrame {
  type: 'workers-status';
  status: WorkersStatusPayload;
  /** True when `status` carries DB-derived counts the worker has computed;
   * false while the worker has never counted (every count reads 0). Lets the
   * FE show "counting…" instead of a misleading "0 pending". */
  counted: boolean;
  ts: number;
}

type Send = (frame: WorkersStatusFrame) => void;

export const COUNT_INTERVAL_MS = 2000;

class WorkersStatusBroadcaster {
  private readonly subscribers = new Set<Send>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickInFlight = false;
  private lastFrame: WorkersStatusFrame | null = null;

  constructor(
    private readonly computeStatus: () => Promise<WorkersStatusPayload> = computeWorkersStatus,
    private readonly requestCounts: () => Promise<void> = requestStatusCounts,
  ) {}

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  get isCounting(): boolean {
    return this.timer !== null;
  }

  /** Subscribe. A late joiner gets the most recent frame immediately (no DB
   * round-trip) and then rides the shared timer like everyone else. */
  subscribe(send: Send): () => void {
    this.subscribers.add(send);
    if (this.lastFrame && this.timer !== null) {
      try {
        send(this.lastFrame);
      } catch {
        /* a broken subscriber must not break subscribe */
      }
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
    void this.tick();
    this.timer = setInterval(() => void this.tick(), COUNT_INTERVAL_MS);
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.lastFrame = null;
  }

  private async tick(): Promise<void> {
    if (this.subscribers.size === 0) return;
    if (this.tickInFlight) {
      log.debug('workers-status tick already in flight — skipping overlap');
      return;
    }
    this.tickInFlight = true;
    let status: WorkersStatusPayload;
    try {
      await this.requestCounts();
      status = await this.computeStatus();
    } catch (err) {
      log.warn({ err }, 'workers-status tick failed — skipping broadcast');
      return;
    } finally {
      this.tickInFlight = false;
    }
    const frame: WorkersStatusFrame = {
      type: 'workers-status',
      status,
      counted: status.countsAt !== null,
      ts: Date.now(),
    };
    this.lastFrame = frame;
    this.broadcast(frame);
  }

  private broadcast(frame: WorkersStatusFrame): void {
    for (const send of this.subscribers) {
      try {
        send(frame);
      } catch {
        /* one broken socket must not abort the fan-out */
      }
    }
  }

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
