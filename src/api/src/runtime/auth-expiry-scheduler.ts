import { sweepExpiredAuthRows } from '../db/repos/auth.expiry.ts';
import { child } from '../log.ts';

const log = child('auth-expiry');
let timer: ReturnType<typeof setInterval> | null = null;
let running: Promise<void> | null = null;

async function sweep(): Promise<void> {
  try {
    const result = await sweepExpiredAuthRows();
    if (result.failures.length > 0) {
      log.warn(result, 'Auth expiry sweep partially failed; retrying next minute');
    } else if (result.total > 0) {
      log.info(result, 'Expired auth rows removed');
    }
  } catch (err) {
    log.error({ err }, 'Auth expiry sweep failed; retrying next minute');
  }
}

function tick(): Promise<void> {
  if (running) return running;
  running = sweep().finally(() => {
    running = null;
  });
  return running;
}

/** Replace MongoDB's one-minute TTL monitor after SQLite has opened. */
export async function startAuthExpiryScheduler(): Promise<void> {
  if (timer) {
    await running;
    return;
  }
  timer = setInterval(() => {
    if (timer) void tick();
  }, 60_000);
  timer.unref();
  await tick();
}

/** Drain the current pass before the database pool closes. */
export async function stopAuthExpiryScheduler(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  await running;
}
