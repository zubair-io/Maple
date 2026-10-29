import type { Logger } from 'pino';

/** A deferred render is retried every 30 minutes; one WARN per window says
 * the same thing as forty-eight. */
export const THROTTLED_WARN_WINDOW_MS = 6 * 60 * 60_000;
const MAX_TRACKED_KEYS = 10_000;

const lastWarnedAt = new Map<string, number>();

function remember(key: string, now: number): void {
  lastWarnedAt.delete(key);
  if (lastWarnedAt.size >= MAX_TRACKED_KEYS) {
    const oldest = lastWarnedAt.keys().next().value;
    if (oldest !== undefined) lastWarnedAt.delete(oldest);
  }
  lastWarnedAt.set(key, now);
}

/** WARN for `key` at most once per window; repeats inside it log at debug. */
export function throttledWarn(
  log: Pick<Logger, 'warn' | 'debug'>,
  key: string,
  fields: object,
  message: string,
  now: number = Date.now(),
): void {
  const last = lastWarnedAt.get(key);
  if (last !== undefined && now - last < THROTTLED_WARN_WINDOW_MS) {
    log.debug(fields, message);
    return;
  }
  remember(key, now);
  log.warn(fields, message);
}
