import { describe, expect, it } from 'bun:test';
import { deriveBatchSize } from './loop-policy.ts';

describe('deriveBatchSize', () => {
  it('is 5× concurrency', () => {
    expect(deriveBatchSize(1)).toBe(5);
    expect(deriveBatchSize(2)).toBe(10);
    expect(deriveBatchSize(100)).toBe(500);
  });
});
