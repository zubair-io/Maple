/**
 * Wire-format guard for the FFI child IPC protocol.
 *
 * `raw_ffi.child.ts` dispatches on `req.type` through a chain of independent
 * `if` arms that used to end in an UNGUARDED histogram block — so any payload
 * whose `type` matched none of the known variants (absent, mistyped, a new
 * request type added to the pool without a child arm) was silently rendered
 * as a histogram and answered with `type: 'histogram'`, which the pool's
 * caller then ignored, hanging its promise forever. These tests pin the guard
 * so an unknown type is rejected before it reaches any dispatch arm.
 */
import { describe, expect, it } from 'bun:test';
import { coerceFfiRequest, FFI_REQUEST_TYPES, rejectedFfiReply } from './raw_ffi-protocol.ts';

describe('coerceFfiRequest', () => {
  it('accepts every known request type', () => {
    for (const type of FFI_REQUEST_TYPES) {
      const req = { type, id: 7 };
      expect(coerceFfiRequest(req) === req).toBe(true);
    }
  });

  it('lists all seven request types the child dispatches', () => {
    const listed: string[] = [...FFI_REQUEST_TYPES].sort();
    expect(listed).toEqual(
      [
        'asShot',
        'exportRecipe',
        'histogram',
        'registerLensProfile',
        'renderDevelop',
        'renderPreviewJpeg',
        'renderThumb',
      ].sort(),
    );
  });

  // The regression: each of these used to fall through to the histogram arm.
  it('rejects a payload whose type is unknown or absent', () => {
    expect(coerceFfiRequest({ id: 3, rawPath: '/a.dng' })).toBeNull();
    expect(coerceFfiRequest({ type: 'HISTOGRAM', id: 3 })).toBeNull();
    expect(coerceFfiRequest({ type: 'renderBitmapThumb', id: 3 })).toBeNull();
    expect(coerceFfiRequest({ type: 1, id: 3 })).toBeNull();
    expect(coerceFfiRequest({ type: null, id: 3 })).toBeNull();
  });

  it('rejects a payload without a numeric id (the pool cannot route its reply)', () => {
    expect(coerceFfiRequest({ type: 'histogram' })).toBeNull();
    expect(coerceFfiRequest({ type: 'histogram', id: '3' })).toBeNull();
    expect(coerceFfiRequest({ type: 'histogram', id: NaN })).toBeNull();
  });

  it('rejects non-object payloads', () => {
    for (const raw of [null, undefined, 0, 1, '', 'histogram', true, false]) {
      expect(coerceFfiRequest(raw)).toBeNull();
    }
  });

  it('rejects an array', () => {
    expect(coerceFfiRequest([])).toBeNull();
    expect(coerceFfiRequest(['histogram', 3])).toBeNull();
  });
});

describe('rejectedFfiReply', () => {
  it('echoes the unrecognised type under the request id so the pool can reject that caller', () => {
    expect(rejectedFfiReply({ type: 'renderBitmapThumb', id: 9 })).toEqual({
      type: 'renderBitmapThumb',
      id: 9,
      ok: false,
      error: "unknown request type 'renderBitmapThumb'",
    });
    expect(rejectedFfiReply({ id: 4 })).toEqual({
      type: 'undefined',
      id: 4,
      ok: false,
      error: "unknown request type 'undefined'",
    });
  });

  it('returns null when there is no numeric id to route a reply by', () => {
    expect(rejectedFfiReply({ type: 'histogram' })).toBeNull();
    expect(rejectedFfiReply({ type: 'histogram', id: '3' })).toBeNull();
    expect(rejectedFfiReply(null)).toBeNull();
    expect(rejectedFfiReply('histogram')).toBeNull();
    expect(rejectedFfiReply([])).toBeNull();
  });
});
