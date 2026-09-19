/**
 * The log line the pool cannot write for itself (#3782).
 *
 * `pool.ts` has no logger and must never grow one. Anything it imports is
 * loaded inside a `Worker` thread — the clustering worker reaches it through
 * `worker-db.ts` → `repos/db-handle.ts` → `index.ts` — and importing pino
 * there wedges the thread: the worker never answers its first message and the
 * caller waits forever. `busy-retry.ts` carries the measurement (a one-line
 * `log.warn` took `people.cluster-pool.test.ts` from 214 ms to a hard timeout),
 * and `pool.import-graph.test.ts` fails if that import ever comes back.
 *
 * This module is the other side of that arrangement: it imports the logger and
 * is imported only by the three process entry points that open a pool, none of
 * which is ever loaded inside a Worker. Nothing in `db/sqlite/` may import it.
 *
 * ## What an operator should take from these lines
 *
 * A single `respawned` is a reader that crashed and came back; the pool was a
 * reader short for a few hundred milliseconds and nothing else happened. Lines
 * that keep arriving are the signal worth acting on — a reader crash-looping is
 * usually a query that kills the thread rather than the thread being at fault.
 * `retired` is the end of the road for that slot: the pool is permanently
 * narrower until the process restarts, which for a pool sized at the floor is
 * one step from the cliff described in `pool.ts`.
 */

import type { ReaderRespawnEvent } from './pool.ts';
import { child as childLogger } from '../../log.ts';

const log = childLogger('sqlite-pool');

/**
 * The `onReaderRespawn` callback for a production pool.
 *
 * Levels are chosen so an install that is fine is quiet and an install that is
 * not is loud: a reader coming back is a warning because it means one died,
 * and a retired slot is an error because nothing further will be attempted.
 */
export function logReaderRespawn(event: ReaderRespawnEvent): void {
  const fields = { reader: event.reader, attempt: event.attempt, reason: event.reason };
  if (event.outcome === 'respawned') {
    log.warn(fields, 'sqlite reader died and was respawned');
    return;
  }
  if (event.outcome === 'failed') {
    // Deliberately does not say "retrying". This fires once per rung, and on
    // the last rung the pool discovers the ladder is spent and retires the slot
    // in the same millisecond — so the promise would be broken by the very next
    // line, during an outage, which is the worst moment to be reading a log
    // that tells you to wait. What happens next is said by the line that
    // follows, either a respawn or a retirement, within ten seconds at most.
    log.warn(fields, 'sqlite reader respawn attempt failed');
    return;
  }
  log.error(
    fields,
    'sqlite reader could not be respawned and has been retired — the pool is one reader narrower until this process restarts',
  );
}
