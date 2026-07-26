# 06 — Cross-Platform

WASM/native boundaries, shader portability, iPad vs web parity. This document describes the seams — what each platform shares, what each reimplements, and what the test contract is for keeping the three platforms synchronized.

The shape of the system comes from [`00-overview.md`](./00-overview.md); the types crossing the seams are in [`01-data-model.md`](./01-data-model.md); the math executed on each side is in [`03-algorithms.md`](./03-algorithms.md).

---

## Parity goals, in order

Maple's cross-platform story is designed to satisfy three invariants in priority order:

1. **Sidecar parity.** An `.xmp` written by any platform parses cleanly on any other. A byte-for-byte round trip is a hard test.
2. **Pixel parity.** The same `AdjustmentModel` on the same input RAW produces visually identical pixels (ΔE ≤ 1 target, ≤ 3 tolerance) on every platform.
3. **UX parity.** Slider behavior, keyboard shortcuts, zoom semantics, and panel layout are shared concepts with platform-appropriate execution.

Not listed: code parity. Maple deliberately writes Swift, TypeScript, and Rust in their idiomatic styles. Sharing _behavior_ matters; sharing _source_ only matters inside the Rust core.

---

## The three-layer architecture

```
┌─────────────────────────────────────────────────────────┐
│  Platform-native UI                                     │
│   (SwiftUI on Apple / Angular on Web)                   │
├─────────────────────────────────────────────────────────┤
│  Platform-native pipeline                               │
│   (Core Image + Metal on Apple / WebGL2 on Web)         │
├─────────────────────────────────────────────────────────┤
│  Shared Rust core                                       │
│   (raw-core + raw-ffi + raw-wasm)                       │
└─────────────────────────────────────────────────────────┘
```

The Rust core is the only truly shared code. The pipeline layers implement the same math in different languages targeting different GPU APIs. The UI layers are entirely separate.

### What lives in the Rust core

- RAW decode (rawler wrapper).
- Demosaic (bilinear, half-res quad, HA, AMaZE).
- DCP parsing and transform.
- Bradford chromatic adaptation.
- Tone curve evaluation (the 1D LUT generator).
- Vibrance skin mask (future — currently shader-side on both platforms; see below).
- Dehaze (full dark-channel-prior implementation for export).
- Auto-exposure.
- Histogram computation.
- Tile planner.

### What each platform reimplements

- **Interactive adjustment shaders** — nothing, any more. Epic #925 collapsed them onto one WGSL source in `raw-gpu`, which `wgpu` runs as native Metal on Apple and as WebGPU in the browser; the last hand-written Apple MSL render kernels went in #1043 and the web GLSL in #1042/#1049.
- **The AgX view transform** — Rust reference (float on CPU, used for parity tests) and the shared `agx.wgsl` compute pass. Numeric parity required to 1e-4 (see § AgX parity).
- **The adjustment pipeline orchestrator** — Swift `ImageEditPipeline` / `EditSession+GpuLive`, TypeScript `raw-pipeline.worker.ts`. Both reduce an `AdjustmentModel` to one chain invocation ending in AgX + display encode.
- **The sidecar parser/serializer** — Swift `XMPParser` / `XMPSerializer`, TypeScript `xmp-parser.service.ts` / `xmp-serializer.service.ts`. Both must produce byte-identical output.
- **The UI.** Not remotely shared.

### What the Rust core does _not_ own

- No async runtime. Callers provide their own.
- No GPU. Every output is a CPU buffer.
- No image I/O beyond RAW decode (no JPEG write, no thumbnail generation).
- No sidecar parsing — XMP is an implementation of a _schema_, and the schema crosses into language-specific XML libraries that aren't worth wrapping.

---

## FFI: Rust → Apple

### Build artifact

`RawPipeline.xcframework` — a fat binary containing `libraw_ffi.a` for four slices:

- `aarch64-apple-darwin` (macOS Apple Silicon)
- `x86_64-apple-darwin` (macOS Intel)
- `aarch64-apple-ios` (iOS device)
- `aarch64-apple-ios-sim` (iOS simulator, Apple Silicon)

Built by `scripts/build-apple.sh` from `raw-ffi` with `crate-type = ["staticlib"]`.

### C ABI surface

Deliberately minimal. Three exported functions per lifetime stage, opaque handle:

```c
// Decode + demosaic. Returns 0 on success, negative on error.
int32_t raw_decode_and_demosaic(
    const uint8_t *bytes, size_t len,
    DemosaicedHandle *out
);

// Getters — borrow for the lifetime of the handle.
uint32_t raw_get_width(DemosaicedHandle h);
uint32_t raw_get_height(DemosaicedHandle h);
const float *raw_get_pixels(DemosaicedHandle h);   // RGBA f32 interleaved
size_t raw_get_len(DemosaicedHandle h);

// Free. Must be called exactly once.
void raw_free(DemosaicedHandle h);
```

`DemosaicedHandle` is `void *` on the C side, `*mut DemosaicedImage` on the Rust side. `cbindgen` generates `raw_pipeline.h`.

### Swift wrapper

`MapleCore/RawPipeline/RawPipeline.swift` wraps the C ABI:

```swift
public final class DemosaicedImage {
    private let handle: OpaquePointer

    public init(rawData: Data) throws {
        var handle: OpaquePointer?
        let result = rawData.withUnsafeBytes { ptr in
            raw_decode_and_demosaic(ptr.baseAddress, rawData.count, &handle)
        }
        guard result == 0, let h = handle else { throw DecodeError(result) }
        self.handle = h
    }

    public var width: Int { Int(raw_get_width(handle)) }
    public var height: Int { Int(raw_get_height(handle)) }

    public func asCIImage() -> CIImage {
        // wrap raw_get_pixels() as CIImage backed by MTLBuffer, zero-copy
    }

    deinit { raw_free(handle) }
}
```

### Zero-copy texture upload

The float buffer from Rust is wrapped as a `MTLBuffer` with `storageMode: .shared` pointing at the Rust-allocated memory. Then a `CIImage` is constructed from the buffer. Core Image does not copy; the GPU reads directly from the Rust allocation.

Lifetime: the `DemosaicedImage` must outlive the `CIImage`. Maple enforces this by keeping the `DemosaicedImage` on `EditSession` for the lifetime of the session.

---

## FFI: Rust → Web

### Build artifact

`raw_wasm_bg.wasm` + generated TypeScript bindings (`raw_wasm.js`, `raw_wasm.d.ts`, `raw_wasm_bg.wasm.d.ts`).

Built by `wasm-pack build --target web` from `raw-wasm` with `crate-type = ["cdylib"]` and `wasm-bindgen`.

### JS-visible surface

```typescript
export class WasmDemosaiced {
  constructor(bytes: Uint8Array);
  readonly width: number;
  readonly height: number;
  pixelsPtr(): number; // pointer into WASM memory
  pixelsLen(): number;
  free(): void;
}

export function raw_core_version(): string;
```

The pixel data lives in WASM linear memory and is accessed from JS via a `Float32Array` view over the memory buffer.

### Texture upload

```typescript
const memory = wasm.memory.buffer; // ArrayBuffer backing all WASM data
const pixels = new Float32Array(memory, demo.pixelsPtr(), demo.pixelsLen());
gl.texImage2D(
  gl.TEXTURE_2D,
  0,
  gl.RGBA32F,
  demo.width,
  demo.height,
  0,
  gl.RGBA,
  gl.FLOAT,
  pixels,
);
```

`texImage2D` copies once on upload. There is no WebGL equivalent of zero-copy to GPU memory — the copy is unavoidable.

### Lifetime management

JS is GC'd; Rust-allocated memory isn't. Callers must call `demo.free()` when the texture upload is complete. `wasm-bindgen` makes this tolerable via `FinalizationRegistry`, but Maple's convention is explicit `free()` calls inside `try/finally` to avoid leak surprises.

### WASM memory cap

WASM32 has a 4GB address space ceiling; browsers enforce lower in practice (1–2GB typical). A 25MP image at f32 RGBA is 400MB — comfortable. A 100MP image at f32 RGBA is 1.6GB — too tight. Scene-referred requires f32 throughout, so the previous display-referred f16 web option is not available.

For interactive preview on the web, Maple forces the half-res quad demosaic path (§ 3.3.2 in [`03-algorithms.md`](./03-algorithms.md)) on large RAWs, dropping the working buffer to a quarter size. **Export uses tiling at parity with native** — `tile.rs` is invoked from WASM, the same tile-planning logic the Apple pipeline uses, with a fixed-conservative tile size of 12MP. Cross-tile-aware filters (clarity radius 40, capture sharpening, NR) read overlap regions; the overlap arithmetic is shared with Apple. A CI parity test asserts that a tiled web export agrees with the corresponding full-resolution Apple export to 1e-4 linear (catches stitching seams). The export dialog shows progress because multi-tile WebGL exports take real seconds. There is no half-resolution fallback for export; users who want a smaller output use the dialog's "long edge" / "max megapixels" resize controls. See [`09-open-questions.md`](./09-open-questions.md) § 9.18.

---

## Shader portability

One shader language, one source. Every render kernel is authored once in WGSL under `src/raw-pipeline/raw-gpu/src/*.wgsl` and dispatched by `wgpu`, which targets native Metal on macOS / iPadOS / iOS and WebGPU in the browser. Epic #925 replaced the earlier arrangement — hand-maintained Metal Shading Language on Apple and GLSL ES 3.0 on the web — and the last of that duplication was deleted in #1042/#1049 (GLSL) and #1043 (MSL).

### Why one source, not a translation layer

The previous answer to "single source of truth?" was no: MSL and GLSL were maintained separately because each platform's dialect rewarded different idioms and the algorithms were small enough that duplication seemed tractable. It stopped being tractable — every new stage had to be ported twice and gated twice, and the two ports drifted in ways only the parity harness caught. `wgpu` + naga removes the choice: one WGSL source compiles to MSL for Metal and to the browser's WebGPU backend, so the platforms cannot disagree syntactically and the parity gate only has to police WGSL against the Rust reference.

### What the chain fuses

The live chain is a sequence of compute passes over ping-ponged GPU buffers (`raw-gpu/src/live_chain.rs`), each stage gated on its own slider so an untouched adjustment costs no dispatch. Spatial stages — clarity, texture, capture sharpening, sharpen, NR — orchestrate their own sub-passes over scratch planes because they need blur / deconvolution intermediates, and they run in scene-linear space before the view tail applies AgX, the display encode and the gamma encode.

### The Rust CPU chain is the oracle, and the fallback

`raw_core::pipeline::apply_scene_linear_chain_f32` runs the same stages in the same order on the CPU. It is what the WGSL passes are gated against, and it is what renders when there is no usable GPU — a browser without WebGPU, a headless CI machine, or an Apple session launched with `MAPLE_GPU_LIVE=0`. Because it is a fallback and not a fast path, it carries the expensive spatial stages too (#1043) rather than omitting them for latency.

---

## Matrix parity

Color transforms are driven by matrices. Maple has a small library of compiled constants — the `M_pro_to_rec2020` DCP exit matrix, the Rec.2020→P3 target-gamut matrix, the Rec.2020→sRGB target-gamut matrix, the Oklab conversion matrices, the Bradford transforms. These are computed **once, by hand, and baked in**.

### Where the matrices live

- **Rust core**: `raw-core/src/matrices.rs` — f32 `[[f32; 3]; 3]` constants.
- **Swift**: `MapleCore/Color/Matrices.swift` — `simd_float3x3` constants.
- **TypeScript**: `maple-common/color/matrices.ts` — `number[][]` constants.

All three files contain the same numeric values, checked in CI by a golden-file comparison. A mismatch fails the build.

### How the matrices were derived

Each matrix is a composition of standard transforms documented in `docs/color-derivation.md` (planned — see [`09-open-questions.md`](./09-open-questions.md)). The derivation script is Python, runs once per version bump, outputs constants for all three languages. No runtime derivation.

---

## AgX parity

AgX is implemented three times — Rust reference (for parity tests), Metal kernel (Apple), GLSL shader (Web). All three read the same source of truth: a small table of coefficients and a 512-entry sigmoid LUT derived from the Blender 4.x reference.

### Parity source

- **Coefficient table**: `raw-core/src/agx.rs` exposes the canonical coefficient set as `pub const AGX_COEFFS`. The Swift and TypeScript layers load the same values from code-generated constants (Python derivation script writes all three).
- **Sigmoid LUT**: precomputed 512×3 float table (one column per RGB channel; AgX is per-channel). Serialized as raw f32 bytes in `raw-core/src/agx_lut.bin`, embedded in Swift as a `.data` asset and in TypeScript as a `Uint8Array` import.
- **Reference image generator**: `raw-core/examples/agx_parity.rs` produces a PNG grid of (scene-linear input, expected display output) pairs across the AgX domain — used as a golden fixture.

### Parity tolerance

Rust reference, Metal output, and GLSL output must agree to **max abs error ≤ 1e-4 per channel** on a 256×256 synthetic test image covering the scene domain (from `MID_GRAY * exp2(MIN_EV)` to `MID_GRAY * exp2(MAX_EV)`). A mismatch greater than 1e-4 fails the build.

**Why this value.** What the gate is actually protecting against is coefficient drift between the three implementations — precision mismatches, transcription errors, missing intermediate casts. In the steep midtone region of the sigmoid, even a small (sub-1%) coefficient drift produces an output difference well above `1e-4`; the gate fires from the steep region. From the visibility angle, `1e-4` linear is roughly `0.025` in 8-bit, well below any quantization step or `ΔE` perception threshold.

**Pre-ship verification.** Before the first release, perform a one-time deliberate-perturbation sanity test: perturb one entry of `AGX_COEFFS` in the Rust reference by 1%, confirm both the Apple and Web parity tests fail, then revert. If `1e-4` does not catch a 1% perturbation somewhere in the domain, tighten to `1e-5` and re-run the verification. This is a one-time gate, not a recurring CI loop. See [`09-open-questions.md`](./09-open-questions.md) § 9.53.

### Parity test runs

- **Apple**: `MapleTests/AgXParityTests.swift` renders a `CIImage` through the Metal `AgXViewTransform` and compares pixel-by-pixel with the Rust reference output.
- **Web**: `editor/tests/agx-parity.spec.ts` renders into an offscreen WebGL2 FBO and reads pixels back with `gl.readPixels`, compared with the same Rust reference.
- Both tests run on every PR; a divergence blocks the merge.

### Why this is load-bearing

AgX's per-channel sigmoid is nonlinear and sensitive to coefficient drift. A 1% coefficient error produces visible hue shifts on saturated highlights. Without a numeric parity gate, Apple and Web would slowly diverge — and because both look "AgX-like," the drift wouldn't be caught by eyeballing.

---

## Sidecar parity: the hard test

The XMP sidecar is where cross-platform correctness is gate-kept.

### Test corpus

`test-fixtures/sidecars/` contains:

1. **Golden Maple sidecars** — produced by Maple, representing every field set to a non-default value. One per field, plus combinations.
2. **Lightroom sidecars** — produced by Lightroom, representing real-world inputs with masks, history, snapshots.
3. **Synthetic edge cases** — unusual attribute orderings, weird namespace declarations, unexpected passthrough nodes.

### Round-trip matrix

Every change to `XMPParser`, `XMPSerializer`, or `AdjustmentModel` must pass:

1. **Swift self round-trip**: serialize → parse → assert `AdjustmentModel` equality.
2. **TS self round-trip**: serialize → parse → assert equality.
3. **Cross round-trip**: Swift serialize → TS parse → TS serialize → Swift parse → assert equality; also compare serialized bytes.
4. **Fixture round-trip**: parse a real sidecar, re-emit, byte-compare against the original (modulo whitespace normalization for known elements; passthrough nodes exact).
5. **Lightroom survival**: a Lightroom sidecar with 10 `crs:MaskGroupBasedCorrections` entries — write → parse → write must preserve every byte.

The full byte-canonical rules are in [`xmp-canonical-format.md`](../xmp-canonical-format.md).

---

## Pixel parity: the comparison harness

`src/scripts/test_color_pipeline.sh` gates every change to the Rust color pipeline.

### How it works

```bash
# Extract the DNG's embedded JPEG (what Apple Preview shows)
dd if=reference.dng bs=1 skip=<PreviewImageStart> count=<PreviewImageLength> > preview.jpg

# Run the Rust pipeline standalone
swift run raw-pipeline-smoke reference.dng --out candidate.png

# Compare with CIEDE2000 + per-channel bias + luminance + saturation metrics
python compare_images.py preview.jpg candidate.png --budget-delta-e 15
```

The ΔE budget is a knob: looser during development, tightened as the pipeline improves. Current target is ≤ 5; aspirational is ≤ 3.

### What this catches

- **Color regressions** — a bad matrix, a wrong sign on a Bradford component.
- **Tone-curve regressions** — a bad LUT sampling, a wrong contrast pivot.
- **Demosaic regressions** — a wrong-handed CFA pattern, border artifacts.

### What this doesn't catch

- **Sharpening regressions** — preview JPEGs are noise-free; unsharp mask differences hide in high-frequency content.
- **Slider UI regressions** — the smoke test uses default adjustments; slider bugs are caught by UI tests.
- **Platform differences** — the harness runs the Rust pipeline only. The WebGL fused shader is tested by the Playwright harness (`test-dcp-flow.js`) against a separate reference.

---

## iPad vs web parity: deliberate asymmetries

Not every feature works identically on every platform in v1. The deliberate asymmetries:

| Feature                       | iPad                                 | Web                              | Reason                                                                                                                            |
| ----------------------------- | ------------------------------------ | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Noise reduction               | `CINoiseReduction` (non-local means) | Scene-linear bilateral (minimal) | Scene-referred requires rewriting Apple's NR parameters; web NR is a simpler shader that produces weaker results. Parity in v1.x. |
| High-quality demosaic (AMaZE) | Export only                          | Export only                      | Performance; same on both.                                                                                                        |
| X-Trans support               | Fallback to CIRAWFilter              | Not supported                    | rawler's X-Trans is weak; web has no fallback.                                                                                    |
| SMB source                    | Yes (AMSMB2)                         | No                               | No SMB client in browsers.                                                                                                        |
| Apple Photos source           | Yes (PhotoKit)                       | No                               | No PhotoKit in browsers.                                                                                                          |
| Pencil input                  | Yes                                  | No                               | No pointer-pressure on web.                                                                                                       |

These are documented in [`09-open-questions.md`](./09-open-questions.md) as known-scope-limitations, not bugs.

---

## Development workflow across platforms

### Changing a matrix

1. Edit the Python derivation script in `tools/derive_matrices.py`.
2. Run it; it writes Rust, Swift, TS constants.
3. Golden-file test in CI checks all three agree.
4. Pixel parity harness re-runs; ΔE may change; update budget if justified.

### Changing a shader

1. Edit the WGSL source under `raw-gpu/src/`. There is only one copy; Apple and the web both consume it.
2. Run the stage's WGSL-vs-Rust parity test (1e-4), then the Mac app and the web editor.
3. Pixel parity harness re-runs.

### Adding a new adjustment

1. Add the field to `AdjustmentModel` in all three languages.
2. Add the XMP field mapping in the Rust→XMP serializer test + the Swift and TS serializer implementations.
3. Add a default value and a non-default test fixture.
4. Add the pipeline stage: CIFilter wiring on Apple, shader update on web.
5. Add the slider UI in both SwiftUI and Angular.
6. Round-trip the new fixture through all platforms.

---

## Test contract summary

A change is mergeable only if:

1. Rust unit tests pass: `cd src/raw-pipeline && cargo test -p raw-core --lib`.
2. Pixel parity harness passes: `src/scripts/test_color_pipeline.sh`.
3. Swift unit tests pass: `xcodebuild test -scheme "Maple Exposure" -destination 'platform=macOS'`.
4. Web unit tests pass: `bun test` in `src/web`.
5. XMP round-trip tests pass on Swift, TS, and cross-platform.
6. End-to-end web test passes: `bun src/scripts/test-dcp-flow.js`.

These are the six gates. None is optional.

---

## What this document does not define

- **The specific schema of the XMP wire format.** See [`xmp-canonical-format.md`](../xmp-canonical-format.md).
- **How the Rust core's public types evolve.** See [`01-data-model.md`](./01-data-model.md).
- **What a specific algorithm does.** See [`03-algorithms.md`](./03-algorithms.md).
- **How memory is managed across the FFI boundary on iOS.** See [`05-performance.md`](./05-performance.md) § iOS memory budget.
