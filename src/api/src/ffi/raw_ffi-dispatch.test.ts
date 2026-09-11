/**
 * Dispatch-arm exhaustiveness for the FFI child (`handleFfiRequest`).
 *
 * The child's dispatch is a chain of independent `if` arms; the histogram arm
 * used to be the unlabeled fallback at the end, so a request of any
 * unrecognised type ran the histogram renderer against `"undefined"` paths.
 * These tests drive the handler with a fake native binding so the default
 * arm can be pinned without the dylib.
 */
import { describe, expect, it } from 'bun:test';
import { handleFfiRequest } from './raw_ffi-dispatch.ts';
import type { FfiRequest } from './raw_ffi-protocol.ts';
import type { RawFfi } from './raw_ffi.ts';

function fakeFfi(calls: string[]): RawFfi {
  const record =
    (name: string) =>
    (..._args: unknown[]): never => {
      calls.push(name);
      throw new Error(`${name} must not be reached`);
    };
  return {
    renderThumbnailAvifToFile: record('renderThumbnailAvifToFile'),
    renderThumbnailPreviewJpegToFile: record('renderThumbnailPreviewJpegToFile'),
    renderDevelopJpegToFile: record('renderDevelopJpegToFile'),
    computeHistogramBins: record('computeHistogramBins'),
    asShotWhiteBalance: record('asShotWhiteBalance'),
    exportRecipeToFile: record('exportRecipeToFile'),
  } as unknown as RawFfi;
}

describe('handleFfiRequest', () => {
  it('answers an unrecognised request type with an error, not a histogram', async () => {
    const calls: string[] = [];
    const req = { type: 'renderBitmapThumb', id: 41, rawPath: '/a.dng' } as unknown as FfiRequest;

    const res = await handleFfiRequest(fakeFfi(calls), req);

    expect(res.ok).toBe(false);
    expect(res.id).toBe(41);
    expect(res.type).toBe('renderBitmapThumb');
    // `error` is not on every reply variant (`validateAvif` carries `reason`),
    // so reach for it through the union.
    expect('error' in res ? res.error : undefined).toMatch(/unknown request type/i);
    expect(calls).toEqual([]);
  });

  it('reports a missing dylib without touching the binding', async () => {
    const req: FfiRequest = { type: 'histogram', id: 5, rawPath: '/a.dng', xmpPath: null };
    const res = await handleFfiRequest(null, req);
    expect(res).toEqual({
      type: 'histogram',
      id: 5,
      ok: false,
      error: 'raw-ffi dylib not loaded in child',
    });
  });
});
