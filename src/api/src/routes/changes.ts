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

import { Elysia, sse, t } from "elysia";
import { listChangesSince } from "../db/changes.repo.ts";
import { getChangeBus } from "../runtime/change-bus.ts";
import type { AssetChangeWithId } from "../db/schema.ts";

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
const SSE_KEEPALIVE_FRAME = new TextEncoder().encode(": keepalive\n\n");
const SSE_STREAM_OPENED_FRAME = new TextEncoder().encode(": stream opened\n\n");

interface ChangePayload {
  cursor: number;
  asset_id: string | null;
  folder_id: string | null;
  kind: string;
  abs_path: string | null;
  at: string;
}

function asPayload(r: AssetChangeWithId): ChangePayload {
  return {
    cursor: r.cursor,
    asset_id: r.asset_id?.toHexString() ?? null,
    folder_id: r.folder_id?.toHexString() ?? null,
    kind: r.kind,
    abs_path: r.abs_path,
    at: r.at.toISOString(),
  };
}

/**
 * Build an SSE-payload object for `sse()`. Elysia's helper formats the
 * `event` / `id` / `data` lines per the SSE spec; `data` may be a string
 * or a JSON-serialisable object.
 */
function sseChangeFrame(ev: AssetChangeWithId): ReturnType<typeof sse> {
  return sse({
    event: "change",
    id: String(ev.cursor),
    data: asPayload(ev),
  });
}

export const changesRoutes = new Elysia({ prefix: "/api/changes" })
  .get(
    "/",
    async ({ query, set }) => {
      const since = Number.parseInt(query.since ?? "0", 10);
      if (!Number.isFinite(since) || since < 0) {
        set.status = 400;
        return { error: "since must be a non-negative integer" };
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
          return { error: "limit must be a positive integer" };
        }
        limit = Math.min(parsed, 1000);
      }
      const rows = await listChangesSince(undefined, { since, limit });
      const payload = rows.map(asPayload);
      const next_cursor =
        rows.length > 0 ? rows[rows.length - 1]!.cursor : undefined;
      return { changes: payload, next_cursor };
    },
    {
      query: t.Object({
        since: t.Optional(t.String()),
        limit: t.Optional(t.String()),
      }),
    }
  )
  .get(
    "/subscribe",
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async function* ({ query, set, request }) {
      const since = Number.parseInt(query.since ?? "0", 10);
      if (!Number.isFinite(since) || since < 0) {
        set.status = 400;
        return { error: "since must be a non-negative integer" };
      }
      const bus = getChangeBus();
      if (!bus.isCursorReplayable(since)) {
        set.status = 409;
        const current = bus.snapshot().at(-1)?.cursor ?? 0;
        return { error: "cursor too old", current };
      }

      set.headers["content-type"] = "text/event-stream";
      set.headers["cache-control"] = "no-cache, no-transform";
      set.headers["connection"] = "keep-alive";
      // Disable Nginx-style proxy buffering — SSE is incompatible with it.
      set.headers["x-accel-buffering"] = "no";

      // 1. Subscribe + snapshot BEFORE the first yield. The previous
      //    iteration of this code yielded the open frame first, which
      //    let the generator's first suspension happen between the
      //    isCursorReplayable check and the subscribe + replay
      //    handshake. If enough events arrived during that suspension,
      //    the buffer floor could advance past `since` and the later
      //    `bus.replay({ since })` would silently omit them. We do all
      //    the bookkeeping synchronously before any await/yield so the
      //    seam window is empty.
      const queue: AssetChangeWithId[] = [];
      let queueOverflow = false;
      let waiter: ((v: "event") => void) | null = null;
      const unsub = bus.subscribe((ev) => {
        if (queueOverflow) return;
        if (queue.length >= SSE_QUEUE_LIMIT) {
          // Stuck client — bound the backlog and force a reconnect.
          // Dropping the queue means the client's persisted cursor will
          // likely be below the bus floor on reconnect, which triggers
          // the existing 409 path → working-set re-enumeration.
          queueOverflow = true;
          queue.length = 0;
          if (waiter) {
            waiter("event");
            waiter = null;
          }
          return;
        }
        queue.push(ev);
        if (waiter) {
          waiter("event");
          waiter = null;
        }
      });

      // 2. Snapshot the replay. Do this AFTER subscribe so a publish
      //    that lands between subscribe and snapshot will be in both
      //    the live queue AND the snapshot — the `cursor <= replayMax`
      //    dedupe in the live loop drops the duplicate.
      const snapshot = bus.replay({ since });
      const replayMax = snapshot.at(-1)?.cursor ?? since;

      // 3. Re-validate the floor: while we were setting up the
      //    subscription the buffer floor could have advanced past
      //    `since` (high-throughput burst). If so, abort — the client
      //    would otherwise silently miss events between
      //    `since + 1` and `floor - 1`. We unsubscribe and close 409.
      if (!bus.isCursorReplayable(since)) {
        unsub();
        set.status = 409;
        const current = bus.snapshot().at(-1)?.cursor ?? 0;
        return { error: "cursor too old", current };
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
        while (!request.signal.aborted) {
          if (queueOverflow) break;
          if (queue.length === 0) {
            const remainingLifetime = deadline - Date.now();
            if (remainingLifetime <= 0) break;
            const lifetimeMs = Math.min(SSE_KEEPALIVE_MS, remainingLifetime);
            // Race keepalive vs next event vs abort vs lifetime.
            const aborted = new Promise<"abort">((resolve) => {
              const onAbort = (): void => resolve("abort");
              request.signal.addEventListener("abort", onAbort, { once: true });
            });
            const event = new Promise<"event">((resolve) => {
              waiter = resolve;
            });
            const keepalive = new Promise<"keepalive">((resolve) =>
              setTimeout(() => resolve("keepalive"), lifetimeMs)
            );
            const result = await Promise.race([event, keepalive, aborted]);
            if (result === "abort") break;
            if (result === "keepalive") {
              // Raw SSE comment frame — Uint8Array bypasses Elysia's
              // `data:` wrapping (see SSE_KEEPALIVE_FRAME comment).
              yield SSE_KEEPALIVE_FRAME;
              continue;
            }
          }
          if (queueOverflow) break;
          const ev = queue.shift()!;
          // Drop anything we already replayed — closes the
          // replay/subscribe race window.
          if (ev.cursor <= replayMax) continue;
          yield sseChangeFrame(ev);
        }
      } finally {
        unsub();
      }
    },
    {
      query: t.Object({
        since: t.Optional(t.String()),
      }),
    }
  );
