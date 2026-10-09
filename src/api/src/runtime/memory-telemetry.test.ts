import { afterEach, describe, expect, it } from 'bun:test';
import type { Logger } from 'pino';
import {
  createMemoryReporter,
  isChildMemoryReport,
  latestMemorySample,
  MEMORY_REPORT_TYPE,
  RSS_WARN_BYTES,
  RSS_WARN_COOLDOWN_MS,
  sampleProcessMemory,
  startMemoryTelemetry,
  stopMemoryTelemetry,
} from './memory-telemetry.ts';

interface Captured {
  level: 'info' | 'warn';
  fields: Record<string, unknown>;
  msg: string;
}

function captureLogger(): { logger: Logger; lines: Captured[] } {
  const lines: Captured[] = [];
  const logger = {
    info: (fields: Record<string, unknown>, msg: string) =>
      lines.push({ level: 'info', fields, msg }),
    warn: (fields: Record<string, unknown>, msg: string) =>
      lines.push({ level: 'warn', fields, msg }),
  } as unknown as Logger;
  return { logger, lines };
}

const MB = 1024 * 1024;

function usage(rss: number): NodeJS.MemoryUsage {
  return { rss, heapUsed: 10 * MB, heapTotal: 20 * MB, external: 3 * MB, arrayBuffers: 1 * MB };
}

describe('memory telemetry', () => {
  afterEach(() => stopMemoryTelemetry());

  it('samples every process.memoryUsage() field with a timestamp', () => {
    const sample = sampleProcessMemory(() => usage(111 * MB), 1_700_000_000_000);
    expect(sample).toEqual({
      rss: 111 * MB,
      heapUsed: 10 * MB,
      heapTotal: 20 * MB,
      external: 3 * MB,
      arrayBuffers: 1 * MB,
      at: 1_700_000_000_000,
    });
  });

  it('logs one info line per tick naming the process and the extra fields', () => {
    const { logger, lines } = captureLogger();
    const reporter = createMemoryReporter({
      process: 'worker',
      logger,
      readMemory: () => usage(213 * MB),
      extra: () => ({ stages: { thumb: 4 }, ffi: { busy: 2, queued: 7 } }),
    });

    const row = reporter.tick(5_000);

    expect(row).toMatchObject({ process: 'worker', pid: process.pid, rss: 213 * MB, at: 5_000 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      msg: 'process memory',
      fields: {
        process: 'worker',
        rss: 213 * MB,
        heapUsed: 10 * MB,
        heapTotal: 20 * MB,
        external: 3 * MB,
        arrayBuffers: 1 * MB,
        stages: { thumb: 4 },
        ffi: { busy: 2, queued: 7 },
      },
    });
  });

  it('warns once when rss crosses the threshold and again only after the cooldown', () => {
    const { logger, lines } = captureLogger();
    let rss = 1 * MB;
    const reporter = createMemoryReporter({
      process: 'face',
      logger,
      readMemory: () => usage(rss),
      rssWarnBytes: 100 * MB,
      warnCooldownMs: 1_000,
    });
    const warnings = () => lines.filter((l) => l.level === 'warn');

    reporter.tick(0);
    expect(warnings()).toHaveLength(0);

    rss = 150 * MB;
    reporter.tick(100);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toMatchObject({
      msg: 'process rss above threshold',
      fields: { process: 'face', rss: 150 * MB, rssWarnBytes: 100 * MB },
    });

    reporter.tick(500);
    reporter.tick(1_000);
    expect(warnings()).toHaveLength(1);

    reporter.tick(1_100);
    expect(warnings()).toHaveLength(2);
  });

  it('re-arms the warning once rss drops back below the threshold', () => {
    const { logger, lines } = captureLogger();
    let rss = 150 * MB;
    const reporter = createMemoryReporter({
      process: 'api',
      logger,
      readMemory: () => usage(rss),
      rssWarnBytes: 100 * MB,
      warnCooldownMs: 60_000,
    });

    reporter.tick(0);
    rss = 50 * MB;
    reporter.tick(100);
    rss = 150 * MB;
    reporter.tick(200);

    expect(lines.filter((l) => l.level === 'warn')).toHaveLength(2);
  });

  it('defaults to a 4 GiB threshold and a 10 minute cooldown', () => {
    expect(RSS_WARN_BYTES).toBe(4 * 1024 * 1024 * 1024);
    expect(RSS_WARN_COOLDOWN_MS).toBe(600_000);
  });

  it('start samples immediately, records the latest row, and is idempotent', () => {
    const { logger, lines } = captureLogger();
    const rows: number[] = [];
    expect(latestMemorySample()).toBeNull();

    const first = startMemoryTelemetry({
      process: 'api',
      logger,
      intervalMs: 60_000,
      onSample: (row) => rows.push(row.rss),
    });
    const second = startMemoryTelemetry({ process: 'api', logger });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(lines).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect(latestMemorySample()).toMatchObject({ process: 'api', pid: process.pid });

    stopMemoryTelemetry();
    expect(latestMemorySample()).toBeNull();
  });

  it('recognises the IPC report shape and nothing else', () => {
    const row = { process: 'face', pid: 1, ...sampleProcessMemory(() => usage(1), 0) };
    expect(isChildMemoryReport({ type: MEMORY_REPORT_TYPE, row })).toBe(true);
    expect(isChildMemoryReport({ type: 'detect', id: 3 })).toBe(false);
    expect(isChildMemoryReport({ type: MEMORY_REPORT_TYPE })).toBe(false);
    expect(isChildMemoryReport(null)).toBe(false);
  });
});
