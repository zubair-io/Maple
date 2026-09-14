import { describe, expect, it } from 'bun:test';
import { prepareForTransfer, restoreFromTransfer } from '../src/worker-protocol';

describe('worker-protocol transfer marshalling', () => {
  it('round-trips a plain JSON-shaped result untouched', () => {
    const value = { ok: true, width: 12, height: 8, tag: null, nested: { a: [1, 2, 3] } };
    const { value: prepared, transferList } = prepareForTransfer(value);
    expect(transferList).toHaveLength(0);
    expect(restoreFromTransfer(prepared)).toEqual(value);
  });

  it('marks a Buffer field for transfer and restores it as a Buffer', () => {
    const original = Buffer.from([10, 20, 30, 40]);
    const value = { ok: true, buffer: original, width: 2, height: 2 };
    const { value: prepared, transferList } = prepareForTransfer(value);
    expect(transferList).toHaveLength(1);
    expect(transferList[0].byteLength).toBe(4);
    const restored = restoreFromTransfer(prepared) as { buffer: Buffer };
    expect(Buffer.isBuffer(restored.buffer)).toBe(true);
    expect([...restored.buffer]).toEqual([10, 20, 30, 40]);
  });

  it('restores a Float32Array tensor field with its element type intact', () => {
    const original = new Float32Array([1.5, -2.25, 3]);
    const value = { ok: true, tensor: original };
    const { value: prepared, transferList } = prepareForTransfer(value);
    expect(transferList).toHaveLength(1);
    const restored = restoreFromTransfer(prepared) as { tensor: Float32Array };
    expect(restored.tensor).toBeInstanceOf(Float32Array);
    expect([...restored.tensor]).toEqual([1.5, -2.25, 3]);
  });

  it('collects multiple buffers in one value into one transfer list', () => {
    const value = { a: Buffer.from([1]), b: { c: Buffer.from([2, 3]) } };
    const { transferList } = prepareForTransfer(value);
    expect(transferList).toHaveLength(2);
  });

  it('leaves a subarray offset/length intact through the round trip', () => {
    const backing = new Uint8Array([0, 0, 5, 6, 7, 0]);
    const view = backing.subarray(2, 5); // [5, 6, 7]
    const { value: prepared } = prepareForTransfer({ view });
    const restored = restoreFromTransfer(prepared) as { view: Uint8Array };
    expect([...restored.view]).toEqual([5, 6, 7]);
  });
});
