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
 * A released slot passes straight to the next waiter rather than being freed
 * and re-acquired, so a burst of new arrivals cannot overtake a task already
 * queued.
 */
export class ReadGate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`read gate: limit must be a positive integer, got ${limit}`);
    }
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

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active -= 1;
  }
}
