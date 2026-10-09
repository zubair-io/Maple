/**
 * The counting gate behind the pool's bulk-read lane (#4413).
 */

import { expect, test } from 'bun:test';
import { ReadGate } from './read-gate.ts';

/** A task that finishes when the test says so, and records when it started. */
function deferredTask(started: string[], name: string) {
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => (finish = resolve));
  return {
    task: async () => {
      started.push(name);
      await done;
      return name;
    },
    finish: () => finish(),
  };
}

test('runs at most `limit` tasks at once and admits the rest in arrival order', async () => {
  const gate = new ReadGate(() => 2);
  const started: string[] = [];
  const tasks = ['a', 'b', 'c', 'd'].map((name) => deferredTask(started, name));
  const results = tasks.map((t) => gate.run(t.task));
  await Promise.resolve();

  const whileFull = { started: [...started], running: gate.running };
  tasks[1]!.finish();
  await results[1];
  await Promise.resolve();
  const afterOne = [...started];
  for (const t of tasks) t.finish();
  const all = await Promise.all(results);

  expect(whileFull).toEqual({ started: ['a', 'b'], running: 2 });
  expect(afterOne).toEqual(['a', 'b', 'c']);
  expect(all).toEqual(['a', 'b', 'c', 'd']);
  expect(gate.running).toBe(0);
});

test('a task that throws still releases its slot', async () => {
  const gate = new ReadGate(() => 1);
  const failed = gate.run(() => Promise.reject(new Error('boom')));
  const next = gate.run(() => Promise.resolve('next'));
  await expect(failed).rejects.toThrow('boom');
  expect(await next).toBe('next');
  expect(gate.running).toBe(0);
});

test('refuses a limit that would admit nothing', async () => {
  await expect(new ReadGate(() => 0).run(() => Promise.resolve('ran'))).rejects.toThrow();
  await expect(new ReadGate(() => 1.5).run(() => Promise.resolve('ran'))).rejects.toThrow();
});

test('a shrinking limit keeps running tasks and admits nothing until under it', async () => {
  const capacity = { limit: 2 };
  const gate = new ReadGate(() => capacity.limit);
  const started: string[] = [];
  const tasks = ['a', 'b', 'c'].map((name) => deferredTask(started, name));
  const results = tasks.map((t) => gate.run(t.task));
  await Promise.resolve();

  capacity.limit = 1;
  tasks[0]!.finish();
  await results[0];
  await Promise.resolve();
  const afterFirst = { started: [...started], running: gate.running };
  tasks[1]!.finish();
  await results[1];
  await Promise.resolve();
  const afterSecond = { started: [...started], running: gate.running };
  tasks[2]!.finish();
  await results[2];

  expect(afterFirst).toEqual({ started: ['a', 'b'], running: 1 });
  expect(afterSecond).toEqual({ started: ['a', 'b', 'c'], running: 1 });
  expect(gate.running).toBe(0);
});

test('a grown limit admits waiters on admitWaiting, without waiting for a release', async () => {
  const capacity = { limit: 1 };
  const gate = new ReadGate(() => capacity.limit);
  const started: string[] = [];
  const tasks = ['a', 'b', 'c'].map((name) => deferredTask(started, name));
  const results = tasks.map((t) => gate.run(t.task));
  await Promise.resolve();
  const beforeGrowth = [...started];

  capacity.limit = 2;
  gate.admitWaiting();
  await Promise.resolve();
  await Promise.resolve();
  const afterGrowth = { started: [...started], running: gate.running };
  for (const t of tasks) t.finish();
  await Promise.all(results);

  expect(beforeGrowth).toEqual(['a']);
  expect(afterGrowth).toEqual({ started: ['a', 'b'], running: 2 });
});
