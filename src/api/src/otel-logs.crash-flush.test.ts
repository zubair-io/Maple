/**
 * Does buffered telemetry survive a process death? (#2196)
 *
 * The worker tier hosts native code that can abort the process outright,
 * and the question the ticket asked was whether the spans and logs buffered
 * in the seconds before such an abort ever reach the collector. Each case
 * here runs `__fixtures__/otel-crash-child.ts` as a real Bun process
 * against a local collector and counts what arrived:
 *
 *   - a native abort with the API tier's 2 s log cadence loses the record
 *     — there is no hook to flush from, so the answer is "no";
 *   - the same abort under a short cadence (the worker tier's lever) gets
 *     the record out beforehand;
 *   - an uncaught exception and a SIGTERM — the deaths JS can still see —
 *     flush before exiting.
 *
 * Spans go through the same batch-then-export shape (a `BatchSpanProcessor`
 * at the tier's delay), so the log bridge stands in for both.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { childScriptPath } from './runtime/child-process-worker.ts';

const CHILD = childScriptPath(import.meta.url, './__fixtures__/otel-crash-child.ts');
const MARKER = 'otel-crash-marker-2196';

/** Minimal OTLP/HTTP logs receiver: records every POST body it is sent. */
const received: string[] = [];
const collector = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    if (req.method === 'POST') received.push(await req.text());
    return new Response('{}', { status: 200 });
  },
});
const endpoint = `http://127.0.0.1:${collector.port}`;

afterAll(() => {
  collector.stop(true);
});

async function runChild(
  death: 'abort' | 'uncaught' | 'sigterm',
  flushIntervalMs: number,
): Promise<{ exitCode: number; signalCode: string | null; stderr: string; bodies: string[] }> {
  const before = received.length;
  const proc = Bun.spawn([process.execPath, CHILD], {
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      MAPLE_TEST_OTEL_ENDPOINT: endpoint,
      MAPLE_TEST_OTEL_FLUSH_MS: String(flushIntervalMs),
      MAPLE_TEST_OTEL_DEATH: death,
    },
  });
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  // Let a POST the child fired just before dying land.
  await Bun.sleep(150);
  return {
    exitCode,
    signalCode: proc.signalCode as string | null,
    stderr,
    bodies: received.slice(before),
  };
}

const arrived = (bodies: string[], needle: string) => bodies.some((b) => b.includes(needle));

describe('telemetry across a process death (#2196)', () => {
  it('a native abort under the 2 s cadence loses the buffered record', async () => {
    const run = await runChild('abort', 2_000);
    // Died by signal, not by a JS-level exit.
    expect(run.signalCode).toBe('SIGKILL');
    expect(arrived(run.bodies, MARKER)).toBe(false);
  }, 20_000);

  it('a native abort under a short cadence had already exported the record', async () => {
    const run = await runChild('abort', 50);
    expect(run.signalCode).toBe('SIGKILL');
    expect(arrived(run.bodies, MARKER)).toBe(true);
  }, 20_000);

  it('an uncaught exception flushes the buffer, keeps the error on stderr, and exits 1', async () => {
    const run = await runChild('uncaught', 2_000);
    expect(run.exitCode).toBe(1);
    expect(arrived(run.bodies, MARKER)).toBe(true);
    expect(arrived(run.bodies, 'process dying')).toBe(true);
    // The parent's crash report reads this process's stderr tail (#899), so
    // installing the handler must not swallow the runtime's own report.
    expect(run.stderr).toContain('otel-crash-uncaught-2196');
  }, 20_000);

  it('SIGTERM flushes the buffer and exits 0', async () => {
    const run = await runChild('sigterm', 2_000);
    expect(run.exitCode).toBe(0);
    expect(arrived(run.bodies, MARKER)).toBe(true);
  }, 20_000);
});
