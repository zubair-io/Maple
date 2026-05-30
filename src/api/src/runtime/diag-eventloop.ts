/**
 * Event-loop lag probe — a diagnostic instrument for the single-event-loop
 * architecture.
 *
 * The Maple Self Hosted API runs the HTTP server AND all background work
 * (indexer/enrichment stages, ONNX face pipeline, HEIC decode, change-feed
 * tailer, chokidar) on ONE Bun event loop. CPU-heavy synchronous work on a
 * stage handler freezes the loop and stalls EVERY request, including the
 * trivial `GET /api/health`. This probe is the instrument that lets an
 * operator correlate a latency spike with the specific background activity
 * that caused it.
 *
 * How it works — a drift-based `setInterval`. We schedule a tick every
 * `sampleIntervalMs` and measure how late each tick actually fires versus
 * when it was due. If the loop was blocked, the tick is delayed by the block
 * duration; the excess delay (`actual - expected`) is the event-loop lag.
 * Every stall ≥ `thresholdMs` is logged (or handed to an injected `onStall`).
 *
 * Strictly opt-in: a complete no-op unless `MAPLE_DIAG_EVENTLOOP=1`. When
 * enabled, both timers are `.unref()`'d so the probe never keeps the process
 * alive — it must not change shutdown semantics.
 *
 * Env vars:
 *   MAPLE_DIAG_EVENTLOOP          — set to "1" to enable. Default off (no-op).
 *   MAPLE_DIAG_EVENTLOOP_MS       — stall threshold in ms. Default 50.
 *   MAPLE_DIAG_EVENTLOOP_SUMMARY  — rolling-summary interval in ms. Default
 *                                   30000. Set to 0 to disable the summary.
 */

import type { Logger } from 'pino';
import { child as childLogger } from '../log.ts';

/** Options bag — env-derived defaults are resolved at start() time, so the
 * monitor can be toggled per call (tests rely on this). All fields optional. */
export interface EventLoopLagMonitorOptions {
  /** Stall threshold in ms. A tick later than this past its due time logs. */
  thresholdMs?: number;
  /** How often to schedule a probe tick, in ms. */
  sampleIntervalMs?: number;
  /** Rolling-summary interval in ms; 0 disables the summary timer. */
  summaryIntervalMs?: number;
  /** Sink for individual stalls. Defaults to a pino warn line. Injectable
   * so tests assert on a captured callback rather than parsing log output. */
  onStall?: (lagMs: number) => void;
  /** Logger override (tests). Defaults to the `diag-eventloop` child logger. */
  logger?: Logger;
}

/** A running monitor's handle — opaque; presence means "is running". */
export interface EventLoopLagMonitorHandle {
  readonly thresholdMs: number;
  readonly sampleIntervalMs: number;
}

const DEFAULT_THRESHOLD_MS = 50;
const DEFAULT_SAMPLE_INTERVAL_MS = 50;
const DEFAULT_SUMMARY_INTERVAL_MS = 30_000;

interface MonitorState {
  handle: EventLoopLagMonitorHandle;
  sampleTimer: ReturnType<typeof setInterval>;
  summaryTimer: ReturnType<typeof setInterval> | null;
}

let _state: MonitorState | null = null;

function envFlagEnabled(): boolean {
  return process.env.MAPLE_DIAG_EVENTLOOP === '1';
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Start the event-loop lag monitor. Returns the handle when it actually
 * started, or `null` when it did NOT — either because `MAPLE_DIAG_EVENTLOOP`
 * is unset (strict no-op) or because a monitor is already running (idempotent
 * double-start guard).
 *
 * Env is read HERE, not at module load, so the disabled/enabled paths can be
 * exercised by toggling the env var between calls.
 */
export function startEventLoopLagMonitor(
  opts: EventLoopLagMonitorOptions = {},
): EventLoopLagMonitorHandle | null {
  if (!envFlagEnabled()) return null;
  if (_state) return null; // already running — don't stack timers

  const thresholdMs =
    opts.thresholdMs ?? envNumber('MAPLE_DIAG_EVENTLOOP_MS', DEFAULT_THRESHOLD_MS);
  const sampleIntervalMs = Math.max(1, opts.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS);
  const summaryIntervalMs =
    opts.summaryIntervalMs ??
    envNumber('MAPLE_DIAG_EVENTLOOP_SUMMARY', DEFAULT_SUMMARY_INTERVAL_MS);

  const log = opts.logger ?? childLogger('diag-eventloop');
  const onStall =
    opts.onStall ?? ((lagMs: number) => log.warn({ lagMs: Math.round(lagMs) }, 'event-loop stall'));

  // Rolling-window accumulators for the optional summary.
  let stallCount = 0;
  let maxLagMs = 0;
  let sumLagMs = 0;

  let expected = Date.now() + sampleIntervalMs;
  const sampleTimer = setInterval(() => {
    const now = Date.now();
    const lagMs = now - expected; // how much later than due this tick fired
    expected = now + sampleIntervalMs;
    if (lagMs >= thresholdMs) {
      stallCount++;
      sumLagMs += lagMs;
      if (lagMs > maxLagMs) maxLagMs = lagMs;
      onStall(lagMs);
    }
  }, sampleIntervalMs);
  // Never keep the process alive — the probe is purely observational.
  sampleTimer.unref?.();

  let summaryTimer: ReturnType<typeof setInterval> | null = null;
  if (summaryIntervalMs > 0) {
    summaryTimer = setInterval(() => {
      if (stallCount === 0) return; // nothing to report this window
      log.info(
        {
          stalls: stallCount,
          maxLagMs: Math.round(maxLagMs),
          meanLagMs: Math.round(sumLagMs / stallCount),
          windowMs: summaryIntervalMs,
        },
        'event-loop lag summary',
      );
      stallCount = 0;
      maxLagMs = 0;
      sumLagMs = 0;
    }, summaryIntervalMs);
    summaryTimer.unref?.();
  }

  log.info(
    { thresholdMs, sampleIntervalMs, summaryIntervalMs },
    'event-loop lag monitor started (MAPLE_DIAG_EVENTLOOP=1)',
  );

  const handle: EventLoopLagMonitorHandle = { thresholdMs, sampleIntervalMs };
  _state = { handle, sampleTimer, summaryTimer };
  return handle;
}

/** Stop the monitor. Safe to call when not running (idempotent). */
export function stopEventLoopLagMonitor(): void {
  if (!_state) return;
  clearInterval(_state.sampleTimer);
  if (_state.summaryTimer) clearInterval(_state.summaryTimer);
  _state = null;
}
