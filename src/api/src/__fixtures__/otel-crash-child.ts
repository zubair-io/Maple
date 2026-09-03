/**
 * Test-only fixture for `otel-logs.crash-flush.test.ts` (#2196).
 *
 * Runs as its own Bun process, points the pino → OTLP log bridge at the
 * collector the test stood up, logs one marker line, and then dies the way
 * the env asks it to:
 *
 *   - `abort`    — kills itself with SIGKILL: a death with no JS hook, the
 *                  shape of a Rust `panic=abort` / onnxruntime `terminate`
 *                  in the worker tier. Whatever the bridge is holding is
 *                  lost; the test measures how much, as a function of the
 *                  flush cadence. SIGKILL rather than `process.abort()`
 *                  because Bun's SIGABRT crash handler on the Linux CI
 *                  runner holds the process — and its stderr pipe — open
 *                  for ~20 s while it writes a crash report, which is not
 *                  the property under test; what matters is that no
 *                  JavaScript runs after the signal, and SIGKILL models
 *                  that exactly.
 *   - `uncaught` — throws from a timer: the runtime would exit 1 on its
 *                  own, but `installOtelFatalFlush` gets a flush in first.
 *   - `sigterm`  — the graceful path: `flushOtelBeforeExit` then exit 0,
 *                  as `worker-main.ts` does.
 *
 * Env: `MAPLE_TEST_OTEL_ENDPOINT`, `MAPLE_TEST_OTEL_FLUSH_MS`,
 * `MAPLE_TEST_OTEL_DEATH`. Runs with `NODE_ENV=production` so `log.ts`
 * emits JSON straight to stdout without pino-pretty.
 */
import { setOtelLogTarget } from '../otel-logs.ts';
import { flushOtelBeforeExit, installOtelFatalFlush } from '../otel.ts';
import { logger } from '../log.ts';

const endpoint = process.env.MAPLE_TEST_OTEL_ENDPOINT ?? '';
const flushIntervalMs = Number(process.env.MAPLE_TEST_OTEL_FLUSH_MS ?? '2000');
const death = process.env.MAPLE_TEST_OTEL_DEATH ?? 'abort';

// Something must keep the event loop alive after the death timer fires,
// the way the worker tier's own poll loops do; with an empty loop the
// process simply exits 0 before a self-sent SIGTERM is ever dispatched.
setInterval(() => {}, 1_000);

installOtelFatalFlush();
process.on('SIGTERM', () => {
  void flushOtelBeforeExit().then(() => process.exit(0));
});
await setOtelLogTarget({ endpoint, ingestionKey: null, serviceNamespace: 'test', flushIntervalMs });

logger.info({ death, flushIntervalMs }, 'otel-crash-marker-2196');

setTimeout(() => {
  if (death === 'uncaught') throw new Error('otel-crash-uncaught-2196');
  if (death === 'sigterm') {
    process.kill(process.pid, 'SIGTERM');
    return;
  }
  process.kill(process.pid, 'SIGKILL');
}, 200);
