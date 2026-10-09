/**
 * A counting gate: at most `limit` tasks run at once, the rest wait in arrival
 * order.
 *
 * The pool uses it to keep a lane of bulk reads — a facet request's dozen
 * aggregations — from occupying every reader at once (#4413). Requests are
 * handed to a reader the moment they are issued, so without a gate in front of
 * them thirteen facet statements fill every reader's queue and a grid page
 * issued a moment later waits behind all of them.
 *
 * The limit is read afresh on every admission rather than fixed at
 * construction, because the pool's capacity is not fixed: a dead or restarting
 * reader takes no reads, and a lane sized from the configured width would hand
 * the survivors every slot it was meant to leave free. A shrinking limit never
 * cancels a task already running — it only stops admitting until enough have
 * finished. A growing one is noticed on the next release, or at once when the
 * owner calls {@link admitWaiting}.
 *
 * Arrivals queue behind anyone already waiting, so a burst of new calls cannot
 * overtake a task queued before them.
 */
export class ReadGate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly capacity: () => number) {}

  /** How many tasks may run at once right now. */
  get limit(): number {
    const limit = this.capacity();
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`read gate: limit must be a positive integer, got ${limit}`);
    }
    return limit;
  }

  /** Tasks currently holding a slot. */
  get running(): number {
    return this.active;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  /** Admit as many waiters as the current limit allows. */
  admitWaiting(): void {
    while (this.waiting.length > 0 && this.active < this.limit) {
      this.active += 1;
      this.waiting.shift()!();
    }
  }

  private acquire(): Promise<void> {
    if (this.waiting.length === 0 && this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    this.active -= 1;
    this.admitWaiting();
  }
}
