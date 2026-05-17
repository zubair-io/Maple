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

import { Elysia, t } from "elysia";
import { listChangesSince } from "../db/changes.repo.ts";
import { getChangeBus } from "../runtime/change-bus.ts";
import type { AssetChangeWithId } from "../db/schema.ts";

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

/** Raw SSE frame in the spec's id/event/data form. */
function frame(event: string, data: unknown, id: string): string {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export const changesRoutes = new Elysia({ prefix: "/api/changes" })
  .get(
    "/",
    async ({ query, set }) => {
      const since = Number.parseInt(query.since ?? "0", 10);
      const limit = Math.min(
        Math.max(Number.parseInt(query.limit ?? "100", 10), 1),
        1000
      );
      if (!Number.isFinite(since) || since < 0) {
        set.status = 400;
        return { error: "since must be a non-negative integer" };
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

      // 1. Replay anything already in the buffer.
      for (const ev of bus.replay({ since })) {
        yield frame("change", asPayload(ev), String(ev.cursor));
      }

      // 2. Live subscription with 15-s keepalive comments.
      const queue: AssetChangeWithId[] = [];
      let waiter: ((v: "event") => void) | null = null;
      const unsub = bus.subscribe((ev) => {
        queue.push(ev);
        if (waiter) {
          waiter("event");
          waiter = null;
        }
      });

      try {
        while (!request.signal.aborted) {
          if (queue.length === 0) {
            // Race a 15s keepalive against the next event / abort.
            const aborted = new Promise<"abort">((resolve) => {
              const onAbort = (): void => resolve("abort");
              request.signal.addEventListener("abort", onAbort, { once: true });
            });
            const event = new Promise<"event">((resolve) => {
              waiter = resolve;
            });
            const keepalive = new Promise<"keepalive">((resolve) =>
              setTimeout(() => resolve("keepalive"), 15_000)
            );
            const result = await Promise.race([event, keepalive, aborted]);
            if (result === "abort") break;
            if (result === "keepalive") {
              yield ": keepalive\n\n";
              continue;
            }
          }
          const ev = queue.shift()!;
          yield frame("change", asPayload(ev), String(ev.cursor));
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
