/**
 * Bounded async channel for pipeline stages.
 *
 * A minimal MPSC queue with a fixed capacity. `push()` awaits when the
 * buffer is full so upstream producers exert backpressure on downstream
 * consumers. `take()` returns an async iterator; multiple consumers
 * share one channel and each `next()` call hands a single item to one
 * awaiter. Closing drains without blocking.
 */

export interface BoundedQueue<T> {
  /** Push an item to the TAIL (FIFO). Resolves when a slot is free.
   * Rejects if the queue is closed. */
  push(item: T): Promise<void>;
  /** Push an item to the HEAD — jumps the queue. Used by the rescan
   * path to surface a user-clicked subtree ahead of an existing
   * backlog. Same close + backpressure semantics as `push`. When the
   * buffer is full, the prepended item enters at the FRONT of the
   * pending-pushers list, so it's the next one drained. */
  pushFront(item: T): Promise<void>;
  /** Consume items forever (until close()). Each item goes to exactly one consumer. */
  take(): AsyncIterableIterator<T>;
  /** Signal end-of-input. Pending takers receive `done: true`. */
  close(): void;
  /** Current number of buffered (not-yet-consumed) items. */
  readonly depth: number;
  /** True if close() has been called. */
  readonly closed: boolean;
  /** Capacity (max buffered items). */
  readonly capacity: number;
}

type Waiter<T> =
  | { kind: "taker"; resolve: (v: IteratorResult<T>) => void }
  | { kind: "pusher"; item: T; resolve: () => void; reject: (err: Error) => void };

export function createBoundedQueue<T>(capacity: number): BoundedQueue<T> {
  if (capacity < 1) throw new Error("BoundedQueue: capacity must be >= 1");

  const buf: T[] = [];
  const takers: Array<(v: IteratorResult<T>) => void> = [];
  const pushers: Array<{ item: T; resolve: () => void; reject: (err: Error) => void }> = [];
  let closed = false;

  function push(item: T): Promise<void> {
    if (closed) return Promise.reject(new Error("BoundedQueue: push on closed queue"));

    // Hand directly to a waiting taker if any.
    const taker = takers.shift();
    if (taker) {
      taker({ value: item, done: false });
      return Promise.resolve();
    }

    if (buf.length < capacity) {
      buf.push(item);
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      pushers.push({ item, resolve, reject });
    });
  }

  function pushFront(item: T): Promise<void> {
    if (closed) return Promise.reject(new Error("BoundedQueue: pushFront on closed queue"));

    // Same fast paths as push: a waiting taker takes the item immediately.
    const taker = takers.shift();
    if (taker) {
      taker({ value: item, done: false });
      return Promise.resolve();
    }

    if (buf.length < capacity) {
      // Front of the buffer — next take() returns this item.
      buf.unshift(item);
      return Promise.resolve();
    }

    // Buffer full — jump the head of the pending-pushers queue too, so this
    // item is the FIRST to land in the buffer when a slot frees up.
    return new Promise<void>((resolve, reject) => {
      pushers.unshift({ item, resolve, reject });
    });
  }

  function close(): void {
    if (closed) return;
    closed = true;
    // Drain all takers with done.
    while (takers.length > 0) {
      const t = takers.shift()!;
      t({ value: undefined as never, done: true });
    }
    // Reject pending pushers.
    while (pushers.length > 0) {
      const p = pushers.shift()!;
      p.reject(new Error("BoundedQueue: closed while awaiting push"));
    }
  }

  async function next(): Promise<IteratorResult<T>> {
    if (buf.length > 0) {
      const item = buf.shift()!;
      // If a pusher was blocked, move its item into the buffer slot we just vacated.
      const pusher = pushers.shift();
      if (pusher) {
        buf.push(pusher.item);
        pusher.resolve();
      }
      return { value: item, done: false };
    }

    // Buffer empty. If a pusher is waiting (capacity == 0 is impossible; this
    // is a defensive path), hand its item directly.
    const pusher = pushers.shift();
    if (pusher) {
      pusher.resolve();
      return { value: pusher.item, done: false };
    }

    if (closed) return { value: undefined as never, done: true };

    return new Promise<IteratorResult<T>>((resolve) => {
      takers.push(resolve);
    });
  }

  function take(): AsyncIterableIterator<T> {
    const it: AsyncIterableIterator<T> = {
      next,
      return(value?: T): Promise<IteratorResult<T>> {
        return Promise.resolve({ value: value as T, done: true });
      },
      [Symbol.asyncIterator]() {
        return it;
      },
    };
    return it;
  }

  return {
    push,
    pushFront,
    take,
    close,
    get depth(): number {
      return buf.length;
    },
    get closed(): boolean {
      return closed;
    },
    capacity,
  };
}

/**
 * Pipeline stage identifiers (ordered source → sink).
 */
export type Stage = "discover" | "hash" | "exif" | "thumb" | "ai" | "mongo";

/**
 * Concurrency (pool size) per stage. Derived from host CPU count, clamped
 * to sensible floors so tiny VMs still get a worker per stage.
 *
 * Spec §08: discover=4, hash=num_cpus/2, exif=num_cpus,
 * thumb=num_cpus-2, ai=1-2 (stub), mongo=8.
 */
export function poolSizes(): Record<Stage, number> {
  const cpus = Math.max(1, Number(navigator.hardwareConcurrency ?? 1));
  return {
    discover: 4,
    hash: Math.max(1, Math.floor(cpus / 2)),
    // exif uses exifr which awaits async file I/O — safe to scale with cores.
    exif: Math.max(1, Math.floor(cpus / 2)),
    // thumb calls into raw-ffi via bun:ffi. Those symbol calls are SYNCHRONOUS
    // from JS — they block the main thread for the duration of the Rust work
    // (~50–200 ms per RAW). Running multiple workers in parallel doesn't add
    // real throughput (they serialize on the single JS thread) but it DOES
    // starve HTTP handlers of event-loop time, eventually causing /api/*
    // request timeouts under sustained indexer load. Cap at 1 by default
    // for the safest "indexer + responsive UI" balance. Live-tunable via
    // PUT /api/indexer/config when you know the API is idle.
    thumb: 1,
    ai: Math.min(2, Math.max(1, Math.floor(cpus / 4))),
    mongo: 8,
  };
}

/**
 * Channel capacity per stage. Keep these modest so backpressure kicks in
 * before queues bloat into unbounded memory.
 */
export const CHANNEL_CAPACITY: Record<Stage, number> = {
  discover: 256,
  hash: 256,
  exif: 256,
  thumb: 128,
  ai: 128,
  mongo: 256,
};
