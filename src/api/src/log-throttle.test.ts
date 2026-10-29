import { describe, expect, it } from 'bun:test';
import { THROTTLED_WARN_WINDOW_MS, throttledWarn } from './log-throttle.ts';

function recordingLog() {
  const lines: Array<{ level: 'warn' | 'debug'; message: string }> = [];
  return {
    lines,
    log: {
      warn: (_fields: object, message: string) => lines.push({ level: 'warn', message }),
      debug: (_fields: object, message: string) => lines.push({ level: 'debug', message }),
    } as never,
  };
}

describe('throttledWarn', () => {
  it('warns once per key per window and logs repeats inside it at debug', () => {
    const { lines, log } = recordingLog();
    const start = 1_000_000;
    throttledWarn(log, 'repeat:/srv/a.mxf', {}, 'failed', start);
    throttledWarn(log, 'repeat:/srv/a.mxf', {}, 'failed', start + 30 * 60_000);
    throttledWarn(log, 'repeat:/srv/b.mxf', {}, 'failed', start + 30 * 60_000);
    throttledWarn(log, 'repeat:/srv/a.mxf', {}, 'failed', start + THROTTLED_WARN_WINDOW_MS);
    expect(lines.map((line) => line.level)).toEqual(['warn', 'debug', 'warn', 'warn']);
  });

  it('forgets the oldest key rather than growing without bound', () => {
    const { lines, log } = recordingLog();
    const now = 5_000_000;
    throttledWarn(log, 'evict:first', {}, 'failed', now);
    for (let i = 0; i < 10_000; i++) throttledWarn(log, `evict:${i}`, {}, 'failed', now);
    lines.length = 0;
    throttledWarn(log, 'evict:first', {}, 'failed', now);
    throttledWarn(log, 'evict:9999', {}, 'failed', now);
    expect(lines.map((line) => line.level)).toEqual(['warn', 'debug']);
  });
});
