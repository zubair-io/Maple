/**
 * The import the pool must never grow, checked transitively (#3782).
 *
 * `busy-retry.test.ts` already pins that one file has no logger, by reading its
 * source text. That guard was enough while `busy-retry.ts` was the only place
 * anyone was tempted to log from. Respawn adds the temptation to `pool.ts`
 * itself — a reader dying is exactly the sort of thing a reader of that file
 * would want a `log.warn` for — and a text check on one file would not catch a
 * logger arriving through any of the four modules between it and the worker.
 *
 * So this walks the real static import graph from the clustering worker's entry
 * point, which is the thing that actually breaks: it reaches `pool.ts` through
 * `worker-db.ts` → `repos/db-handle.ts` → `index.ts`, and pino inside a Worker
 * thread wedges it — the worker never answers its first message and the caller
 * waits forever. Measured on #3752: a one-line `log.warn` took
 * `people.cluster-pool.test.ts` from 214 ms to a hard timeout.
 *
 * The respawn log line lives in `pool-logging.ts`, which imports the logger and
 * is imported only by the process entry points. If someone moves it into the
 * pool to save a callback, this test is what tells them why they cannot.
 */

import { describe, expect, test } from 'bun:test';
import { dirname, relative, resolve } from 'node:path';

/** Every relative `import`/`export ... from '...'` in a module's source. */
const RELATIVE_SPECIFIER = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?[^;]*?from\s+'(\.[^']+)'/g;

const API_ROOT = resolve(import.meta.dir, '../../..');
const LOGGER = resolve(API_ROOT, 'src/log.ts');

/**
 * Every module reachable from `entry` by static relative imports, mapped to the
 * chain that got there.
 *
 * Only relative specifiers are followed, which is the whole of what matters
 * here: a bare specifier is a package, and no package in this graph reaches the
 * repository's own logger.
 */
async function reachableFrom(entry: string): Promise<Map<string, string[]>> {
  const trails = new Map<string, string[]>([[entry, []]]);
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.shift()!;
    const source = await Bun.file(file)
      .text()
      .catch(() => '');
    for (const match of source.matchAll(RELATIVE_SPECIFIER)) {
      const next = resolve(dirname(file), match[1]!);
      if (trails.has(next)) continue;
      trails.set(next, [...trails.get(file)!, file]);
      queue.push(next);
    }
  }
  return trails;
}

function show(paths: readonly string[]): string {
  return paths.map((path) => relative(API_ROOT, path)).join('\n  -> ');
}

describe('the clustering worker import graph', () => {
  test('reaches the pool, which is why the pool may not import a logger', async () => {
    const worker = resolve(API_ROOT, 'src/db/repos/people.cluster.worker.ts');
    const trails = await reachableFrom(worker);
    const pool = resolve(API_ROOT, 'src/db/sqlite/pool.ts');

    // The premise. If this stops holding the guard below is vacuous, and
    // whoever severed the edge should delete both rather than leave a test
    // that passes because it checks nothing.
    expect(trails.has(pool)).toBe(true);
  });

  test('pulls in no logger, transitively', async () => {
    const worker = resolve(API_ROOT, 'src/db/repos/people.cluster.worker.ts');
    const trails = await reachableFrom(worker);
    const trail = trails.get(LOGGER);

    expect(
      trail === undefined
        ? 'no path to src/log.ts'
        : `src/log.ts is reachable:\n  ${show([...trail, LOGGER])}`,
    ).toBe('no path to src/log.ts');
  });

  test('the respawn log line is reachable from the API entry point instead', async () => {
    // The other half: the callback has a real caller, so "the pool cannot log"
    // did not quietly become "nothing logs".
    const trails = await reachableFrom(resolve(API_ROOT, 'src/index.ts'));

    expect(trails.has(resolve(API_ROOT, 'src/db/sqlite/pool-logging.ts'))).toBe(true);
    expect(trails.has(LOGGER)).toBe(true);
  });
});
