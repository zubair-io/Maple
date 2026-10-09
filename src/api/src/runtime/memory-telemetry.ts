// Always on: the 2026-10-09 OOM kill (#4445) left no record of which process ballooned.
import type { Logger } from 'pino';
import { child as childLogger } from '../log.ts';

/** `process.memoryUsage()` at one instant, with the wall-clock it was taken. */
export interface ProcessMemorySample {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  /** Epoch ms. */
  at: number;
}

/** Which long-lived tier spawned a process. Both the API and the worker run
 * their own FFI decode children, so a `ffi-decode` row needs this to say
 * whose it is. */
export type ProcessOwner = 'api' | 'worker';

/** One process's latest sample, as the status payload and the IPC report carry it. */
export interface ProcessMemoryRow extends ProcessMemorySample {
  /** Which process: `api`, `worker`, `ffi-decode`, `face`. */
  process: string;
  pid: number;
  /** Set by the status assembler; a child's own IPC report does not know it. */
  owner?: ProcessOwner;
}

/** The IPC message a child sends its parent with each sample. */
export interface ChildMemoryReport {
  type: typeof MEMORY_REPORT_TYPE;
  row: ProcessMemoryRow;
}

export const MEMORY_REPORT_TYPE = 'memory-report';

export function isChildMemoryReport(msg: unknown): msg is ChildMemoryReport {
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as { type?: unknown; row?: unknown };
  return m.type === MEMORY_REPORT_TYPE && !!m.row && typeof m.row === 'object';
}

const MEMORY_SAMPLE_INTERVAL_MS = 60_000;

/**
 * Per-process RSS above which a warning is logged. 4 GiB: measured steady
 * state (2026-10-09) tops out at 484 MB for the face-pool child, so this is
 * eight times the largest healthy process and will not fire on an ordinary
 * indexing burst — while four processes could each sit here and still total
 * 16 GB on the 24 GB host the kill happened on, so a warning lands well
 * before the kernel acts.
 */
export const RSS_WARN_BYTES = 4 * 1024 * 1024 * 1024;

/** A process that stays above the threshold warns again this often, not every sample. */
export const RSS_WARN_COOLDOWN_MS = 10 * 60_000;

export interface MemoryTelemetryOptions {
  /** Which process this is — `api`, `worker`, `ffi-decode`, `face`. */
  process: string;
  intervalMs?: number;
  rssWarnBytes?: number;
  warnCooldownMs?: number;
  /** Extra fields folded into the per-minute line (per-stage in-flight, queue depths). */
  extra?: () => Record<string, unknown>;
  /** Receives every sample — the worker persists it, a child relays it to its parent. */
  onSample?: (row: ProcessMemoryRow) => void;
  /** Tests inject a fixed reading instead of the live process. */
  readMemory?: () => NodeJS.MemoryUsage;
  logger?: Logger;
}

export interface MemoryReporter {
  /** Take one sample now: log it, check the threshold, notify `onSample`. */
  tick(now?: number): ProcessMemoryRow;
}

export function sampleProcessMemory(
  readMemory: () => NodeJS.MemoryUsage = () => process.memoryUsage(),
  now: number = Date.now(),
): ProcessMemorySample {
  const m = readMemory();
  return {
    rss: m.rss,
    heapUsed: m.heapUsed,
    heapTotal: m.heapTotal,
    external: m.external,
    arrayBuffers: m.arrayBuffers,
    at: now,
  };
}

/** The reporter without its timer — what the tests drive directly. */
export function createMemoryReporter(opts: MemoryTelemetryOptions): MemoryReporter {
  const log = opts.logger ?? childLogger('memory');
  const rssWarnBytes = opts.rssWarnBytes ?? RSS_WARN_BYTES;
  const warnCooldownMs = opts.warnCooldownMs ?? RSS_WARN_COOLDOWN_MS;
  const pid = process.pid;
  let lastWarnAt: number | null = null;

  const shouldWarn = (rss: number, now: number): boolean => {
    if (rss < rssWarnBytes) {
      // Dropping back below re-arms the warning so the next crossing is
      // reported immediately rather than waiting out the cooldown.
      lastWarnAt = null;
      return false;
    }
    return lastWarnAt === null || now - lastWarnAt >= warnCooldownMs;
  };

  return {
    tick(now: number = Date.now()): ProcessMemoryRow {
      const sample = sampleProcessMemory(opts.readMemory, now);
      const row: ProcessMemoryRow = { process: opts.process, pid, ...sample };
      // pino already stamps every record with this process's pid; only the
      // status payload needs it on the row.
      const { at: _at, pid: _pid, ...fields } = row;
      log.info({ ...fields, ...(opts.extra?.() ?? {}) }, 'process memory');
      if (shouldWarn(sample.rss, now)) {
        lastWarnAt = now;
        log.warn(
          { process: opts.process, rss: sample.rss, rssWarnBytes },
          'process rss above threshold',
        );
      }
      opts.onSample?.(row);
      return row;
    },
  };
}

interface TelemetryState {
  reporter: MemoryReporter;
  timer: ReturnType<typeof setInterval>;
  latest: ProcessMemoryRow;
}

let _state: TelemetryState | null = null;

/**
 * Start the per-minute reporter for this process. The first sample is taken
 * immediately so even a short-lived child leaves one line. Idempotent: a
 * second call while running returns null and leaves the first alone.
 */
export function startMemoryTelemetry(opts: MemoryTelemetryOptions): MemoryReporter | null {
  if (_state) return null;
  const reporter = createMemoryReporter({
    ...opts,
    onSample: (row) => {
      if (_state) _state.latest = row;
      opts.onSample?.(row);
    },
  });
  const timer = setInterval(
    () => reporter.tick(),
    Math.max(1, opts.intervalMs ?? MEMORY_SAMPLE_INTERVAL_MS),
  );
  timer.unref?.();
  _state = { reporter, timer, latest: reporter.tick() };
  return reporter;
}

/** The most recent sample this process took, or null before the first tick. */
export function latestMemorySample(): ProcessMemoryRow | null {
  return _state?.latest ?? null;
}

export function stopMemoryTelemetry(): void {
  if (!_state) return;
  clearInterval(_state.timer);
  _state = null;
}

/** `onSample` for a child process: relay the row to the parent over IPC. */
export function reportMemoryToParent(row: ProcessMemoryRow): void {
  const report: ChildMemoryReport = { type: MEMORY_REPORT_TYPE, row };
  process.send?.(report);
}
