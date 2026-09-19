/**
 * Per-suite scoping of an environment variable.
 *
 * It started life in the old test harness, scoping the variable that named the
 * throwaway database each suite got. It has nothing to do with databases —
 * eleven suites use it for `MAPLE_ROOTS`, `MAPLE_DEV_AUTH` and others — so it
 * outlived that harness and lives here instead.
 *
 * The rule it exists to enforce: Bun evaluates every module body during the
 * import phase, before any test runs. A suite that assigns `process.env.X` at
 * module scope therefore sets it for the whole process at import time, so when
 * several suites run in one process the last import wins and every other
 * suite sees that suite's value. That is the #2783 flake class, and it cost two
 * separate investigations.
 *
 * Capturing the previous value at module scope is the same bug in disguise: two
 * suites that both override a variable capture each other's override as their
 * "prior", then faithfully restore the wrong value process-wide on the way out.
 * So the capture happens inside `beforeAll`, which keeps an override live only
 * while the suite that owns it is running.
 */

import { beforeAll, afterAll } from 'bun:test';

export function withTestEnv(name: string, value: string): void {
  let previous: string | undefined;

  beforeAll(() => {
    previous = process.env[name];
    process.env[name] = value;
  });

  afterAll(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}
