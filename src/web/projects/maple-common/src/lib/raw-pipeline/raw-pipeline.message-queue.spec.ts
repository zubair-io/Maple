import { describe, expect, it, vi } from 'vitest';
import { createSerialMessageQueue } from './raw-pipeline.message-queue';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('serial worker message queue (#4676)', () => {
  it('runs close-session after an in-flight open-session with a slow lens restore', async () => {
    const enqueue = createSerialMessageQueue();
    const order: string[] = [];
    const restore = deferred();
    const free = vi.fn(() => order.push('close:free'));
    enqueue(async () => {
      order.push('open:start');
      await restore.promise;
      order.push('open:done');
    });
    enqueue(async () => {
      free();
    });
    await tick();
    expect(order).toEqual(['open:start']);
    expect(free).not.toHaveBeenCalled();
    restore.resolve();
    await tick();
    await tick();
    expect(order).toEqual(['open:start', 'open:done', 'close:free']);
  });

  it('runs close-native-detail after an in-flight native-detail render, so no tile posts after teardown', async () => {
    const enqueue = createSerialMessageQueue();
    const order: string[] = [];
    const restore = deferred();
    enqueue(async () => {
      await restore.promise;
      order.push('native-detail:post');
    });
    enqueue(async () => {
      order.push('close-native-detail:free');
    });
    await tick();
    expect(order).toEqual([]);
    restore.resolve();
    await tick();
    await tick();
    expect(order).toEqual(['native-detail:post', 'close-native-detail:free']);
  });

  it('runs set-film-lut after an in-flight open-session instead of against the prior session', async () => {
    const enqueue = createSerialMessageQueue();
    const order: string[] = [];
    const restore = deferred();
    enqueue(async () => {
      await restore.promise;
      order.push('open:done');
    });
    enqueue(async () => {
      order.push('set-film-lut:applied');
    });
    await tick();
    expect(order).toEqual([]);
    restore.resolve();
    await tick();
    await tick();
    expect(order).toEqual(['open:done', 'set-film-lut:applied']);
  });

  it('keeps processing later messages after a task rejects', async () => {
    const enqueue = createSerialMessageQueue();
    const order: string[] = [];
    enqueue(async () => {
      throw new Error('boom');
    });
    enqueue(async () => {
      order.push('next');
    });
    await tick();
    await tick();
    expect(order).toEqual(['next']);
  });
});
