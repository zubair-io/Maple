/**
 * /api/events — WebSocket bridge between connected UI clients and the
 * standalone indexer child.
 *
 * The previous in-process implementation subscribed to the
 * IndexerService EventEmitter directly. Now that the pipeline lives in
 * a child process, the parent polls `GET /status` on the child and
 * synthesises the event frames the UI expects.
 *
 * Frame shapes (unchanged for the UI):
 *   { type: "status",   status, ts }                       — full snapshot
 *   { type: "progress", stage, queueDepth, inFlight,
 *     errors, deadLetter }                                  — per-stage tick
 *   { type: "process",  state }                             — supervisor state
 *
 * Polling cadence: 250 ms while the child is reachable; backs off to 2 s
 * after a fetch failure until reachable again.
 */

import { Elysia, t } from "elysia";
import { supervisorState } from "../workers/supervisor.ts";
import { verifyAccessToken } from "../auth/tokens.ts";

function jwtSecret(): string {
  const s = process.env.MAPLE_JWT_SECRET;
  if (!s || s.length < 16) throw new Error("MAPLE_JWT_SECRET unset or too short");
  return s;
}

/**
 * Full pipeline-status snapshot frame as it appears on the WS. Kept as a
 * public type so tests / clients can match against it. Loosely-typed
 * `status` because the parent passes the child's JSON through verbatim.
 */
export interface StatusFrame {
  type: "status";
  status: Record<string, unknown> & {
    paused?: boolean;
    [k: string]: unknown;
  };
  ts: number;
}

const STAGES = ["discover", "hash", "exif", "thumb", "ai", "mongo"] as const;

const FAST_POLL_MS = 250;
const SLOW_POLL_MS = 2_000;

type StageName = (typeof STAGES)[number];

interface ChildStatus {
  channels: Record<StageName, { depth: number; capacity: number }>;
  stages: Record<StageName, { inFlight: number; errors: number; deadLetter: number }>;
  // Other fields are passed through verbatim in the status frame.
  [k: string]: unknown;
}

/**
 * TODO(Task 10): Once stage-controller IPC exposes a /status endpoint per
 * stage, this function should aggregate from each running stage child.
 * For now it synthesises a status snapshot from the supervisor's in-process
 * state instead of fetching from a child process.
 */
async function fetchStatus(): Promise<ChildStatus | null> {
  try {
    const stages = supervisorState();
    if (Object.keys(stages).length === 0) return null;
    // Build a ChildStatus shape compatible with the existing UI frame format.
    // The new supervisor tracks stages differently: each entry has inFlight
    // and throughput. Synthesise the old channel/stages shape so the UI
    // frame format is preserved without a UI change.
    const channels: Record<string, { depth: number; capacity: number }> = {};
    const stagesOut: Record<string, { inFlight: number; errors: number; deadLetter: number }> = {};
    for (const [name, s] of Object.entries(stages)) {
      channels[name] = { depth: 0, capacity: 0 };
      stagesOut[name] = { inFlight: s.inFlight, errors: 0, deadLetter: 0 };
    }
    return { channels, stages: stagesOut } as ChildStatus;
  } catch {
    return null;
  }
}

export const eventsRoutes = new Elysia({ prefix: "/api" }).ws("/events", {
  // Browser `new WebSocket()` can't send Authorization headers, so the
  // standard pattern is a query-string token. Elysia runs `beforeHandle`
  // during the HTTP-side handshake — rejecting here means the upgrade
  // never completes and the browser sees a 401, not a closed socket.
  query: t.Object({ token: t.Optional(t.String()) }),
  beforeHandle({ query, set }) {
    const token = query.token;
    if (!token) {
      set.status = 401;
      return { error: "missing token" };
    }
    try {
      verifyAccessToken(token, jwtSecret());
    } catch {
      set.status = 401;
      return { error: "invalid token" };
    }
  },

  open(ws) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let lastReachable = true;

    const tick = async (): Promise<void> => {
      if (closed) return;
      const status = await fetchStatus();
      if (closed) return;

      if (!status) {
        // Supervisor has no running stages — emit a process frame and back off.
        if (lastReachable) {
          try {
            ws.send({ type: "process", state: supervisorState() });
          } catch {
            /* socket may have closed mid-send */
          }
          lastReachable = false;
        }
        timer = setTimeout(tick, SLOW_POLL_MS);
        return;
      }

      lastReachable = true;

      // Per-stage progress frames (the UI counts on these to drive its
      // per-stage in-flight / errors widgets).
      try {
        for (const st of STAGES) {
          ws.send({
            type: "progress",
            stage: st,
            queueDepth: status.channels[st]?.depth ?? 0,
            inFlight: status.stages[st]?.inFlight ?? 0,
            errors: status.stages[st]?.errors ?? 0,
            deadLetter: status.stages[st]?.deadLetter ?? 0,
          });
        }
        // Full snapshot.
        ws.send({ type: "status", status, ts: Date.now() });
      } catch {
        // The socket likely closed underneath us; the close handler will
        // clear the timer. Silence the throw so we don't crash the loop.
      }

      timer = setTimeout(tick, FAST_POLL_MS);
    };

    // On open: emit one process snapshot so the UI knows the supervisor
    // state before the first /status comes back.
    try {
      ws.send({ type: "process", state: supervisorState() });
    } catch {
      /* ignore */
    }

    // Stash the cleanup function on the socket so close() can find it.
    (ws.data as Record<string, unknown>).__cleanup = (): void => {
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    // Kick off the polling loop.
    timer = setTimeout(tick, 0);
  },

  close(ws) {
    const cleanup = (ws.data as Record<string, unknown>).__cleanup;
    if (typeof cleanup === "function") cleanup();
  },
});
