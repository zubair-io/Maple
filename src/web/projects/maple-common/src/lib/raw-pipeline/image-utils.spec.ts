// image-utils.ts correctness gate (#1944).
//
// Two independent divergences the consolidated color-pipeline audit found in
// the non-RAW (JPEG/PNG/HEIC) ingestion path:
//   1. `SRGB_TO_REC2020` was a hand-typed copy of the Rust core's
//      sRGB→Rec.2020 matrix that had drifted at the 4th–5th significant digit
//      in every entry. Fixed by importing the codegen-emitted constant
//      instead of hand-typing a copy — this spec pins that constant's VALUES
//      against the known-correct Rust-derived reference (the same numbers
//      `raw-gpu`'s generated `color_matrices.wgsl` emits, proven in
//      `codegen::color_matrices::tests::ts_matrix_matches_wgsl_matrix_bit_exact`)
//      so nobody re-introduces a silently-diverging hand-typed copy.
//   2. `f32ToF16`'s normal-path conversion was a bare right-shift
//      (truncation, i.e. always "round toward zero") instead of the Rust
//      core's round-to-nearest-even (`raw_core::pipeline::fp16::f32_to_f16_bits`).
//      Fixed by porting that function bit-for-bit; this spec proves the
//      rounding behavior actually changed (not just re-labeled truncation).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { f32ToF16 } from './image-utils';
import { SRGB_TO_REC2020 } from '../generated/color-matrices.generated';
import type { DecodedImage } from './raw-pipeline.types';

/** Build an f32 value from its raw IEEE 754 bit pattern (for exact control
 * over mantissa bits when pinning rounding behavior). */
function f32FromBits(bits: number): number {
  const buf = new ArrayBuffer(4);
  new Uint32Array(buf)[0] = bits >>> 0;
  return new Float32Array(buf)[0];
}

describe('SRGB_TO_REC2020 (#1944 — codegen-sourced, not hand-typed)', () => {
  // The Rust-derived reference values (raw-core's M_REC2020_TO_SRGB.inverse()),
  // identical to what `src/raw-pipeline/raw-gpu/src/generated/color_matrices.wgsl`
  // emits for M_SRGB_TO_REC2020_R0/_R1/_R2. The pre-fix hand-typed TS copy read
  // [0.6274039, 0.329283, 0.0433131, 0.0690973, 0.9195404, 0.0113623, 0.0163914,
  // 0.0880133, 0.8955953] — diverging from these at the 4th-5th significant digit.
  const EXPECTED_ROW_MAJOR = [
    0.62740934, 0.3292602, 0.04327189, 0.069124825, 0.91954845, 0.011320766, 0.016423356,
    0.08804783, 0.8956166,
  ];

  it('is the flat row-major 3x3 the codegen emitter produces', () => {
    expect(SRGB_TO_REC2020.length).toBe(9);
    for (let i = 0; i < 9; i++) {
      expect(SRGB_TO_REC2020[i]).toBeCloseTo(EXPECTED_ROW_MAJOR[i], 6);
    }
  });

  it('is NOT the stale hand-typed values the old copy diverged to', () => {
    // The old hand-typed row 0 — must NOT be what ships.
    const staleRow0 = [0.6274039, 0.329283, 0.0433131];
    for (let i = 0; i < 3; i++) {
      expect(SRGB_TO_REC2020[i]).not.toBe(staleRow0[i]);
    }
  });
});

describe('f32ToF16 (#1944 — round-to-nearest-even, ports raw_core::pipeline::fp16::f32_to_f16_bits)', () => {
  it('encodes the canonical fp16 sentinels exactly (parity with the Rust reference)', () => {
    // Mirrors `f32_to_f16_bits_zero_one_half_two` in
    // raw-core/src/pipeline/fp16.rs — values exactly representable in fp16
    // are unaffected by the rounding-mode fix, so both old and new code agree
    // here; this just proves the port didn't break the easy cases.
    expect(f32ToF16(0.0)).toBe(0x0000);
    expect(f32ToF16(1.0)).toBe(0x3c00);
    expect(f32ToF16(2.0)).toBe(0x4000);
    expect(f32ToF16(1.5)).toBe(0x3e00);
  });

  it('rounds UP on a non-tie remainder — the old bare truncation stayed at 1.0 (#1944)', () => {
    // f32 = 1.0 with mantissa bits 12 (the fp16 round bit) and 1 (a sticky
    // bit below it) set: round_bit=1, sticky!=0 -> must round away from
    // zero. The OLD `mantissa >>> 13` truncation silently drops both bits
    // and returns exactly f32ToF16(1.0) (0x3c00) — a real, silent bias.
    const roundUpCase = f32FromBits(0x3f801002);
    const encoded = f32ToF16(roundUpCase);
    expect(encoded).toBe(0x3c01);
    expect(encoded).not.toBe(f32ToF16(1.0));
  });

  it('rounds a tie DOWN to the even mantissa when the kept LSB is already even', () => {
    // f32 = 1.0 with ONLY mantissa bit 12 set (the fp16 round bit) — an exact
    // tie (nothing below it). The kept top-10 mantissa is 0 (even), so
    // round-to-nearest-EVEN must NOT round up.
    const tieEvenCase = f32FromBits(0x3f801000);
    expect(f32ToF16(tieEvenCase)).toBe(0x3c00);
  });

  it('rounds a tie UP to make the mantissa even when the kept LSB is odd (#1944)', () => {
    // f32 = 1.0 with mantissa bits 13 (the fp16 LSB) and 12 (the round bit)
    // set, nothing below — an exact tie whose kept mantissa (1, odd) must
    // round UP to 2 (even) under round-to-nearest-even. The OLD bare
    // truncation would have kept the odd value (0x3c01) unconditionally.
    const tieOddCase = f32FromBits(0x3f803000);
    const encoded = f32ToF16(tieOddCase);
    expect(encoded).toBe(0x3c02);
    expect(encoded).not.toBe(0x3c01);
  });

  it('clamps overflow to fp16 infinity and small negatives to signed zero', () => {
    expect(f32ToF16(1e30)).toBe(0x7c00);
    expect(f32ToF16(-1e-10)).toBe(0x8000);
  });
});

describe('canvasToBlob (thumbnail encoder: AVIF-first with verified JPEG fallback)', () => {
  // A real jsdom/happy-dom test environment has no working OffscreenCanvas
  // AVIF/JPEG encoder, so the global is fully replaced per test with a fake
  // whose `convertToBlob` behavior the test controls — this exercises the
  // AVIF-first/verify/fallback LOGIC in image-utils.ts, not a real codec.
  // `vi.resetModules()` + a dynamic re-import gives each test a fresh module
  // instance, so the module-level `avifEncodeSupported` memoization cache
  // doesn't leak state between scenarios.
  let convertToBlobImpl: (opts: { type: string; quality?: number }) => Promise<Blob>;

  class FakeOffscreenCanvas {
    width: number;
    height: number;
    constructor(width = 0, height = 0) {
      this.width = width;
      this.height = height;
    }
    convertToBlob(opts: { type: string; quality?: number }): Promise<Blob> {
      return convertToBlobImpl(opts);
    }
  }

  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('encodes AVIF when the browser genuinely supports it', async () => {
    convertToBlobImpl = async ({ type }) => new Blob(['x'], { type });
    const { canvasToBlob } = await import('./image-utils');
    const canvas = new FakeOffscreenCanvas(4, 4);
    const result = await canvasToBlob(canvas as unknown as OffscreenCanvas);
    expect(result.format).toBe('avif');
    expect(result.blob.type).toBe('image/avif');
  });

  it('falls back to JPEG when the engine silently substitutes an unsupported type (e.g. returns PNG)', async () => {
    // Some engines don't error on an unsupported requested MIME type — they
    // silently emit a different format (commonly PNG) instead. The verify
    // step (checking the returned Blob.type) must catch this, not just
    // assume success because the call didn't throw.
    convertToBlobImpl = async ({ type }) =>
      new Blob(['x'], { type: type === 'image/avif' ? 'image/png' : type });
    const { canvasToBlob } = await import('./image-utils');
    const canvas = new FakeOffscreenCanvas(4, 4);
    const result = await canvasToBlob(canvas as unknown as OffscreenCanvas);
    expect(result.format).toBe('jpeg');
    expect(result.blob.type).toBe('image/jpeg');
  });

  it('falls back to JPEG when the AVIF probe itself throws', async () => {
    convertToBlobImpl = async ({ type }) => {
      if (type === 'image/avif') throw new Error('unsupported');
      return new Blob(['x'], { type });
    };
    const { canvasToBlob } = await import('./image-utils');
    const canvas = new FakeOffscreenCanvas(4, 4);
    const result = await canvasToBlob(canvas as unknown as OffscreenCanvas);
    expect(result.format).toBe('jpeg');
    expect(result.blob.type).toBe('image/jpeg');
  });

  it('memoizes the capability probe across multiple canvasToBlob calls', async () => {
    let probeConstructions = 0;
    class TrackingFakeOffscreenCanvas extends FakeOffscreenCanvas {
      constructor(width = 0, height = 0) {
        super(width, height);
        // canEncodeAvif() always probes with a 1x1 canvas — count only that
        // shape so real per-call canvases (4x4 below) aren't miscounted.
        if (width === 1 && height === 1) probeConstructions++;
      }
    }
    vi.stubGlobal('OffscreenCanvas', TrackingFakeOffscreenCanvas);
    convertToBlobImpl = async ({ type }) => new Blob(['x'], { type });
    const { canvasToBlob } = await import('./image-utils');
    const canvas = new TrackingFakeOffscreenCanvas(4, 4);
    await canvasToBlob(canvas as unknown as OffscreenCanvas);
    await canvasToBlob(canvas as unknown as OffscreenCanvas);
    await canvasToBlob(canvas as unknown as OffscreenCanvas);
    expect(probeConstructions).toBe(1);
  });
});

describe('encodeDevelopedRenderToAvif / encodeDevelopedRenderToJpeg (#2018 edit-time persist)', () => {
  // Same fake-canvas approach as `canvasToBlob` above, extended with a fake
  // `createImageBitmap` (these functions start from a raw-pipeline
  // `DecodedImage`) and a `getContext('2d')` stub so
  // `resizeBitmapToCanvas`'s `drawImage` call has somewhere to land.
  let convertToBlobImpl: (opts: { type: string; quality?: number }) => Promise<Blob>;

  class FakeCtx {
    drawImage(): void {
      // no-op — this suite tests the AVIF-genuine/JPEG-fallback LOGIC, not
      // real pixel compositing.
    }
  }

  class FakeOffscreenCanvas {
    width: number;
    height: number;
    constructor(width = 0, height = 0) {
      this.width = width;
      this.height = height;
    }
    getContext(): FakeCtx {
      return new FakeCtx();
    }
    convertToBlob(opts: { type: string; quality?: number }): Promise<Blob> {
      return convertToBlobImpl(opts);
    }
  }

  function fakeDecodedImage(width: number, height: number): DecodedImage {
    return {
      width,
      height,
      rgb: new Uint8Array(width * height * 3),
      asShotTemperature: 6500,
      asShotTint: 0,
    };
  }

  // `imageDataToBitmap` constructs a real `ImageData` before handing it to
  // `createImageBitmap` — jsdom has neither, so both need stubbing (the fake
  // `createImageBitmap` below ignores its argument entirely, but the `new
  // ImageData(...)` call still needs a constructor to not throw).
  class FakeImageData {
    constructor(
      public data: Uint8ClampedArray,
      public width: number,
      public height: number,
    ) {}
  }

  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    vi.stubGlobal('ImageData', FakeImageData);
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 32, height: 24, close: () => {} })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('encodeDevelopedRenderToAvif returns genuine AVIF when the browser can encode it', async () => {
    convertToBlobImpl = async ({ type }) => new Blob(['x'], { type });
    const { encodeDevelopedRenderToAvif } = await import('./image-utils');
    const blob = await encodeDevelopedRenderToAvif(fakeDecodedImage(32, 24));
    expect(blob?.type).toBe('image/avif');
  });

  it('encodeDevelopedRenderToAvif returns null when the browser silently substitutes a different format (#2010 Chrome-148 reality)', async () => {
    convertToBlobImpl = async ({ type }) =>
      new Blob(['x'], { type: type === 'image/avif' ? 'image/png' : type });
    const { encodeDevelopedRenderToAvif } = await import('./image-utils');
    const blob = await encodeDevelopedRenderToAvif(fakeDecodedImage(32, 24));
    expect(blob).toBeNull();
  });

  it('encodeDevelopedRenderToAvif returns null when the AVIF probe itself throws', async () => {
    convertToBlobImpl = async ({ type }) => {
      if (type === 'image/avif') throw new Error('unsupported');
      return new Blob(['x'], { type });
    };
    const { encodeDevelopedRenderToAvif } = await import('./image-utils');
    const blob = await encodeDevelopedRenderToAvif(fakeDecodedImage(32, 24));
    expect(blob).toBeNull();
  });

  it('encodeDevelopedRenderToJpeg always produces a JPEG — the server-backed fallback works even when AVIF cannot', async () => {
    // Same "browser can't encode AVIF" world as the null-return case above —
    // encodeDevelopedRenderToJpeg doesn't probe AVIF at all, so it must
    // still succeed here (this is exactly the #2018 server-backed path).
    convertToBlobImpl = async ({ type }) =>
      new Blob(['x'], { type: type === 'image/avif' ? 'image/png' : type });
    const { encodeDevelopedRenderToJpeg } = await import('./image-utils');
    const blob = await encodeDevelopedRenderToJpeg(fakeDecodedImage(32, 24));
    expect(blob.type).toBe('image/jpeg');
  });
});

describe('decodeNonRawToSceneLinearF32 (#3039 review — tight identity check)', () => {
  // #3039 review: an independent verification of the #3039 fix reported a
  // #808080 grey-card JPEG rendering at compositor mean ~39/255 with NO
  // edits applied (expected ~128/255, an identity round-trip). raw-wasm's
  // own `develop_non_raw_default_model_round_trips_grey_within_tight_tolerance`
  // (raw-wasm/src/tests.rs) proves the RUST HALF of that round trip is
  // correct in isolation (128 in -> 127 out, i.e. within 1). This spec pins
  // down the OTHER half this function owns: the browser-side sRGB-byte ->
  // scene-linear-Rec.2020-f32 conversion `develop_non_raw`'s caller performs
  // BEFORE the WASM call — the one place outside Rust the #3039 fix added
  // math that could silently double-decode (or otherwise corrupt) the
  // signal without either half's own isolated tests catching it.
  //
  // A #808080 canvas fill reads back as byte 128 in every channel — this
  // synthesizes that exact `ImageData` and asserts `decodeNonRawToSceneLinearF32`
  // returns the SAME linear value `develop_non_raw`'s Rust test derives the
  // same way (`((128/255 + 0.055) / 1.055) ** 2.4`), not some other value a
  // double gamma-decode (`srgbToLinear` applied twice) or a missed decode
  // (returning the raw 0.502 byte fraction unconverted) would produce —
  // both of which are numerically far outside this test's tolerance.
  let originalCreateImageBitmap: typeof globalThis.createImageBitmap;
  let originalOffscreenCanvas: typeof globalThis.OffscreenCanvas;

  const GREY_BYTE = 128;
  const W = 2;
  const H = 2;
  const greyData = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < greyData.length; i += 4) {
    greyData[i] = GREY_BYTE;
    greyData[i + 1] = GREY_BYTE;
    greyData[i + 2] = GREY_BYTE;
    greyData[i + 3] = 255;
  }

  beforeEach(() => {
    originalCreateImageBitmap = globalThis.createImageBitmap;
    Object.defineProperty(globalThis, 'createImageBitmap', {
      value: vi.fn(async () => ({ width: W, height: H, close: vi.fn() })),
      writable: true,
      configurable: true,
    });

    originalOffscreenCanvas = globalThis.OffscreenCanvas;
    class OffscreenCanvasStub {
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext() {
        return {
          drawImage: vi.fn(),
          getImageData: () => ({ data: greyData, width: W, height: H }),
        };
      }
    }
    Object.defineProperty(globalThis, 'OffscreenCanvas', {
      value: OffscreenCanvasStub,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'createImageBitmap', {
      value: originalCreateImageBitmap,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'OffscreenCanvas', {
      value: originalOffscreenCanvas,
      writable: true,
      configurable: true,
    });
  });

  it('decodes a #808080 canvas readback to the SINGLE-decoded linear value, not double-decoded or un-decoded', async () => {
    const { decodeNonRawToSceneLinearF32 } = await import('./image-utils');
    const { width, height, rgba } = await decodeNonRawToSceneLinearF32(
      new Uint8Array([0xff, 0xd8]),
    );

    expect(width).toBe(W);
    expect(height).toBe(H);

    // The exact IEC 61966-2-1 formula, computed independently of the LUT
    // under test (image-utils.ts's `srgbToLinear`/`srgbToLinearLut`) — same
    // value `raw-wasm`'s Rust identity test derives the same way.
    const srgb = GREY_BYTE / 255;
    const expectedLinear = Math.pow((srgb + 0.055) / 1.055, 2.4);
    // A double sRGB decode would additionally apply the transfer function to
    // `expectedLinear` itself, landing far below this tolerance.
    const doubleDecoded = Math.pow((expectedLinear + 0.055) / 1.055, 2.4);
    // A missed decode would leave the raw byte fraction untouched.
    const undecoded = srgb;

    for (let i = 0, j = 0; i < W * H; i++, j += 4) {
      // R, G, B all equal (neutral grey) and within 0.001 of the single-decode value.
      expect(rgba[j]).toBeCloseTo(expectedLinear, 3);
      expect(rgba[j + 1]).toBeCloseTo(expectedLinear, 3);
      expect(rgba[j + 2]).toBeCloseTo(expectedLinear, 3);
      expect(rgba[j + 3]).toBe(1.0); // alpha always 1.0

      // Guard against the two failure modes a bug here would actually produce.
      expect(Math.abs(rgba[j] - doubleDecoded)).toBeGreaterThan(0.05);
      expect(Math.abs(rgba[j] - undecoded)).toBeGreaterThan(0.05);
    }
  });
});
