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

const LEGACY_STAGES = ["discover", "hash", "exif", "thumb", "ai", "mongo"] as const;

const FAST_POLL_MS = 250;
const SLOW_POLL_MS = 2_000;

type LegacyStageName = (typeof LEGACY_STAGES)[number];

interface ChildStatus {
  paused: boolean;
  pools: Record<LegacyStageName, number>;
  channels: Record<LegacyStageName, { depth: number; capacity: number }>;
  stages: Record<LegacyStageName, { inFlight: number; errors: number; deadLetter: number }>;
  started: boolean;
  // Other fields are passed through verbatim in the status frame.
  [k: string]: unknown;
}

/**
 * Synthesise a complete IndexerStatus snapshot from the supervisor's
 * in-process state. All six legacy stage keys (discover/hash/exif/thumb/ai/mongo)
 * are always populated so the Angular UI never sees missing keys.
 */
async function fetchStatus(): Promise<ChildStatus | null> {
  try {
    const state = supervisorState();
    const pools = {} as Record<LegacyStageName, number>;
    const channels = {} as Record<LegacyStageName, { depth: number; capacity: number }>;
    const stagesOut = {} as Record<LegacyStageName, { inFlight: number; errors: number; deadLetter: number }>;

    let anyRunning = false;

    for (const name of LEGACY_STAGES) {
      const s = state[name];
      if (s) {
        if (s.status === "running") anyRunning = true;
        pools[name] = s.inFlight > 0 ? s.inFlight : 1;
        channels[name] = { depth: 0, capacity: 0 };
        stagesOut[name] = { inFlight: s.inFlight, errors: 0, deadLetter: 0 };
      } else {
        pools[name] = 0;
        channels[name] = { depth: 0, capacity: 0 };
        stagesOut[name] = { inFlight: 0, errors: 0, deadLetter: 0 };
      }
    }

    const stateValues = Object.values(state);
    const allQuiescent = stateValues.length > 0 &&
      stateValues.every((s) => s.status === "stopped" || s.status === "error");

    const status: ChildStatus = {
      paused: allQuiescent && !anyRunning,
      pools,
      channels,
      stages: stagesOut,
      started: anyRunning || stateValues.some(
        (s) => s.status === "starting" || s.status === "restarting",
      ),
    };

    // Return null (slow-poll) only when the supervisor has no registered
    // stages at all — not when they're stopped/errored, since the UI still
    // needs the shape to render correctly.
    if (stateValues.length === 0) return null;

    return status;
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
        for (const st of LEGACY_STAGES) {
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
