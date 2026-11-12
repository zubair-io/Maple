import { sweepExpiredAuthRows } from '../db/repos/auth.expiry.ts';
import { child } from '../log.ts';

const log = child('auth-expiry');

/**
 * One pass of the sweep that replaced MongoDB's one-minute TTL monitor. A
 * table that could not be swept is reported and left for the next pass, which
 * is a minute away; expiry itself is enforced when each row is read.
 */
export async function runAuthExpiryPass(): Promise<void> {
  const result = await sweepExpiredAuthRows();
  if (result.failures.length > 0) {
    log.warn(result, 'Auth expiry sweep partially failed; retrying next minute');
  } else if (result.total > 0) {
    log.info(result, 'Expired auth rows removed');
  }
}
