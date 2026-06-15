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

import { Elysia } from 'elysia';
import { stageRegistry } from '../workers/registry.ts';
import { workersStatusBroadcaster } from '../workers/status-broadcast.ts';
import { verifyAccessToken } from '../auth/tokens.ts';

/** Snapshot of all live stage statuses, keyed by stage name. */
function supervisorState(): ReturnType<typeof stageRegistry.statuses> {
  return stageRegistry.statuses();
}

function jwtSecret(): string {
  const s = process.env.MAPLE_JWT_SECRET;
  if (!s || s.length < 16) throw new Error('MAPLE_JWT_SECRET unset or too short');
  return s;
}

/**
 * Full pipeline-status snapshot frame as it appears on the WS. Kept as a
 * public type so tests / clients can match against it. Loosely-typed
 * `status` because the parent passes the child's JSON through verbatim.
 */
export interface StatusFrame {
  type: 'status';
  status: Record<string, unknown> & {
    paused?: boolean;
    [k: string]: unknown;
  };
  ts: number;
}

const LEGACY_STAGES = ['discover', 'hash', 'exif', 'thumb', 'ai', 'mongo'] as const;

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
    const stagesOut = {} as Record<
      LegacyStageName,
      { inFlight: number; errors: number; deadLetter: number }
    >;

    let anyRunning = false;

    for (const name of LEGACY_STAGES) {
      const s = state[name];
      if (s) {
        if (s.status === 'running') anyRunning = true;
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
    const allPaused = stateValues.length > 0 && stateValues.every((s) => s.status === 'paused');

    const status: ChildStatus = {
      paused: allPaused,
      pools,
      channels,
      stages: stagesOut,
      // In-process: a stage is either registered (running/paused) or absent.
      // "started" mirrors the legacy meaning of "the indexer is up".
      started: stateValues.length > 0,
    };

    // Return null (slow-poll) only when no stages are registered at all —
    // the UI still needs the shape to render correctly while stages are paused.
    if (stateValues.length === 0) return null;

    return status;
  } catch {
    return null;
  }
}

/** WebSocket close code for any auth failure (app-defined 4xxx range). */
const WS_AUTH_CLOSE = 4401;
/** Drop a socket that doesn't send a valid auth frame within this window. */
const WS_AUTH_TIMEOUT_MS = 10_000;

/**
 * Origins allowed to open the events WebSocket (#863, cross-site WebSocket
 * hijack defense). Mirrors the WebAuthn origin allowlist: `MAPLE_ORIGIN`
 * (comma-separated) or the dev localhost ports. A browser always sends `Origin`;
 * a non-browser client (no `Origin`) is allowed through — CSWSH is browser-only.
 */
function allowedWsOrigins(): string[] {
  const raw = process.env.MAPLE_ORIGIN;
  if (raw)
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  return ['http://localhost:3000', 'http://localhost:4200', 'http://localhost:4201'];
}
export function isWsOriginAllowed(origin: string | undefined | null): boolean {
  if (!origin) return true; // non-browser client; not subject to CSWSH
  return allowedWsOrigins().includes(origin);
}

function parseFrame(message: unknown): Record<string, unknown> | null {
  if (typeof message === 'object' && message !== null) return message as Record<string, unknown>;
  if (typeof message === 'string') {
    try {
      const v = JSON.parse(message);
      return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Minimal shape of the Elysia/Bun WS handle that the streaming loop uses. */
interface StreamWs {
  send: (data: unknown) => unknown;
  close: (code?: number, reason?: string) => unknown;
  data: Record<string, unknown>;
}

/**
 * Begin pushing status frames — called ONLY after the socket authenticates
 * (#863). `exp` is the access token's expiry (epoch seconds); the loop closes
 * the socket once it passes, so a revoked session's socket dies within the token
 * TTL and the client reconnects with a fresh token (no per-tick DB read — same
 * stateless bound as the HTTP path).
 */
function startStreaming(ws: StreamWs, exp: number): void {
  {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let lastReachable = true;

    const tick = async (): Promise<void> => {
      if (closed) return;
      // #863: periodic expiry recheck — close once the access token expires.
      if (Date.now() / 1000 >= exp) {
        try {
          ws.close(WS_AUTH_CLOSE, 'token expired');
        } catch {
          /* already closing */
        }
        return;
      }
      const status = await fetchStatus();
      if (closed) return;

      if (!status) {
        // Supervisor has no running stages — emit a process frame and back off.
        if (lastReachable) {
          try {
            ws.send({ type: 'process', state: supervisorState() });
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
            type: 'progress',
            stage: st,
            queueDepth: status.channels[st]?.depth ?? 0,
            inFlight: status.stages[st]?.inFlight ?? 0,
            errors: status.stages[st]?.errors ?? 0,
            deadLetter: status.stages[st]?.deadLetter ?? 0,
          });
        }
        // Full snapshot.
        ws.send({ type: 'status', status, ts: Date.now() });
      } catch {
        // The socket likely closed underneath us; the close handler will
        // clear the timer. Silence the throw so we don't crash the loop.
      }

      timer = setTimeout(tick, FAST_POLL_MS);
    };

    // On open: emit one process snapshot so the UI knows the supervisor
    // state before the first /status comes back.
    try {
      ws.send({ type: 'process', state: supervisorState() });
    } catch {
      /* ignore */
    }

    // Subscribe this socket to the shared workers-status broadcaster. The
    // expensive pending/ready/blocked/dead counts now run on ONE shared timer
    // gated on having ≥1 subscriber and broadcast once to all sockets — strictly
    // fewer queries than each tab polling `GET /workers/status` independently.
    // The Workers settings page consumes the `workers-status` frame instead of
    // HTTP polling (#674); `GET /status` stays as a non-WS fallback.
    const unsubscribeWorkers = workersStatusBroadcaster.subscribe((frame) => {
      try {
        ws.send(frame);
      } catch {
        /* socket may have closed mid-send */
      }
    });

    // Stash the cleanup function on the socket so close() can find it.
    (ws.data as Record<string, unknown>).__cleanup = (): void => {
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      unsubscribeWorkers();
    };

    // Kick off the polling loop.
    timer = setTimeout(tick, 0);
  }
}

export const eventsRoutes = new Elysia({ prefix: '/api' }).ws('/events', {
  // #863: the access token is NOT in the URL anymore (it leaked into proxy /
  // access logs). The handshake only enforces an Origin allowlist (cross-site
  // WebSocket-hijack defense); the client then sends a `{ type: 'auth', token }`
  // frame, and the socket stays silent — and is closed after WS_AUTH_TIMEOUT_MS
  // — until it authenticates.
  beforeHandle({ request, set }) {
    if (!isWsOriginAllowed(request.headers.get('origin'))) {
      set.status = 403;
      return { error: 'origin not allowed' };
    }
  },

  open(ws) {
    const data = ws.data as Record<string, unknown>;
    data.__authed = false;
    data.__authTimer = setTimeout(() => {
      try {
        ws.close(WS_AUTH_CLOSE, 'auth timeout');
      } catch {
        /* already closing */
      }
    }, WS_AUTH_TIMEOUT_MS);
  },

  async message(ws, message) {
    const data = ws.data as Record<string, unknown>;
    // After auth, `/api/events` is a server→client push; ignore client frames.
    if (data.__authed) return;

    const reject = (reason: string): void => {
      try {
        ws.close(WS_AUTH_CLOSE, reason);
      } catch {
        /* already closing */
      }
    };
    const frame = parseFrame(message);
    const token = frame && frame.type === 'auth' ? frame.token : undefined;
    if (typeof token !== 'string') return reject('expected auth frame');
    // Claim the auth slot SYNCHRONOUSLY, before the await — otherwise two auth
    // frames arriving back-to-back both pass the `__authed` check above and each
    // start a streaming loop (#863 review). A second frame now short-circuits.
    data.__authed = true;
    let exp: number;
    try {
      ({ exp } = await verifyAccessToken(token, jwtSecret()));
    } catch {
      return reject('invalid token');
    }
    const t = data.__authTimer as ReturnType<typeof setTimeout> | undefined;
    if (t) clearTimeout(t);
    startStreaming(ws as unknown as StreamWs, exp);
  },

  close(ws) {
    const data = ws.data as Record<string, unknown>;
    const t = data.__authTimer as ReturnType<typeof setTimeout> | undefined;
    if (t) clearTimeout(t);
    const cleanup = data.__cleanup;
    if (typeof cleanup === 'function') cleanup();
  },
});
