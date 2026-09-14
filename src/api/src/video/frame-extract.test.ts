import { describe, expect, it } from 'bun:test';
import { isNativeLoadFailure } from './frame-extract.ts';

/**
 * Narrow unit test for `frame-extract.ts`'s own copy of the
 * `isNativeLoadFailure` predicate — see `face-detector.ts`'s identical
 * (independently-documented, not shared) copy and
 * `face-detector.test.ts`'s equivalent test for the full rationale. This
 * file only covers the predicate itself; `frame-extract.ts` has no broader
 * test suite here (it needs a real ffmpeg binary to exercise end-to-end),
 * so this stays a single focused case rather than growing into one.
 */
describe('isNativeLoadFailure', () => {
  it('recognises the "library not found" message shape', () => {
    const err = new Error(
      'Maple native library (libmaple_core.dylib) not found. Build it with cargo build --release -p raw-ffi or set MAPLE_NATIVE_LIB.',
    );
    expect(isNativeLoadFailure(err)).toBe(true);
  });

  it('recognises the "requires Bun" message shape', () => {
    const err = new Error('Maple native bindings currently require Bun (bun:ffi).');
    expect(isNativeLoadFailure(err)).toBe(true);
  });

  it('returns false for an unrelated Error message (a real decode failure)', () => {
    const err = new Error('unsupported image format');
    expect(isNativeLoadFailure(err)).toBe(false);
  });

  it('returns false for a non-Error thrown value', () => {
    expect(isNativeLoadFailure('some string')).toBe(false);
    expect(isNativeLoadFailure(null)).toBe(false);
    expect(isNativeLoadFailure(undefined)).toBe(false);
  });
});
