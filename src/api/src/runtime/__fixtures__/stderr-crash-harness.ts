/**
 * Test-only harness for `child-process-worker.test.ts` (#899).
 *
 * Runs as its OWN Bun process (spawned by the test with `NODE_ENV=production`
 * in its env) so `../log.ts` skips the `pino-pretty` dev transform and writes
 * plain OTLP-adjacent JSON straight to stdout. That matters because
 * pino-pretty's sync stream writes through `sonic-boom`, which calls
 * `fs.writeSync` on the stdout file descriptor directly — bypassing anything
 * a same-process `process.stdout.write` spy could intercept. Running the
 * whole scenario in a dedicated child process and reading ITS stdout back
 * through a pipe sidesteps that entirely and lets the outer test assert on
 * the real structured JSON log line pino emits.
 *
 * Spawns the stderr-crash fixture via `ChildProcessWorker`, waits for the
 * `error` event it raises once the fixture exits non-zero, then gives pino's
 * synchronous stream a tick to flush before exiting itself.
 */
import { ChildProcessWorker, childScriptPath } from '../child-process-worker.ts';

const CRASH_CHILD = childScriptPath(import.meta.url, './stderr-crash-child.ts');

const worker = new ChildProcessWorker(CRASH_CHILD, { label: 'crash-harness' });
worker.addEventListener('error', () => {
  setTimeout(() => process.exit(0), 100);
});
