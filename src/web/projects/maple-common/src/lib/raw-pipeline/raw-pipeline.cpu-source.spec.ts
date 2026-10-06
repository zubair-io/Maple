import { describe, expect, it } from 'vitest';
import { CpuSourceTransfer } from './raw-pipeline.cpu-source';

describe('CPU source custody', () => {
  const worker = {} as Worker;
  it('transfers actual original once and retains fast/refine source identity', () => {
    const source = new CpuSourceTransfer();
    const bytes = new Uint8Array([9, 2, 3, 8]).subarray(1, 3);
    source.prepare(bytes, 'dng', worker, 1, true);
    expect(Array.from(new Uint8Array(source.buffer))).toEqual([2, 3]);
    expect(source.token).toBe(1);
    expect(source.transferred).toEqual([source.buffer]);
    source.prepare(bytes, 'dng', worker, 2, true);
    const empty = source.buffer;
    const transfer = source.transferred;
    expect(empty.byteLength).toBe(0);
    expect(source.token).toBe(1);
    source.prepare(bytes, 'dng', worker, 3, true);
    expect(source.buffer).toBe(empty);
    expect(source.transferred).toBe(transfer);
    expect(transfer).toEqual([]);
  });
  it('worker replacement, source replacement and failure send real bytes again', () => {
    const source = new CpuSourceTransfer();
    const bytes = new Uint8Array([2, 3]);
    source.prepare(bytes, 'dng', worker, 1, true);
    source.clear();
    source.prepare(bytes, 'dng', worker, 2, true);
    expect(source.token).toBe(2);
    expect(source.buffer.byteLength).toBe(2);
    source.prepare(bytes, 'dng', {} as Worker, 3, true);
    expect(source.token).toBe(3);
    expect(source.buffer.byteLength).toBe(2);
    source.prepare(new Uint8Array([4, 5]), 'dng', worker, 4, true);
    expect(source.token).toBe(4);
    expect(Array.from(new Uint8Array(source.buffer))).toEqual([4, 5]);
    source.prepare(bytes, 'arw', worker, 5, true);
    expect(source.token).toBe(5);
  });
  it('an unsized decode cannot claim a retained CPU source', () => {
    const source = new CpuSourceTransfer();
    const bytes = new Uint8Array([2, 3]);
    source.prepare(bytes, 'dng', worker, 1, true);
    source.prepare(bytes, 'dng', worker, 2, false);
    expect(source.token).toBeUndefined();
    expect(source.buffer.byteLength).toBe(2);
    source.prepare(bytes, 'dng', worker, 3, true);
    expect(source.token).toBe(3);
    expect(source.buffer.byteLength).toBe(2);
  });
});
