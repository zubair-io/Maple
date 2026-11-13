import { describe, expect, it } from 'bun:test';
import { decodeVector, encodeVector, vectorFromBase64, vectorToBase64 } from './vector-codec.ts';

describe('vector encoding', () => {
  it('round-trips through little-endian f32 bytes', () => {
    const vector = Float32Array.of(0.1, -0.2, 0.3, 0.9);
    const bytes = encodeVector(vector);
    expect(bytes.byteLength).toBe(16);
    expect(Array.from(decodeVector(bytes))).toEqual(Array.from(vector));
  });

  it('writes 1.0 as 00 00 80 3f', () => {
    expect(Array.from(encodeVector(Float32Array.of(1)))).toEqual([0, 0, 0x80, 0x3f]);
  });

  it('round-trips through base64 bit for bit', () => {
    const vector = Float32Array.from({ length: 1024 }, (_, i) => Math.sin(i) / 7);
    expect(Array.from(vectorFromBase64(vectorToBase64(vector)))).toEqual(Array.from(vector));
  });
});
