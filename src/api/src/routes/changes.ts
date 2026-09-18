/**
 * /api/changes — asset change feed for the File Provider extension.
 *
 *   GET /api/changes?since=<cursor>&limit=<N>
 *     Polling form. Returns up to N (default 100, max 1000) change rows
 *     where cursor > since.
 *
 *   GET /api/changes/subscribe?since=<cursor>
 *     SSE form (added in task A6). Streams events as they arrive,
 *     prefixed by a replay of buffered events > since.
 */

import { Elysia, sse, t } from 'elysia';
import { listChangesSince } from '../db/changes.repo.ts';
import { getChangeBus, type ChangeBus } from '../runtime/change-bus.ts';
import type { AssetChangeWithId } from '../db/schema.ts';
import { requireFileAccess } from '../auth/middleware.ts';

// Bounded backlog per SSE connection. Mirrors the ChangeBus ring-buffer
// capacity — a client that can't keep up with 10k buffered events is
// already past the point where it could replay from the bus on
// reconnect, so closing the stream and letting the existing 409
// stale-cursor path kick in is the right recovery.
const SSE_QUEUE_LIMIT = 10_000;

// Force every SSE connection to recycle after this lifetime so an
// expired auth token never lives indefinitely behind an open stream.
// The Apple client reconnects cleanly on normal close (no backoff
// penalty), so this is invisible to users.
const SSE_MAX_LIFETIME_MS = 5 * 60_000;

// Keepalive frequency. Sent as a raw SSE comment frame so intermediaries
// don't reap the connection; the Apple parser ignores lines starting
// with ":" per the SSE spec.
const SSE_KEEPALIVE_MS = 15_000;

// Pre-encoded comment frames. Elysia's SSE handler wraps yielded
// strings as `data: <str>\n\n` even when in SSE mode, which the Swift
// parser would treat as a JSON payload and fail to decode. Yielding a
// Uint8Array bypasses the format() step (see enqueueBinaryChunk in
// `elysia/dist/adapter/utils.js`) and writes the raw bytes through.
const SSE_KEEPALIVE_FRAME = new TextEncoder().encode(': keepalive\n\n');
const SSE_STREAM_OPENED_FRAME = new TextEncoder().encode(': stream opened\n\n');

interface ChangePayload {
  cursor: number;
  asset_id: string | null;
  folder_id: string | null;
  kind: string;
  abs_path: string | null;
  /**
   * Path relative to the folder root. Nullable: rows persisted before
   * Phase 6 lack the field, and the defensive `computeRelativePath`
   * branch stores null when absPath doesn't match folder.path. Apple
   * decoder tolerates either shape.
   */
  relative_path: string | null;
  at: string;
}

function asPayload(r: AssetChangeWithId): ChangePayload {
  return {
    cursor: r.cursor,
    asset_id: r.asset_id?.toHexString() ?? null,
    folder_id: r.folder_id?.toHexString() ?? null,
    kind: r.kind,
    abs_path: r.abs_path,
    // Old asset_changes rows pre-date this field; default to null
    // rather than letting Mongo's implicit `undefined` flow through
    // JSON.stringify (which would omit the key entirely).
    relative_path: r.relative_path ?? null,
    at: r.at.toISOString(),
  };
}

/**
 * The cursor a 409 tells the client to resume from.
 *
 * It must be the highest cursor the server knows about, not the highest one
 * still sitting in the ring buffer. Those differ in exactly the case that
 * produces most 409s — a freshly restarted process, whose buffer is empty while
 * its persisted high watermark reflects everything the previous process
 * emitted. Reporting the buffer alone answered `current: 0` there, and 0 is the
 * one value the Apple client cannot use: `ChangeFeedClient` treats it as "no
 * usable cursor" and resets to `since=0`, which trips the same 409 on the next
 * connect and loops. Retention pruning (#3741) makes the empty buffer ordinary
 * rather than restart-only, so the difference stops being a corner case.
 */
function resumeCursor(bus: ChangeBus): number {
  return Math.max(bus.snapshot().at(-1)?.cursor ?? 0, bus.getPersistedHighWatermark());
}

/**
 * Build an SSE-payload object for `sse()`. Elysia's helper formats the
 * `event` / `id` / `data` lines per the SSE spec; `data` may be a string
 * or a JSON-serialisable object.
 */
function sseChangeFrame(ev: AssetChangeWithId): ReturnType<typeof sse> {
  return sse({
    event: 'change',
    id: String(ev.cursor),
    data: asPayload(ev),
  });
}

/**
 * The `since` query parameter as a cursor, or null when it is not one.
 *
 * Both handlers take the same parameter with the same meaning and rejected it
 * with the same 400, so they now read it the same way too. Absent means zero —
 * a client that has never synced starts from the beginning of the journal.
 */
function parseSince(raw: string | undefined): number | null {
  const since = Number.parseInt(raw ?? '0', 10);
  return Number.isFinite(since) && since >= 0 ? since : null;
}

/** What ended a wait: an event arrived, the client left, or nothing happened. */
type WaitOutcome = 'event' | 'abort' | 'keepalive';

/**
 * The buffered events a reconnecting client is owed, and the highest cursor
 * among them — which is the mark the live loop dedupes against, and is `since`
 * itself when the buffer had nothing to replay.
 */
function replaySnapshot(
  bus: ChangeBus,
  since: number,
): { events: AssetChangeWithId[]; replayMax: number } {
  const events = bus.replay({ since });
  return { events, replayMax: events.at(-1)?.cursor ?? since };
}

/**
 * The bounded backlog behind one SSE connection.
 *
 * This is the bookkeeping half of the streaming handler — subscribe, buffer,
 * park until something happens — and it is separable from the generator in a
 * way the replay/subscribe handshake is not: the handshake's ordering is the
 * thing the comments in the route guard, while this is a queue with a lid on
 * it. Pulling it out is what lets the generator read as the sequence of yields
 * it is.
 *
 * The lid matters. A client that cannot keep up with 10k buffered events is
 * already past the point where the bus could replay for it on reconnect, so the
 * backlog is dropped and the stream closed; the client's persisted cursor then
 * falls below the bus floor and the 409 path re-enumerates it. Growing the queue
 * instead would trade a bounded recovery for an unbounded one in the API
 * process's heap.
 */
class SseBacklog {
  private readonly queue: AssetChangeWithId[] = [];
  private readonly unsubscribe: () => void;
  private waiter: ((outcome: 'event') => void) | null = null;
  /** Set once the cap is hit. The stream is finished; the client reconnects. */
  overflowed = false;

  constructor(bus: ChangeBus) {
    this.unsubscribe = bus.subscribe((ev) => this.accept(ev));
  }

  get empty(): boolean {
    return this.queue.length === 0;
  }

  /** Whether this stream should still be serving its client. */
  live(signal: AbortSignal): boolean {
    return !signal.aborted && !this.overflowed;
  }

  /**
   * The next queued event the client has not already been sent, or undefined
   * when the backlog holds none — either because it is empty or because it was
   * dropped on overflow while the caller was parked.
   *
   * Skipping past `replayMax` here rather than in the caller is what closes the
   * replay/subscribe race: an event that landed between subscribing and
   * snapshotting is in both the snapshot and the queue, and was already sent.
   */
  shiftAbove(replayMax: number): AssetChangeWithId | undefined {
    for (let ev = this.queue.shift(); ev !== undefined; ev = this.queue.shift()) {
      if (ev.cursor > replayMax) return ev;
    }
    return undefined;
  }

  /**
   * Park until there is something to do: an event, the client leaving, the
   * keepalive falling due, or the connection's lifetime running out. The last
   * two are one outcome from the loop's point of view — `stop` means return,
   * `keepalive` means write a comment frame and go round again.
   */
  async park(signal: AbortSignal, deadline: number): Promise<'stop' | 'keepalive' | 'event'> {
    const remainingLifetime = deadline - Date.now();
    if (remainingLifetime <= 0) return 'stop';
    const outcome = await this.wait(signal, Math.min(SSE_KEEPALIVE_MS, remainingLifetime));
    return outcome === 'abort' ? 'stop' : outcome;
  }

  /** Resolves when an event arrives, the request aborts, or `ms` elapses. */
  private wait(signal: AbortSignal, ms: number): Promise<WaitOutcome> {
    const event = new Promise<'event'>((resolve) => {
      this.waiter = resolve;
    });
    const aborted = new Promise<'abort'>((resolve) => {
      signal.addEventListener('abort', () => resolve('abort'), { once: true });
    });
    const keepalive = new Promise<'keepalive'>((resolve) =>
      setTimeout(() => resolve('keepalive'), ms),
    );
    return Promise.race<WaitOutcome>([event, aborted, keepalive]);
  }

  close(): void {
    this.unsubscribe();
  }

  private accept(ev: AssetChangeWithId): void {
    if (this.overflowed) return;
    if (this.queue.length >= SSE_QUEUE_LIMIT) {
      this.overflowed = true;
      this.queue.length = 0;
    } else {
      this.queue.push(ev);
    }
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.('event');
  }
}

// The change feed exists for the File Provider extension — a filesystem
// surface, so file-access-gated (#2893).
export const changesRoutes = new Elysia({ prefix: '/api/changes' })
  .use(requireFileAccess)
  .get(
    '/',
    async ({ query, set }) => {
      const since = parseSince(query.since);
      if (since === null) {
        set.status = 400;
        return { error: 'since must be a non-negative integer' };
      }
      // Validate `limit` rather than coercing NaN through Math.max — a
      // garbage value like `?limit=abc` would otherwise produce NaN ->
      // Math.max(NaN, 1) === NaN -> Math.min(NaN, 1000) === NaN, and the
      // Mongo driver throws a 500 deep inside the query.
      const rawLimit = query.limit;
      let limit = 100;
      if (rawLimit !== undefined) {
        const parsed = Number.parseInt(rawLimit, 10);
        if (!Number.isFinite(parsed) || parsed < 1) {
          set.status = 400;
          return { error: 'limit must be a positive integer' };
        }
        limit = Math.min(parsed, 1000);
      }
      const rows = await listChangesSince(undefined, { since, limit });
      const payload = rows.map(asPayload);
      const next_cursor = rows.length > 0 ? rows[rows.length - 1]!.cursor : undefined;
      return { changes: payload, next_cursor };
    },
    {
      query: t.Object({
        since: t.Optional(t.String()),
        limit: t.Optional(t.String()),
      }),
    },
  )
  .get(
    '/subscribe',
    // Tracked by #3780, which is what retires this line rather than leaving it
    // open-ended. The handler is at 10 cyclomatic / 15 cognitive after the
    // backlog, the park-and-wait race, the `since` parsing and the replay
    // snapshot came out into named helpers — both inside fallow's limits. What
    // still trips the gate is CRAP 31.6 against a ceiling of 30, and CRAP is
    // the one metric fallow *estimates* when no coverage file is supplied,
    // which the API's audit job does not supply. This generator is covered by
    // the seven tests in `changes.sse.test.ts` and the four in
    // `change-feed.delta-sync.test.ts`; at its real coverage the score is
    // nowhere near the ceiling. Splitting further would mean cutting the
    // replay/subscribe handshake, whose ordering is exactly what the numbered
    // comments below exist to protect.
    // fallow-ignore-next-line complexity
    async function* ({ query, set, request }) {
      const since = parseSince(query.since);
      if (since === null) {
        set.status = 400;
        return { error: 'since must be a non-negative integer' };
      }
      const bus = getChangeBus();
      if (!bus.isCursorReplayable(since)) {
        set.status = 409;
        return { error: 'cursor too old', current: resumeCursor(bus) };
      }

      set.headers['content-type'] = 'text/event-stream';
      set.headers['cache-control'] = 'no-cache, no-transform';
      set.headers['connection'] = 'keep-alive';
      // Disable Nginx-style proxy buffering — SSE is incompatible with it.
      set.headers['x-accel-buffering'] = 'no';

      // 1. Subscribe + snapshot BEFORE the first yield. The previous
      //    iteration of this code yielded the open frame first, which
      //    let the generator's first suspension happen between the
      //    isCursorReplayable check and the subscribe + replay
      //    handshake. If enough events arrived during that suspension,
      //    the buffer floor could advance past `since` and the later
      //    `bus.replay({ since })` would silently omit them. We do all
      //    the bookkeeping synchronously before any await/yield so the
      //    seam window is empty.
      const backlog = new SseBacklog(bus);

      // 2. Snapshot the replay. Do this AFTER subscribe so a publish
      //    that lands between subscribe and snapshot will be in both
      //    the live queue AND the snapshot — the `cursor <= replayMax`
      //    dedupe in the live loop drops the duplicate.
      const { events: snapshot, replayMax } = replaySnapshot(bus, since);

      // 3. Re-validate the floor: while we were setting up the
      //    subscription the buffer floor could have advanced past
      //    `since` (high-throughput burst). If so, abort — the client
      //    would otherwise silently miss events between
      //    `since + 1` and `floor - 1`. We unsubscribe and close 409.
      if (!bus.isCursorReplayable(since)) {
        backlog.close();
        set.status = 409;
        return { error: 'cursor too old', current: resumeCursor(bus) };
      }

      // 4. Now safe to flush headers. Yield the open frame as raw bytes
      //    so Elysia's SSE handler doesn't wrap them in `data:`.
      yield SSE_STREAM_OPENED_FRAME;

      // 5. Drain the replay snapshot.
      for (const ev of snapshot) {
        yield sseChangeFrame(ev);
      }

      // Lifetime cap — once we hit it, close cleanly so the client
      // immediately reconnects (no backoff penalty on clean return).
      const deadline = Date.now() + SSE_MAX_LIFETIME_MS;

      try {
        while (backlog.live(request.signal)) {
          if (backlog.empty) {
            // Race keepalive vs next event vs abort vs lifetime.
            const outcome = await backlog.park(request.signal, deadline);
            if (outcome === 'stop') break;
            if (outcome === 'keepalive') {
              // Raw SSE comment frame — Uint8Array bypasses Elysia's
              // `data:` wrapping (see SSE_KEEPALIVE_FRAME comment).
              yield SSE_KEEPALIVE_FRAME;
              continue;
            }
          }
          // Undefined when everything queued was already replayed, or when the
          // backlog overflowed while we were parked and dropped its queue —
          // `live()` ends the stream on the way round in that case.
          const ev = backlog.shiftAbove(replayMax);
          if (ev === undefined) continue;
          yield sseChangeFrame(ev);
        }
      } finally {
        backlog.close();
      }
    },
    {
      query: t.Object({
        since: t.Optional(t.String()),
      }),
    },
  );
