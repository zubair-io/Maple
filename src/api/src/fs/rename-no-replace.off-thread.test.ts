/**
 * The native no-replace rename (#5143) must not run on the API thread: on a
 * slow or unresponsive network share the call blocks until the filesystem
 * answers, and on the API thread that stalls every request and timer. Here
 * every native rename made on this thread stalls like such a share, so one made
 * here is both counted and felt.
 */
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import * as ffi from 'bun:ffi';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from './mirrored.ts';

const STALL_MS = 1_000;
const NATIVE_RENAMES = ['renamex_np', 'renameat2'];
let apiThreadRenames = 0;

/** Captured first: mocking re-points the `ffi` namespace at the mock. */
const realFfi = { ...ffi };
mock.module('bun:ffi', () => ({
  ...realFfi,
  dlopen: (library: string, symbols: Parameters<typeof ffi.dlopen>[1]) => {
    const opened = realFfi.dlopen(library, symbols);
    const stalled = Object.fromEntries(
      Object.entries(opened.symbols).map(([name, call]) => [
        name,
        NATIVE_RENAMES.includes(name)
          ? (...args: unknown[]) => {
              apiThreadRenames += 1;
              Bun.sleepSync(STALL_MS);
              return Reflect.apply(call, undefined, args);
            }
          : call,
      ]),
    );
    return { close: () => opened.close(), symbols: stalled };
  },
}));

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'rename-no-replace-off-thread-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test('the native rename runs off the API thread, keeping its timers on time', async () => {
  // Imported only now, so it opens the native library through the stalling mock.
  const { renameNoReplace } = await import('./rename-no-replace.ts');
  await fs.writeFile(path.join(root, 'a.tmp'), 'ours');
  // A real interval: the property under test is that the platform clock keeps
  // firing this thread's timers while the rename is pending.
  let longestTimerGap = 0;
  let last = performance.now();
  const tick = () => {
    const now = performance.now();
    longestTimerGap = Math.max(longestTimerGap, now - last);
    last = now;
  };
  const ticker = setInterval(tick, 5);
  let outcome: 'renamed' | 'unsupported';
  try {
    outcome = await renameNoReplace(path.join(root, 'a.tmp'), path.join(root, 'a.xmp'));
  } finally {
    clearInterval(ticker);
  }
  tick(); // the stretch since the last timer counts too
  expect(longestTimerGap).toBeLessThan(STALL_MS);
  expect(apiThreadRenames).toBe(0);
  if (outcome === 'unsupported') return;
  expect(await fs.readFile(path.join(root, 'a.xmp'), 'utf8')).toBe('ours');
});
