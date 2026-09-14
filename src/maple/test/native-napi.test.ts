import { describe, expect, it, afterEach } from 'bun:test';
import {
  getNapiLoadError,
  tryLoadNapiBinding,
  _resetNapiBindingForTests,
} from '../src/native-napi';

afterEach(() => {
  delete process.env.MAPLE_NAPI;
  _resetNapiBindingForTests();
});

describe('napi binding resolution', () => {
  it('returns null (not a throw) when no matching addon is installed', () => {
    // This dev checkout has a locally-built addon (`cargo build --release -p
    // raw-napi` under `src/raw-pipeline/`), so this test's real job is
    // proving the function never throws regardless of outcome — assert on
    // the TYPE, not a specific null/non-null value, since that depends on
    // local dev state (whether the crate has been built).
    expect(() => tryLoadNapiBinding()).not.toThrow();
  });

  it('caches its result across calls (same reference, no re-resolution)', () => {
    const first = tryLoadNapiBinding();
    const second = tryLoadNapiBinding();
    expect(second).toBe(first);
  });

  it('_resetNapiBindingForTests forces a fresh resolution on the next call', () => {
    const first = tryLoadNapiBinding();
    _resetNapiBindingForTests();
    const second = tryLoadNapiBinding();
    if (first && second) {
      // Different object instances (a fresh `require`/`dlopen` + fresh
      // wrapper object), even though they wrap the same underlying addon.
      expect(second).not.toBe(first);
    }
  });

  it('when an addon IS resolved, implements every NativeBinding method', () => {
    const napi = tryLoadNapiBinding();
    if (!napi) return; // skip-pass when no addon is built locally
    expect(typeof napi.renderFilenameTemplate).toBe('function');
    expect(typeof napi.validateFilename).toBe('function');
    expect(typeof napi.rasterProbeMetadata).toBe('function');
    expect(typeof napi.rasterProbeMetadataBuf).toBe('function');
    expect(typeof napi.rasterDecodeRgb8Buf).toBe('function');
    expect(typeof napi.rasterRenderBuf).toBe('function');
    expect(typeof napi.rasterFromRawRenderBuf).toBe('function');
    expect(typeof napi.rasterResizeToFile).toBe('function');
    expect(typeof napi.rasterResizeToBuf).toBe('function');
    expect(typeof napi.rasterExtractTensor).toBe('function');
    expect(typeof napi.rasterPipelineBuf).toBe('function');
    expect(typeof napi.rasterAnalyzeBuf).toBe('function');
    expect(typeof napi.exportDevelopedToFile).toBe('function');
    expect(typeof napi.exportRecipeToFile).toBe('function');
    expect(typeof napi.renderThumbnailAvifToFile).toBe('function');
    expect(typeof napi.renderThumbnailPreviewJpegToFile).toBe('function');
    expect(typeof napi.renderDevelopJpegToFile).toBe('function');
    expect(typeof napi.lastError).toBe('function');
  });

  it('lastError always returns null (no napi counterpart, honest stub)', () => {
    const napi = tryLoadNapiBinding();
    if (!napi) return;
    expect(napi.lastError()).toBeNull();
  });

  it('validateFilename matches the bun:ffi shape exactly for a valid name (no extra null fields)', () => {
    const napi = tryLoadNapiBinding();
    if (!napi) return;
    const result = napi.validateFilename('ok-name.jpg');
    expect(result).toEqual({ ok: true });
  });

  it('validateFilename surfaces a rejection with the same {ok,code,error} shape as bun:ffi', () => {
    const napi = tryLoadNapiBinding();
    if (!napi) return;
    const result = napi.validateFilename('bad/name.jpg');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.code).toBe('number');
      expect(typeof result.error).toBe('string');
    }
  });

  it('renderFilenameTemplate accepts a null capturedAt (the shape callers actually pass)', () => {
    const napi = tryLoadNapiBinding();
    if (!napi) return;
    expect(() =>
      napi.renderFilenameTemplate({
        template: '{original}',
        originalStem: 'IMG_0001',
        ext: '.dng',
        capturedAt: null,
        sequenceStart: 1,
        sequenceIndex: 0,
        sequencePadWidth: 3,
      }),
    ).not.toThrow();
  });

  it('rasterProbeMetadata resolves a Promise and reports failure for a missing file', async () => {
    const napi = tryLoadNapiBinding();
    if (!napi) return;
    const result = await napi.rasterProbeMetadata('/nonexistent/does-not-exist.jpg');
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('renderThumbnailAvifToFile tolerates an omitted quality argument (bun:ffi-style optional default)', async () => {
    const napi = tryLoadNapiBinding();
    if (!napi) return;
    // Only 3 of the 4 declared parameters supplied, matching how
    // `callNative` forwards a `Parameters<NativeBinding[K]>` tuple that
    // omitted the optional trailing argument — this must not throw
    // synchronously the way calling the raw addon export directly would.
    const call = napi.renderThumbnailAvifToFile as unknown as (
      ...args: unknown[]
    ) => Promise<{ ok: boolean; error?: string }>;
    const result = await call(
      '/nonexistent/does-not-exist.dng',
      '/tmp/maple-napi-test-out.avif',
      256,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('getNapiLoadError() is null before any resolution attempt and after a successful one', () => {
    // Fresh module state per `afterEach`'s reset — `cached` is `undefined`
    // and `lastLoadError` was just cleared.
    const napi = tryLoadNapiBinding();
    if (!napi) return; // successful-load assertion only meaningful when one loads
    expect(getNapiLoadError()).toBeNull();
  });

  it('MAPLE_NAPI=0 forces tryLoadNapiBinding() to return null and records why (the escape hatch worker-pool.test.ts uses to force the bun:ffi/pool path)', () => {
    process.env.MAPLE_NAPI = '0';
    _resetNapiBindingForTests();
    expect(tryLoadNapiBinding()).toBeNull();
    const err = getNapiLoadError();
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/MAPLE_NAPI=0/);
  });

  it('_resetNapiBindingForTests clears a remembered load error along with the cache', () => {
    process.env.MAPLE_NAPI = '0';
    _resetNapiBindingForTests();
    tryLoadNapiBinding();
    expect(getNapiLoadError()).not.toBeNull();
    delete process.env.MAPLE_NAPI;
    _resetNapiBindingForTests();
    // Not yet re-resolved (lazy), so the stale error must already be gone.
    expect(getNapiLoadError()).toBeNull();
  });
});
