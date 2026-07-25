/**
 * Wire-format guard for the imgdecode IPC protocol.
 *
 * Once the protocol carried a second op (`validate`, #2257), dispatch became
 * `if (type === 'render') … else validate` — so anything that got past the
 * guard and was not a `render` was treated as a `validate`. A payload with an
 * absent or unknown `type` therefore reached the decode path with undefined
 * fields. These tests pin the guard so that regression can't return.
 */
import { describe, expect, it } from 'bun:test';
import { coerceRequest } from './imgdecode-protocol.ts';

describe('coerceRequest', () => {
  it('accepts a render request', () => {
    const req = {
      type: 'render',
      id: 1,
      srcPath: '/a.jpg',
      outPath: '/a.avif',
      maxPx: 512,
      quality: 55,
      ext: 'jpeg',
    };
    expect(coerceRequest(req)).toBe(req);
  });

  it('accepts a validate request', () => {
    const req = { type: 'validate', id: 2, filePath: '/a.avif', expectedLongEdgePx: 512 };
    expect(coerceRequest(req)).toBe(req);
  });

  // The regression: each of these used to fall through to the validate branch.
  it('rejects a payload whose type is unknown or absent', () => {
    expect(coerceRequest({ id: 3 })).toBeNull();
    expect(coerceRequest({ type: 'RENDER', id: 3 })).toBeNull();
    expect(coerceRequest({ type: 'shutdown', id: 3 })).toBeNull();
    expect(coerceRequest({ type: 1, id: 3 })).toBeNull();
    expect(coerceRequest({ type: null, id: 3 })).toBeNull();
  });

  it('rejects non-object payloads', () => {
    for (const raw of [null, undefined, 0, 1, '', 'render', true, false]) {
      expect(coerceRequest(raw)).toBeNull();
    }
  });

  // An array is an object, so the typeof check alone would let it through; it
  // has no `type`, which is what actually rejects it.
  it('rejects an array', () => {
    expect(coerceRequest([])).toBeNull();
    expect(coerceRequest(['render'])).toBeNull();
  });
});
