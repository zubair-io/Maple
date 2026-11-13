import { afterEach, expect, setSystemTime, spyOn, test } from 'bun:test';
import * as nodeFs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createLiveTestDatabase } from '../db/sqlite/test-sqlite.test-helpers.ts';
import { loadJailLibraryRoots } from '../indexer/libraries.cache.ts';
import { clearMirrorRoots, setMirrorRoots } from './mirror-registry.ts';
import { checkAllowed } from './root.ts';

const temporaryRoots: string[] = [];
const environment = { roots: process.env.MAPLE_ROOTS };
afterEach(async () => {
  setSystemTime();
  if (environment.roots === undefined) delete process.env.MAPLE_ROOTS;
  else process.env.MAPLE_ROOTS = environment.roots;
  clearMirrorRoots();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => nodeFs.rm(root, { recursive: true, force: true })),
  );
});

async function controlledProbe(kind: 'mirror' | 'primary', lexical = false) {
  const fixture = await nodeFs.realpath(await nodeFs.mkdtemp(join(tmpdir(), 'maple-successor-')));
  temporaryRoots.push(fixture);
  const target = join(fixture, 'target');
  const alias = join(fixture, 'alias');
  const other = join(fixture, 'other');
  await Promise.all([nodeFs.mkdir(target), nodeFs.mkdir(other)]);
  await nodeFs.writeFile(join(target, 'photo.xmp'), '<xmpmeta/>');
  await nodeFs.symlink(target, alias);
  delete process.env.MAPLE_ROOTS;
  setMirrorRoots(kind === 'mirror' ? { [other]: [alias] } : { [alias]: [other] });
  await loadJailLibraryRoots();
  const calls: ReturnType<typeof Promise.withResolvers<string>>[] = [];
  const actual = nodeFs.realpath.bind(nodeFs);
  const probe = spyOn(nodeFs, 'realpath').mockImplementation((async (requested) => {
    if (requested === alias) {
      const call = Promise.withResolvers<string>();
      calls.push(call);
      return call.promise;
    }
    if (requested === join(alias, 'photo.xmp')) return join(target, 'photo.xmp');
    if (requested === join(target, 'photo.xmp') || requested === other) return requested;
    return actual(requested);
  }) as typeof nodeFs.realpath);
  const requests: ReturnType<typeof checkAllowed>[] = [];
  const request = async () => {
    const work = checkAllowed(join(lexical ? alias : target, 'photo.xmp'));
    requests.push(work);
    // Controlled lookups and a warm library cache let one turn drain all joining microtasks.
    await nextTurn();
    return { work };
  };
  return {
    calls,
    target,
    request,
    async [Symbol.asyncDispose]() {
      probe.mockRestore();
      calls.forEach((call) => call.resolve(target));
      await Promise.allSettled(requests);
    },
  };
}

for (const [kind, lexical] of [
  ['mirror', false],
  ['primary', false],
  ['primary', true],
] as const) {
  const label = `${kind} ${lexical ? 'lexical' : 'canonical'} successor`;
  test(`${label} serves waiters joining before and after the predecessor settles`, async () => {
    using _live = await createLiveTestDatabase();
    await using control = await controlledProbe(kind, lexical);
    const original = await control.request();
    const early = await Promise.all(Array.from({ length: 5 }, () => control.request()));
    expect(control.calls).toHaveLength(1);
    control.calls[0].resolve(control.target);
    await nextTurn();
    expect(control.calls).toHaveLength(2);
    const late = await Promise.all(Array.from({ length: 5 }, () => control.request()));
    expect(control.calls).toHaveLength(2);
    control.calls[1].resolve(control.target);
    await nextTurn();
    expect(control.calls).toHaveLength(3);
    // Early waiters must finish while the late waiters' successor is still held.
    expect((await Promise.all(early.map(({ work }) => work))).every((result) => result.ok)).toBe(
      true,
    );
    control.calls[2].resolve(control.target);
    expect((await Promise.all(late.map(({ work }) => work))).every((result) => result.ok)).toBe(
      true,
    );
    expect((await original.work).ok).toBe(true);
    expect(control.calls).toHaveLength(3);
  });

  for (const phase of ['predecessor', 'successor'] as const) {
    for (const refresh of [false, true]) {
      test(`${label} denies parked waiters when configuration changes during the ${phase} (${refresh ? 'observed' : 'unobserved'})`, async () => {
        using _live = await createLiveTestDatabase();
        await using control = await controlledProbe(kind, lexical);
        const original = await control.request();
        const waiters = await Promise.all(Array.from({ length: 3 }, () => control.request()));
        expect(control.calls).toHaveLength(1);
        if (phase === 'successor') {
          control.calls[0].resolve(control.target);
          await nextTurn();
          expect(control.calls).toHaveLength(2);
        }
        clearMirrorRoots();
        if (refresh) expect((await (await control.request()).work).ok).toBe(false);
        control.calls.at(-1)!.resolve(control.target);
        await nextTurn();
        // An unobserved registry change can still start a successor; its result must be denied too.
        control.calls.at(-1)!.resolve(control.target);
        const results = await Promise.all(waiters.map(({ work }) => work));
        expect(results.map((result) => result.ok)).toEqual([false, false, false]);
        await original.work;
        expect((await (await control.request()).work).ok).toBe(false);
      });
    }
  }
}

test('a stalled mirror successor expires, benches the root, and clears its deadline on late settlement', async () => {
  using _live = await createLiveTestDatabase();
  await using control = await controlledProbe('mirror');
  const scheduled: { fire: () => void; timer: ReturnType<typeof setTimeout> }[] = [];
  const actualTimeout = globalThis.setTimeout;
  const timerSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((
    callback: () => void,
    ms?: number,
  ) => {
    const timer = actualTimeout(callback, ms === 2_000 ? 60_000 : ms);
    if (ms === 2_000) scheduled.push({ fire: callback, timer });
    return timer;
  }) as typeof setTimeout);
  const clearSpy = spyOn(globalThis, 'clearTimeout');
  try {
    const original = await control.request();
    const waiters = await Promise.all(Array.from({ length: 3 }, () => control.request()));
    control.calls[0].resolve(control.target);
    await nextTurn();
    expect(control.calls).toHaveLength(2);
    expect(scheduled).toHaveLength(2);
    scheduled[1].fire();
    expect((await Promise.all(waiters.map(({ work }) => work))).map((result) => result.ok)).toEqual(
      [false, false, false],
    );
    expect((await (await control.request()).work).ok).toBe(false);
    expect(control.calls).toHaveLength(2);
    control.calls[1].resolve(control.target);
    await nextTurn();
    expect(clearSpy).toHaveBeenCalledWith(scheduled[1].timer);
    expect((await (await control.request()).work).ok).toBe(false);
    expect(control.calls).toHaveLength(2);
    expect((await original.work).ok).toBe(true);
    setSystemTime(new Date(Date.now() + 60_001));
    const recovered = await control.request();
    expect(control.calls).toHaveLength(3);
    control.calls[2].resolve(control.target);
    expect((await recovered.work).ok).toBe(true);
  } finally {
    scheduled.forEach(({ timer }) => clearTimeout(timer));
    clearSpy.mockRestore();
    timerSpy.mockRestore();
  }
});

test('a rejected mirror predecessor denies its waiters but permits a fresh probe after backoff', async () => {
  using _live = await createLiveTestDatabase();
  await using control = await controlledProbe('mirror');
  const original = await control.request();
  const waiters = await Promise.all(Array.from({ length: 3 }, () => control.request()));
  expect(control.calls).toHaveLength(1);
  control.calls[0].reject(new Error('lookup failed'));
  expect((await original.work).ok).toBe(false);
  expect((await Promise.all(waiters.map(({ work }) => work))).every((result) => !result.ok)).toBe(
    true,
  );
  expect(control.calls).toHaveLength(1);
  expect((await (await control.request()).work).ok).toBe(false);
  setSystemTime(new Date(Date.now() + 60_001));
  const fresh = await control.request();
  expect(control.calls).toHaveLength(2);
  control.calls[1].resolve(control.target);
  expect((await fresh.work).ok).toBe(true);
});
