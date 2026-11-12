import { sweepExpiredAuthRows } from '../db/repos/auth.expiry.ts';
import { child } from '../log.ts';

const log = child('auth-expiry');

/**
 * One pass of the sweep that replaced MongoDB's one-minute TTL monitor, run by
 * the worker tier as the `auth-expiry` maintenance task. It only keeps the
 * tables small: the reads refuse or omit an expired challenge, code, refresh
 * token, invite or upload session themselves, so nothing waits on a pass and a
 * server running without the worker tier stays correct. A table that could not
 * be swept is reported and left for the next pass.
 */
export async function runAuthExpiryPass(): Promise<void> {
  const result = await sweepExpiredAuthRows();
  if (result.failures.length > 0) {
    log.warn(result, 'Auth expiry sweep partially failed; retrying next minute');
  } else if (result.total > 0) {
    log.info(result, 'Expired auth rows removed');
  }
}
