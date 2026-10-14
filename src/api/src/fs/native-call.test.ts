import { describe, expect, test } from 'bun:test';
import { isPoolOverload } from './native-call';

describe('isPoolOverload', () => {
  test('recognizes the maple worker pool overload signal', () => {
    const byCode = Object.assign(new Error('full'), { code: 'MAPLE_WORKER_POOL_OVERLOADED' });
    const byName = new Error('full');
    byName.name = 'MapleWorkerPoolOverloadedError';
    const byMessage = new Error(
      'Maple worker pool is full; await an outstanding call before submitting more work',
    );
    expect(isPoolOverload(byCode)).toBe(true);
    expect(isPoolOverload(byName)).toBe(true);
    expect(isPoolOverload(byMessage)).toBe(true);
    expect(isPoolOverload(new Error('Variant changed'))).toBe(false);
    expect(isPoolOverload(null)).toBe(false);
    expect(isPoolOverload('worker pool is full')).toBe(false);
  });
});
