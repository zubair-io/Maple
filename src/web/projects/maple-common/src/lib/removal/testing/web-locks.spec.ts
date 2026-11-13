import { describe, expect, it } from 'vitest';
import { createSerialTestLockManager } from './web-locks';

describe('serial Web Locks test fallback', () => {
  it('queues the same key until its active callback settles', async () => {
    const locks = createSerialTestLockManager();
    let release!: () => void;
    let secondStarted = false;
    const firstGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = locks.request('photo', () => firstGate);
    const second = locks.request('photo', () => {
      secondStarted = true;
    });

    await Promise.resolve();
    expect(secondStarted).toBe(false);
    release();
    await Promise.all([first, second]);
    expect(secondStarted).toBe(true);
  });

  it('releases a key when its callback rejects so the next write can proceed', async () => {
    const locks = createSerialTestLockManager();
    const first = locks.request('photo', () => Promise.reject(new Error('write failed')));
    const second = locks.request('photo', () => 'retry');

    await expect(first).rejects.toThrow('write failed');
    await expect(second).resolves.toBe('retry');
  });
});
