/**
 * Downloads the Temporal server the tests run against, by starting it once.
 * CI runs this before any step whose own start-up timeout is too short to
 * absorb a first-time download.
 */
import { startLocalTemporalServer } from '../src/temporal/local-temporal.test-helpers.ts';

const env = await startLocalTemporalServer();
await env.teardown();
