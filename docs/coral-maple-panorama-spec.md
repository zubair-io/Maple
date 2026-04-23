# Maple — Panorama Pipeline Design Spec

**Status:** Draft v0.3 (tightened against current `raw-core`, `raw-ffi`, `raw-wasm`, `MapleCore`, and the verifier harness)
**Owner:** Zubair
**Targets:** new crate `pano-core` in the existing `raw-pipeline/` workspace → WASM bundle delivered into `web/projects/editor/src/assets/raw-wasm/`, and `RawPipeline.xcframework` consumed by the `RawPipeline` and `MapleCore` Swift packages (macOS / iPadOS / iOS / visionOS).
**Phase:** Phase 4 — Advanced Editing (see `photo-app-feature-spec.md` § "Phase 4" and `docs/product-status.md`). Phases 1–2 are complete; Phase 3 (Color Engine) is the current gate. This spec is executable once Phase A of `docs/maple-maple-pipeline-rewrite-tdd-v2.md` and Phase 3's color work land.

---

## 1. Goals

A pure-Rust panorama stitching core that:

1. Produces SOTA quality on handheld raw-photography inputs (DNG, HEIF, JPEG).
2. Operates **linearly in scene-referred float32 ProPhoto** end-to-end; tone/display transform applied only on export.
3. Compiles to:
   - the existing **`raw-wasm`** crate (cdylib) via a new `pano` feature, delivered by the same `wasm-pack` flow the RAW pipeline already uses, copied to `web/projects/editor/src/assets/raw-wasm/` (same folder as today — single bundle).
   - the existing **`RawPipeline.xcframework`** via the `raw-ffi` staticlib + `raw-pipeline/scripts/build-apple.sh`, consumed by `raw-pipeline/RawPipeline/Sources/RawPipeline/` and surfaced to app code through a new `Packages/MapleCore/Sources/MapleCore/Panorama/` directory.
4. Uses modern ML (LightGlue-grade matching) where it wins, classical DSP where it wins.
5. Exposes a **pluggable, trait-based pipeline** so individual stages can be swapped (classical ↔ neural) and benchmarked without touching consumers.
6. Runs on-device; no server calls, no telemetry.
7. **Reuses** — does not duplicate — `raw-core`'s decode, demosaic, white-balance, DCP, and color-matrix modules. Panorama is a new top-level pipeline whose ingest starts from the buffer `raw-core` already produces.

## 2. Non-goals

- No full 360° VR / equirectangular UI (initial projections: rectilinear + cylindrical; spherical as a v1.1 stretch).
- No HDR merging as a first-class feature — different code path; will share the alignment stage later.
- No generative/diffusion "rescue" mode in v1. Considered for v2 as an opt-in.
- No shared-state networked editing. Local compute only.
- **No UniFFI.** The project already uses hand-written C headers under `raw-pipeline/include/` + a `module.modulemap`, packaged via `binaryTarget` in `raw-pipeline/RawPipeline/Package.swift`. We extend that; we do not introduce a second FFI mechanism. (See § 6.2.)

## 3. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    raw-pipeline/ (Cargo workspace)                       │
│                                                                          │
│  ┌─────────────────────────────┐  ┌───────────────────────────────────┐  │
│  │  raw-core (existing)        │  │  pano-core (NEW)                  │  │
│  │  decode → demosaic →        │──▶  features → match → BA → warp →   │  │
│  │  WB → DCP → ProPhoto linear │  │  seam → compensate → blend        │  │
│  │  (linear f32 ProPhoto)      │  │  (linear f32 ProPhoto throughout) │  │
│  └─────────────────────────────┘  └───────────────────────────────────┘  │
│              ▲                                    ▲                      │
│              │                                    │                      │
│  ┌───────────┴────────────┐       ┌───────────────┴─────────────────┐    │
│  │  raw-ffi (existing     │       │  raw-wasm (existing cdylib,     │    │
│  │  staticlib, extended   │       │  extended with panorama         │    │
│  │  with pano_* entry     │       │  bindings behind `pano` feature)│    │
│  │  points + f32 handle)  │       │                                 │    │
│  └────────────────────────┘       └─────────────────────────────────┘    │
│              │                                    │                      │
│              ▼                                    ▼                      │
│  raw-pipeline/RawPipeline.xcframework        web/projects/editor/src/    │
│              │                                assets/raw-wasm/           │
│              ▼                                    │                      │
│  Packages/MapleCore/.../Panorama/*.swift         ▼                       │
│              │                       src/app/services/panorama.ts        │
│              ▼                                    │                      │
│  Maple (SwiftUI app)                        ▼                      │
│                                           Angular editor                 │
└──────────────────────────────────────────────────────────────────────────┘
```

### Design principles

- **Float32 ProPhoto linear throughout `pano-core`.** This matches `raw-core`'s pre-output working space (the demosaic + DCP chain sits in ProPhoto linear; `apply_matrix(prophoto_to_srgb)` is the last step today). Staying in ProPhoto avoids the gamut clip that the current sRGB conversion imposes and keeps pano compatible with the wider-gamut export path we'll need on Apple.
- **Stages are traits.** Default classical implementation always available; optional neural implementations behind `ml-*` feature flags.
- **No OpenCV.** Replaced by `imageproc`, `nalgebra`, `argmin`, `wgpu`. This is the portability unlock.
- **GPU where it matters, CPU where it's simpler.** Multi-band blending, warping, pyramids → `wgpu`. Everything else → CPU/SIMD, `rayon`-parallel on native (already the norm in `raw-core`), single-threaded in WASM until SharedArrayBuffer lands.
- **Models are ONNX.** One `.onnx` file runs via `ort` with CoreML EP on Apple and WebGPU / WASM-SIMD EP in the browser.
- **Reuse `raw-core` — do not fork.** Decode, demosaic (HA + AMaZE-refined), WB, DCP, matrices, and Luv gamut map already exist and are under active development in Phase A. Panorama consumes their output; a small `raw-core::decode_for_pano` helper (see § 4.1) stops the existing pipeline before the two display-prep steps (capture sharpening, histogram matching) so alignment features aren't biased.

## 4. Pipeline Stages

### 4.1 Ingest

The existing `raw-ffi` / `raw-wasm` flow runs eight stages end-to-end:

```
decode_raw → demosaic (AMaZE-refined or half-res) → apply_white_balance
→ apply_dcp (ForwardMatrix + HSM + LookTable + BaselineExposureOffset)
→ apply_matrix(prophoto_to_srgb)
→ capture_sharpening (Richardson-Lucy)            ← DISPLAY PREP: skip for pano
→ histogram_match (against embedded preview)      ← DISPLAY PREP: skip for pano
→ linear_to_rgba_f32  or  linear_to_srgb_u8       ← output encoding
```

For panorama ingest we need:

1. Stop after `apply_dcp`. Do **not** apply `prophoto_to_srgb`, `capture_sharpening`, or `histogram_match`. Capture sharpening blurs a sharpening kernel into the image — fine for display, measurably bad for feature matching. Histogram matching biases tone per-image against an embedded JPEG preview whose CDF will differ frame-to-frame — that defeats pairwise gain compensation.
2. Keep output in **ProPhoto linear f32**.
3. Preserve EXIF orientation via `rotate_rgba_f32` so alignment respects the captured framing.

Concretely, add to `raw-core`:

```rust
// raw-pipeline/crates/raw-core/src/lib.rs (new thin helper, mirrors the
// existing raw-ffi/raw-wasm pipelines up to apply_dcp)
pub struct PanoIngest {
    pub image:       DemosaicedImage,  // interleaved R,G,B,R,G,B,... f32 in ProPhoto linear
    pub orientation: u16,
    pub metadata:    DngMetadata,
}

pub fn decode_for_pano(bytes: &[u8], dcp: Option<&[u8]>) -> Result<PanoIngest, DecodeError>;
```

The helper reuses `decode_raw`, `demosaic_amaze::demosaic_amaze_refined`, `apply_white_balance`, `DcpProfile::build`, `apply_dcp`, and `rotate_rgba_f32`. It skips capture sharpening, histogram matching, and the ProPhoto→sRGB matrix. No new math — it's a composition of existing raw-core functions.

JPEG / HEIF / PNG ingest uses `jpeg-decoder` (already a raw-core dep) plus a new `libheif-rs` dep, feature-flagged native-only — browsers can't link libheif, and browser panoramas of JPEGs are common enough that HEIF support can land later.

**Internal buffer type for pano-core:**

```rust
pub struct PanoImage {
    pub pixels:   Vec<f32>,       // interleaved RGB, ProPhoto linear
    pub width:    u32,
    pub height:   u32,
    pub color:    ColorSpace,     // Primaries + white point + transfer = Linear
    pub validity: BitVec,         // 1 bit per pixel — warping creates invalid regions
}
```

### 4.2 Feature Detection

- **Trait:**
  ```rust
  pub trait FeatureDetector: Send + Sync {
      fn detect(&self, img: &PanoImage) -> Result<Features, PanoError>;
  }
  ```
- **Implementations:**
  - `OrbDetector` — classical, pure Rust via `imageproc`. Always available.
  - `AlikedDetector` (feature = `ml-aliked`) — ALIKED via ONNX. Apache-2.0, commercially safe.
  - `SuperPointDetector` (feature = `ml-superpoint`) — research-license; **off by default**.
- **Default:** ALIKED when ML features are on and the runtime supports the EP (CoreML on Apple, WebGPU or WASM-SIMD in browser); ORB otherwise.

### 4.3 Feature Matching

- **Trait:**
  ```rust
  pub trait FeatureMatcher: Send + Sync {
      fn match_pairs(&self, a: &Features, b: &Features) -> Result<Matches, PanoError>;
  }
  ```
- **Implementations:**
  - `BruteForceMatcher` — pure Rust; for ORB descriptors.
  - `LightGlueMatcher` (feature = `ml-lightglue`) — ONNX LightGlue (ALIKED- or DISK-paired). Apache-2.0.
- **RANSAC:** USAC-MAGSAC via `arrsac`. Outputs filtered inliers + pairwise homography estimate.

### 4.4 Bundle Adjustment

- **Approach:** Global rotation-based BA for rectilinear/cylindrical panoramas; per-image focal + rotation + optional radial distortion (k1, k2).
- **Solver:** `argmin` with Levenberg-Marquardt. Ceres FFI is parked until measurably painful (> ~50 images with loop closure).
- **Initialization:** pairwise homographies → MST over the match graph → linear init before nonlinear refinement.
- **Output:** per-image camera `{ K, R, distortion }` in a common world frame.

### 4.5 Projection & Warping

- **v1 projections:** rectilinear, cylindrical. Spherical (equirect) as a stretch.
- **Trait:**
  ```rust
  pub trait Warper: Send + Sync {
      fn warp(&self, img: &PanoImage, cam: &Camera, target: &Projection)
          -> Result<PanoImage, PanoError>;
  }
  ```
- **Implementations:**
  - `CpuWarper` — trilinear interpolation, pure Rust. Always available.
  - `GpuWarper` — `wgpu` compute shader, preferred. Metal on Apple, WebGPU in browser, Vulkan/DX12 elsewhere.
- **Large-parallax mode:** optional TPS (thin-plate spline) mesh warp driven by matched inliers, à la UDIS++. Gated behind the `parallax_mode` pipeline option.
- **Anti-aliasing:** pre-filter with a mipmap pyramid when output scale < input scale.

### 4.6 Seam Finding

- **Default:** graph-cut min-cost seam in the overlap region. Cost = luminance gradient + color difference + edge-aware term (hides seams in high-frequency regions).
- **Implementation:** `pathfinding` (actively maintained, pure Rust, provides max-flow / min-cut primitives) rather than `rs-graph`. Confirm in Step P1 that `pathfinding`'s max-flow perf is acceptable on 120 MP; fall back to a vendored Boykov–Kolmogorov port if not.
- **Optional:** learned composition masks from UDIS++ (feature = `ml-udis`), loaded as ONNX. Useful for handheld parallax scenes. **Research license — opt-in only, never shipped as default.**

### 4.7 Color & Exposure Compensation

- Pairwise gain solve on overlap regions, then global least-squares (Brown & Lowe). Per-channel in ProPhoto linear.
- Optional vignette estimation from overlap intensity falloff.
- **No tone mapping.** Core Image / WebGL display encoding handles that downstream, the same way the RAW pipeline does today.

### 4.8 Blending

- **Multi-band Laplacian pyramid blend**, implemented as a `wgpu` compute pipeline.
- Bands: 5–7 levels, determined by output resolution.
- All math in ProPhoto linear f32. This is the single biggest quality differentiator from enblend-era tools.
- **CPU fallback** for WASM targets without WebGPU (Safari lagging): same algorithm, `rayon`-parallel on native; single-threaded in WASM until SharedArrayBuffer + COOP/COEP is enabled.

### 4.9 Export

Two handoff shapes:

- **Native (Apple):** write a linear **ProPhoto f16** RGBA buffer across the FFI boundary. `MapleCore.Panorama.PanoramaExport` wraps it in a `CIImage(bitmapData:…, colorSpace: CGColorSpace(name: .genericRGBLinear))` tagged with the ProPhoto primaries, and routes it through the _existing_ `ExportEngine`.
  - **Caveat — required extension:** `ImageEditPipeline.renderToData` currently hardcodes `CGColorSpace(name: CGColorSpace.sRGB)` for all four formats (JPEG / HEIC / PNG / TIFF) — see `Packages/MapleCore/Sources/MapleCore/Pipeline/ImageEditPipeline.swift` lines 132–146. Panorama output through this path would be sRGB-clamped. Step P5 adds an `outputColorSpace:` parameter (Display P3 / ProPhoto / sRGB) to `renderToData` and threads it through `ExportConfiguration`. The same change benefits regular Phase 2 exports (wide-gamut TIFF is currently impossible).
- **Web:** write **PNG16** directly from WASM (`png` crate, already pure Rust and small). JPEG XL via `jxl-oxide` lands in Step P7 as a stretch. 16-bit TIFF in the browser is punted — see Open Questions (§ 12).

## 5. Public API

```rust
// crate: raw-pipeline/crates/pano-core

pub struct Pipeline {
    detector: Box<dyn FeatureDetector>,
    matcher:  Box<dyn FeatureMatcher>,
    bundler:  Box<dyn BundleAdjuster>,
    warper:   Box<dyn Warper>,
    seamer:   Box<dyn SeamFinder>,
    blender:  Box<dyn Blender>,
    options:  PipelineOptions,
}

pub struct PipelineOptions {
    pub projection:     Projection,      // Rectilinear | Cylindrical | Spherical
    pub output_color:   ColorSpace,      // defaults to ProPhoto linear
    pub max_dimension:  u32,
    pub parallax_mode:  ParallaxMode,    // Homography | TpsMesh
    pub progress:       Option<ProgressCallback>,
}

impl Pipeline {
    pub fn builder() -> PipelineBuilder { /* … */ }
    pub async fn stitch(&self, inputs: &[PanoInput]) -> Result<PanoImage, PanoError>;
}

pub enum PanoInput {
    Path(std::path::PathBuf),
    Bytes { data: Vec<u8>, format: PanoFormat, dcp: Option<Vec<u8>> },
    Decoded(PanoImage),
}
```

Builder defaults produce the recommended SOTA pipeline (ALIKED + LightGlue + LM BA + GPU warp + graph-cut seam + multi-band blend).

## 6. Platform Targeting

### 6.1 WASM — Angular editor at `web/projects/editor`

- **Build:** `cd raw-pipeline/crates/raw-wasm && wasm-pack build --target web --features "pano,ml-aliked,ml-lightglue,gpu-wgpu"`. A new `pano` feature on `raw-wasm` conditionally re-exports `pano-core` bindings; when `pano` is off, the bundle size is unchanged from today.
- **Copy target:** same as today — `cp pkg/raw_wasm_bg.wasm pkg/raw_wasm.js pkg/raw_wasm.d.ts pkg/raw_wasm_bg.wasm.d.ts ./web/projects/editor/src/assets/raw-wasm/`.
- **Angular integration:** today's `RawDecoderService` (`web/projects/editor/src/app/services/raw-decoder.service.ts`) runs WASM **on the main thread** (`@Injectable({ providedIn: 'root' })`, no Worker wrap). That's fine for single-image decode, but panorama-scale compute blocks the UI. We add:
  - `web/projects/editor/src/app/services/panorama.service.ts` — Angular-facing API.
  - `web/projects/editor/src/app/workers/panorama.worker.ts` — Web Worker that owns the WASM instance for the panorama feature. A worker refactor is net-new infrastructure; Phase D of the pipeline rewrite (`docs/maple-maple-pipeline-rewrite-tdd-v2.md`) already prescribes worker-protocol work, so pano rides on that chassis rather than forking it.
- **Runtime details:**
  - **OPFS** to stage DNGs; they're too big for `FileReader` in memory.
  - **SharedArrayBuffer + wasm threads** via COOP/COEP headers for parallel pyramid construction. COOP/COEP breaks some iframe embeddings — acceptable for our editor; documented for external callers.
  - ONNX Runtime Web with WebGPU EP (Chrome/Edge) or WASM-SIMD EP (Safari fallback).
- **Payload budget:** < 15 MB initial bundle. ONNX models lazy-loaded on first stitch. Models are ~5 MB (ALIKED) + ~13 MB (LightGlue).
- **Canvas color-space:** the WebGL canvas is tagged `colorSpace: 'srgb'` in `webgl-pipeline.ts` (see `CLAUDE.md` § "Canvas color-space"). Panorama export to the canvas keeps that boundary — ProPhoto linear from pano-core → sRGB-encoded u8 in the final fragment shader, same as the RAW display path.

### 6.2 Apple — `RawPipeline.xcframework` → `MapleCore`

- **Build chain:** `raw-pipeline/scripts/build-apple.sh` already targets `aarch64-apple-darwin`, `aarch64-apple-ios`, `aarch64-apple-ios-sim` (no x86_64, no Mac Catalyst — see `CLAUDE.md`). We:
  - extend `raw-pipeline/crates/raw-ffi/src/lib.rs` with new `pano_*` entry points,
  - extend `raw-pipeline/include/raw_pipeline.h` with their C prototypes (the header is generated inline inside `build-apple.sh` — we add the pano block there),
  - `module.modulemap` requires no change (it already re-exports `raw_pipeline.h`).
- **Distribution stays the same:** `RawPipeline.xcframework` is declared as a `binaryTarget` in `raw-pipeline/RawPipeline/Package.swift`; the thin Swift wrapper `raw-pipeline/RawPipeline/Sources/RawPipeline/RawPipeline.swift` imports the C module `RawPipelineXC`. We extend that file (or add a sibling `Panorama.swift` alongside the existing `DemosaicedImage`).
- **High-level API for app code** lives in a **new directory** at `Packages/MapleCore/Sources/MapleCore/Panorama/`:
  - `PanoramaEngine.swift` — async facade over the FFI (`PanoramaEngine.stitch(assets:progress:)`), mirrors `RAWDecodeEngine.swift` in shape.
  - `PanoramaSource.swift` — resolves `ImageAsset` inputs (filesystem, PhotoKit, SMB) into byte slices + optional DCP bytes for the FFI. Reuses `LibrarySource.fullImageData(for:)`.
  - `PanoramaExport.swift` — wraps the output buffer in a `CIImage` and hands it to `ExportEngine`. Depends on the `outputColorSpace:` extension to `ImageEditPipeline.renderToData` (see § 4.9).
- **FFI boundary (same opaque-handle + accessors pattern as `DemosaicedHandle`):**

  ```c
  /* Added to raw-pipeline/include/raw_pipeline.h */
  typedef struct PanoHandle PanoHandle;

  typedef struct {
      uint32_t projection;        /* 0 rectilinear | 1 cylindrical | 2 spherical */
      uint32_t parallax_mode;     /* 0 homography | 1 tps_mesh */
      uint32_t max_dimension;     /* 0 = unconstrained */
  } PanoOptions;

  int32_t pano_stitch(
      const uint8_t *const *inputs,
      const size_t *input_lens,
      size_t n_inputs,
      const uint8_t *const *dcps,      /* parallel array; entry may be null */
      const size_t *dcp_lens,
      const PanoOptions *options,
      PanoHandle **out_handle
  );
  uint32_t       pano_get_width(const PanoHandle *);
  uint32_t       pano_get_height(const PanoHandle *);
  /* Returns a linear ProPhoto f16 buffer, RGBA, row-major. */
  const uint16_t *pano_get_pixels_f16(const PanoHandle *);
  size_t         pano_get_pixels_len(const PanoHandle *);   /* elements, not bytes */
  void           pano_free(PanoHandle *);
  ```

- **ML:** ONNX Runtime with the **CoreML execution provider** — transparently uses the Neural Engine.
- **GPU:** `wgpu` on Metal backend. Same shaders as WASM.
- **Model delivery:** bundle ALIKED + LightGlue as SwiftPM resources under `raw-pipeline/RawPipeline/Resources/` via `.process("Resources")` on the `RawPipeline` target (the existing `Package.swift` does not yet declare resources — Step P5 adds them). Loader uses `Bundle.module.url(forResource:withExtension:)`, mirroring how `CustomKernels` is already shipped in `MapleCore`. Hash-pin in `models.toml`, verify at load.
- **Swift test auto-pickup:** `verify-native` already runs `swift test --package-path Packages/MapleCore` and `swift test --package-path raw-pipeline/RawPipeline`. Any `PanoramaTests.swift` added under `Packages/MapleCore/Tests/MapleCoreTests/` or `raw-pipeline/RawPipeline/Tests/` is exercised automatically — **no justfile change required for Swift-side pano tests.**
- **App-side targets:** `Maple.xcodeproj` contains `MapleTests` (unit) and `MapleUITests` (integration). UI tests for the panorama workflow go in the latter; they're not gated by `verify-native` today (XCTest runs are stubbed pending Phase E.1 — see `justfile` `_not_yet_wired`).

### 6.3 Optional Apple fast path

A Swift-side facade in `MapleCore.Panorama` can short-circuit to Apple frameworks when the input is JPEG/HEIF and the user picks the **"Quick"** preset:

- `VNImageHomographicAlignmentRequest` for alignment
- `MPSImageLaplacianPyramid` for blending
- `vImage` for resampling

This is the approach currently named in `photo-app-feature-spec.md` § "Panorama stitching pipeline." **This spec supersedes that prescription** — the feature-spec path becomes the _Quick preset_, and the Rust-core path becomes the _Quality preset_ and the default on DNG. The feature-spec entry should be updated to reflect the dual-preset model when this spec is accepted (tracked in Open Question #7).

DNG input or the Quality preset always goes through the Rust core.

## 7. Data Model & Color

- **Internal buffer:** `PanoImage` with explicit `ColorSpace { primaries, white_point, transfer: Linear }`. Default primaries = ProPhoto (ROMM RGB), white point = D50, transfer = linear — matches the pre-output working space in `raw-core`.
- **Color math library:** small local helpers reusing `raw_core::matrices` (already exposes `XYZ_D50_TO_PROPHOTO`, `PROPHOTO_TO_XYZ_D50`, `BRADFORD_D50_TO_D65`, `SRGB_TO_XYZ_D65`, etc.) plus `palette` for type-level tracking. No sRGB assumptions anywhere in `pano-core`.
- **Alpha / validity:** every buffer carries a 1-bit `BitVec` validity mask. Warping creates invalid regions; blending respects them.
- **Pixel layout:** interleaved RGB f32 by default (matches `raw_core::demosaic::DemosaicedImage`). A planar view is available for SIMD-heavy stages (ORB, pyramid construction) via zero-copy reinterpretation helpers.
- **FFI output:** linear **ProPhoto f16 RGBA**, row-major, interleaved — Core Image handles f16 natively; WebGL2 reads `R16F`/`RGBA16F`. On the Swift side the buffer is wrapped by a `CGColorSpace` whose primaries are ProPhoto (use `CGColorSpace(iccData: …)` with the pinned ProPhoto ICC, or the synthesized `CGColorSpace.genericRGBLinear` plus a `CIColorMatrix` — choose in Step P5 based on which Core Image tone-mapping path gives the cleanest result).

## 8. Performance Targets

| Scenario                                     | Target            |
| -------------------------------------------- | ----------------- |
| 6× 24 MP DNG → 120 MP panorama, M-series Mac | < 12 s end-to-end |
| 6× 24 MP DNG, iPhone 15 Pro                  | < 30 s            |
| 6× 12 MP JPEG, Chrome WASM (WebGPU)          | < 15 s            |
| 6× 12 MP JPEG, Safari WASM (no WebGPU)       | < 60 s            |
| Peak memory, 120 MP output                   | < 6× input size   |

Feature detection/matching dominates; every other stage is < 20% of wall time on a well-tuned build.

Enforced by a dedicated `verify-pano-perf` justfile recipe (§ 10), paralleling the existing `verify-perf` stub. Wiring perf into CI is a P4 deliverable.

## 9. Dependencies

Added to the existing `raw-pipeline/` workspace — **not a new workspace**. `raw-core`'s current deps (`rawler`, `rayon`, `bytemuck`, `tiff`, `jpeg-decoder`) stay put; `pano-core` only pulls in what's new.

### Rust — `raw-pipeline/crates/pano-core/Cargo.toml`

```toml
[package]
name = "pano-core"
version = "0.1.0"
edition = "2024"

[dependencies]
raw-core    = { path = "../raw-core" }      # reuse decode/demosaic/color/DCP/matrices
imageproc   = "0.25"                        # ORB + general image primitives
nalgebra    = "0.33"                        # BA, homography algebra
argmin      = "0.10"                        # LM solver
arrsac      = "0.10"                        # RANSAC (USAC-MAGSAC)
wgpu        = "23"                          # GPU warp + pyramid + blend
bytemuck    = "1"                           # already in raw-core; re-pin here
palette     = "0.7"                         # type-level color-space tracking
bitvec      = "1"                           # validity masks
pathfinding = "4"                           # graph-cut max-flow / min-cut primitives
thiserror   = "2"
tracing     = "0.1"
rayon       = "1"                           # CPU parallelism; no-op in WASM
half        = "2"                           # f16 for FFI output

[dependencies.ort]
version          = "2"
default-features = false
features         = ["load-dynamic"]

[target.'cfg(target_arch = "wasm32")'.dependencies]
wasm-bindgen         = "0.2"
wasm-bindgen-futures = "0.4"

[features]
default        = ["ml-aliked", "ml-lightglue", "gpu-wgpu"]
ml-aliked      = ["ort"]
ml-lightglue   = ["ort"]
ml-superpoint  = ["ort"]     # research license — never default
ml-udis        = ["ort"]     # parallax composition — opt-in
ml-depth       = ["ort"]     # depth-aware blend — opt-in
gpu-wgpu       = ["wgpu"]
heif           = []          # libheif-rs, native-only; off by default
```

`raw-wasm` and `raw-ffi` each gain a `pano` feature that pulls `pano-core` in as an optional dep:

```toml
# raw-pipeline/crates/raw-wasm/Cargo.toml  (additions)
[features]
default = []
pano    = ["pano-core", "pano-core/ml-aliked", "pano-core/ml-lightglue"]

[dependencies]
pano-core = { path = "../pano-core", optional = true }

# raw-pipeline/crates/raw-ffi/Cargo.toml  (symmetric)
```

Workspace root (`raw-pipeline/Cargo.toml`) gains `"crates/pano-core"` in its `members` list.

### Models (ONNX, fetched at build or first-run)

| Model                     | Size   | License    | Source              |
| ------------------------- | ------ | ---------- | ------------------- |
| ALIKED-t16                | ~5 MB  | Apache-2.0 | LightGlue-ONNX repo |
| LightGlue (ALIKED-paired) | ~13 MB | Apache-2.0 | LightGlue-ONNX repo |
| UDIS++ composition        | ~25 MB | Research   | `nie-lang/UDIS2`    |
| Depth Anything v2 (small) | ~25 MB | Apache-2.0 | DepthAnything repo  |

Pinned by SHA-256 in `raw-pipeline/crates/pano-core/models/models.toml`. Native: bundled as SwiftPM resources in the `RawPipeline` target. Web: lazy-loaded from `/assets/pano-models/` with SHA verification.

## 10. Testing, Benchmarks & Verifier Harness

The project gates every phase through `justfile` recipes (see the `verify-*` targets and the `_not_yet_wired` stubs). Panorama follows the same pattern and plugs into the existing `compare_images.py` metric tooling instead of inventing a new one.

### Metric choice

- **Primary gate: mean ΔE 2000** via `scripts/compare_images.py` (PIL + numpy, already produces mean/max ΔE 2000, brightness bias, saturation bias). This is the same metric `scripts/test_color_pipeline.sh` uses to gate the RAW color pipeline — consistent bar across phases.
- **Secondary gate: inter-frame consistency.** Per-overlap-region ΔE after gain compensation should be < 3 — this catches blend mistakes the full-image ΔE would average out.
- **Stretch: LPIPS.** Useful for perceptual structure checks (seam visibility), but requires `torch` + `torchvision` or an ONNX LPIPS model in CI. Not in the P1–P5 critical path; added in Step P7.

### Justfile additions

```
# ---------------------------------------------------------------------------
# verify-pano — Phase 4. pano-core unit tests + clippy + fmt.
# ---------------------------------------------------------------------------
verify-pano:
    cd raw-pipeline && cargo test -p pano-core --all-targets
    cd raw-pipeline && cargo clippy -p pano-core --all-targets -- -D warnings
    cd raw-pipeline && cargo fmt -p pano-core --check

# verify-pano-golden — stitch the corpus, gate on mean ΔE 2000 vs reference.
#   Budget tightens across Phase 4 iterations (see § 11). Args forwarded to
#   scripts/test_pano_pipeline.sh, which uses compare_images.py under the hood.
verify-pano-golden budget="8":
    scripts/test_pano_pipeline.sh --max-delta-e {{budget}}

# verify-pano-perf — wall-time gate on the reference 6× 24 MP corpus.
verify-pano-perf:
    scripts/bench_pano.sh
```

`verify-all` is extended to include `verify-pano verify-pano-golden` when Step P1 lands; the existing `verify-rust` target already picks up `cargo test --workspace --all-targets`, so pano-core unit tests are caught by `verify-rust` the moment the crate is added to the workspace — the dedicated `verify-pano` recipe is a convenience for iteration.

### Test strategy

- **Golden corpus at `test-fixtures/pano/`.** 12 scenes (low-texture, parallax-heavy, HDR-lit, night, architectural, landscape). Symlinks permitted, matching the existing `test-fixtures/raws/dji-mavic3pro-100mp.dng` pattern. Reference panoramas (the engine / Hugin / hand-curated) live at `test-fixtures/pano/references/`.
- **Stage-isolated unit tests.** Mirrors `raw-core`'s 94+ test pattern. Each trait has a mock; per-stage integration tests in `crates/pano-core/tests/`.
- **Swift round-trip tests** at `Packages/MapleCore/Tests/MapleCoreTests/PanoramaTests.swift` — automatically picked up by `verify-native`'s `swift test --package-path Packages/MapleCore`. Verifies stitching → `CIImage` → `ExportEngine` round-trip on a small corpus.
- **Bench harness:** `criterion` for CPU stages; `wgpu` timestamp-query bench for GPU. Wire into `verify-pano-perf`.
- **Cross-platform CI:** extend the existing matrix (x86_64 Linux, arm64 macOS, wasm32). iOS validated by the same path as the rest of the project.

### Scripts to add

```
scripts/test_pano_pipeline.sh   # wraps a pano smoke binary + compare_images.py
scripts/bench_pano.sh           # criterion + timestamp-query runs, per-stage breakdown
scripts/gen-pano-references.sh  # regenerate test-fixtures/pano/references/*.png from
                                # the engine / Hugin / hand-curated sources (parallels
                                # scripts/gen-golden-fixtures.sh)
```

## 11. Build Steps — Phase 4 iterations

Numbered P1–P7 so they don't collide with the existing Phase A–F task tree in `tasks.md`. Each step is gated by its verifier; the box isn't checked until the gate exits 0 (matching `docs/maple-maple-pipeline-rewrite-tdd-v2.md` rule 5).

### Step P1 — Skeleton & classical baseline

**Scope**

- Create `raw-pipeline/crates/pano-core/`. Add to workspace members.
- Trait definitions; `PanoImage` type; color module reusing `raw_core::matrices`.
- `raw-core::decode_for_pano` helper (§ 4.1 — composition of existing raw-core fns; no new DSP).
- ORB (`imageproc`) + brute-force matcher + linear LM BA (`argmin`) + CPU warp + multi-band blend (CPU, `rayon`).
- `pathfinding`-based graph-cut seam.
- Smoke binary `pano-smoke` under `raw-pipeline/crates/pano-core/src/bin/` that accepts 2–8 images and writes a PNG16 result.

**Verifier**

- `verify-rust` (picks up pano-core unit tests automatically).
- `verify-pano-golden --max-delta-e 15` on a 2-image easy-scene subset of the corpus. This matches the current `verify-rust` ΔE budget (which is already at 8 for raw) — pano starts looser and tightens.

### Step P2 — Linear raw workflow

**Scope**

- Wire `raw-core::decode_for_pano` as the default `PanoInput::Bytes` handler for RAW formats.
- Stay in ProPhoto linear end-to-end; export via PNG16 (web) or Core Image (native placeholder — full wiring in P5).
- Add `f32` + `f16` output handles to `raw-ffi` and `raw-wasm` behind the `pano` feature.

**Verifier**

- `verify-pano-golden --max-delta-e 10` on the full 12-scene corpus.
- `verify-color-pipeline` (existing) remains green — single-image raw decode must not regress.

### Step P3 — Neural matching

**Scope**

- `ort` integration. ALIKED + LightGlue ONNX, CPU EP first (WebGPU/CoreML deferred to Step P4).
- Feature-flag `ml-lightglue` on by default when available.

**Verifier**

- `verify-pano-golden --max-delta-e 6`.
- Low-texture subset of the corpus shows measurable inlier-count + ΔE improvement vs ORB baseline (tracked in `scripts/bench_pano.sh` output).

### Step P4 — GPU warp & blend

**Scope**

- `wgpu` compute pipelines for warp, pyramid construction, blend. Metal + WebGPU + Vulkan validated.
- ONNX EPs: CoreML on Apple, WebGPU-or-WASM-SIMD in browser.

**Verifier**

- `verify-pano-perf` green against the § 8 targets.
- `verify-pano-golden --max-delta-e 6` (unchanged — perf step must not regress quality).

### Step P5 — Platform packaging

**Scope**

- Extend `raw-pipeline/include/raw_pipeline.h` (via `build-apple.sh`'s inline heredoc) with `pano_*` prototypes.
- Extend `raw-pipeline/crates/raw-ffi/src/lib.rs` with `pano_stitch` + accessors + `pano_free`.
- Rebuild `RawPipeline.xcframework` via `scripts/build-apple.sh`.
- Extend `raw-pipeline/RawPipeline/Sources/RawPipeline/` with Swift wrapper types for `PanoHandle`.
- **New: extend `ImageEditPipeline.renderToData` (and `ExportConfiguration`) with `outputColorSpace:` (enum `.sRGB | .displayP3 | .proPhoto`).** Default stays `.sRGB` for backwards compat; pano uses `.proPhoto`. This is the blocker for shipping wide-gamut stitched output (§ 4.9).
- Add `Packages/MapleCore/Sources/MapleCore/Panorama/{PanoramaEngine,PanoramaSource,PanoramaExport}.swift`.
- Add `Packages/MapleCore/Tests/MapleCoreTests/PanoramaTests.swift` (picked up automatically by `verify-native`).
- Web side: `web/projects/editor/src/app/services/panorama.service.ts` + `workers/panorama.worker.ts`. Rides on the Phase D worker protocol.
- `papp:` XMP schema for panorama source lists defined in `docs/xmp-canonical-format.md` (see Open Question #8).

**Verifier**

- `verify-pano`, `verify-pano-golden --max-delta-e 5`, `verify-native`, `verify-web` (once Phase D lands), `verify-apple-builds`.
- `verify-xmp` — round-trips a sidecar containing `papp:panorama/...` source-list elements without loss.

### Step P6 — Parallax mode

**Scope**

- UDIS++ TPS warp + composition mask option, behind `ml-udis` (opt-in, never default).
- Depth-aware blend (Depth Anything v2 ONNX, `ml-depth`).

**Verifier**

- `verify-pano-golden --max-delta-e 4` on the parallax-heavy corpus subset.

### Step P7 — Polish

**Scope**

- LPIPS gate (stretch metric).
- ICC round-trip tests for ProPhoto → Display P3 → sRGB export paths.
- Example CLI (`pano-cli` binary, native-only).
- Cross-comparison doc vs the engine / Hugin.

**Verifier**

- `verify-pano-golden --max-delta-e 3` on full corpus.
- `verify-pano-perf` within § 8 targets on both macOS + iPhone.

Steps P1–P5 define the shippable Phase 4 MVP. Steps P6–P7 are ongoing quality tracks.

## 12. Open Questions

1. **TIFF writer in WASM.** The `tiff` crate is already a `raw-core` dep — size-heavy but usable. PNG16 is smaller and already native-Rust. Leaning **PNG16 + (later) JXL in browser; TIFF only via the native `ExportEngine` path.** Decide in P5.
2. **Ceres vs. argmin for BA.** Start `argmin`-only; add Ceres FFI behind `feature = "ceres-native"` if large-loop-closure panoramas surface in testing.
3. **Model delivery.** Native: bundle via SwiftPM resources (simple, +~20 MB to the xcframework package). Web: lazy-load, SHA-pinned. Both paths pin identical SHAs in `raw-pipeline/crates/pano-core/models/models.toml`.
4. **Threading in WASM.** SharedArrayBuffer requires COOP/COEP — breaks some iframe embeddings. Acceptable for the editor; document for external callers.
5. **DNG write-out of a stitched panorama.** Stitched images are no longer sensor-native. Default to "no" and close unless a concrete use case shows up.
6. **UDIS++ licensing.** Research license. Personal-use only; gated behind `ml-udis` opt-in; never default.
7. **Feature-spec reconciliation.** `photo-app-feature-spec.md` § "Panorama stitching pipeline" currently prescribes Vision + Metal + vImage. If this spec is accepted, that section updates to describe the Quick vs. Quality preset split (Vision fast path + Rust core default).
8. **`papp:` panorama source-list schema.** Needs a concrete definition in `docs/xmp-canonical-format.md` before Step P5 — fields under discussion: source paths (absolute vs. bookmark-relative), XMP hash pin, per-frame focal length and EV, alignment cache (homography matrix, BA residuals), output dimensions, projection, preset (Quick/Quality). Block P5 on this.
9. **Seam-finding library.** Spec prescribes `pathfinding`; `rs-graph` is an alternative. Validate `pathfinding`'s max-flow perf on 120 MP overlap graphs in P1; fall back to a vendored Boykov–Kolmogorov port if it's the bottleneck.
10. **`ImageEditPipeline.renderToData` color-space extension.** Not panorama-specific — also unblocks wide-gamut TIFF export from the regular adjustment pipeline. Whoever lands Phase 3 (Color Engine) is the natural owner; pano coordinates with that work rather than forking it. If Phase 3 doesn't ship the extension, P5 adds it inline.

## 13. Directory Layout

```
raw-pipeline/                            # existing Cargo workspace
├── Cargo.toml                           # members += "crates/pano-core"
├── crates/
│   ├── raw-core/                        # existing; gains `decode_for_pano` helper
│   ├── raw-ffi/                         # existing; gains `pano_*` entry points
│   ├── raw-wasm/                        # existing; gains `pano` feature
│   └── pano-core/                       # NEW
│       ├── Cargo.toml
│       ├── src/
│       │   ├── lib.rs
│       │   ├── bin/pano-smoke.rs        # reference CLI
│       │   ├── features/                # ORB, ALIKED
│       │   ├── matching/                # brute force, LightGlue
│       │   ├── ba/                      # bundle adjustment (argmin LM)
│       │   ├── warp/                    # CPU + wgpu warpers
│       │   ├── seam/                    # pathfinding graph cut + UDIS mask
│       │   ├── blend/                   # multi-band Laplacian, CPU + wgpu
│       │   └── color/                   # gain/vignette compensation
│       ├── shaders/                     # wgsl compute shaders
│       │   ├── warp.wgsl
│       │   ├── pyramid_down.wgsl
│       │   ├── pyramid_up.wgsl
│       │   └── blend.wgsl
│       ├── models/
│       │   └── models.toml              # SHA-pinned model manifest
│       └── tests/                       # stage-isolated integration tests
├── include/
│   ├── raw_pipeline.h                   # existing; pano prototypes appended
│   └── module.modulemap                 # existing; unchanged
├── scripts/
│   └── build-apple.sh                   # existing; heredoc block extended
├── RawPipeline/                         # existing Swift package
│   ├── Package.swift                    # Step P5: add .process("Resources") for ONNX
│   ├── Resources/                       # NEW in P5 — ONNX models
│   └── Sources/
│       ├── RawPipeline/                 # Panorama.swift added here
│       └── RawPipelineSmoke/            # existing CLI
└── RawPipeline.xcframework/             # generated

Packages/MapleCore/Sources/MapleCore/
├── Pipeline/                            # existing; renderToData gains outputColorSpace:
├── Export/                              # existing; ExportConfiguration gains colorSpace
├── Sidecar/                             # existing
└── Panorama/                            # NEW
    ├── PanoramaEngine.swift
    ├── PanoramaSource.swift
    └── PanoramaExport.swift

Packages/MapleCore/Tests/MapleCoreTests/
└── PanoramaTests.swift                  # NEW — auto-run by verify-native

web/projects/editor/src/
├── assets/
│   ├── raw-wasm/                        # existing; receives bundle rebuilt with `pano` feature
│   └── pano-models/                     # NEW — lazy-loaded ONNX
└── app/
    ├── services/
    │   ├── raw-decoder.service.ts       # existing
    │   └── panorama.service.ts          # NEW
    └── workers/
        └── panorama.worker.ts           # NEW — wraps pano-enabled raw_wasm in a Worker

test-fixtures/
├── raws/                                # existing; used by verify-color-pipeline
├── references/                          # existing
├── golden/                     # existing
└── pano/                                # NEW
    ├── corpus/                          # 12 input scenes (symlinks OK)
    └── references/                      # reference stitched panoramas

scripts/
├── test_color_pipeline.sh               # existing
├── compare_images.py                    # existing — ΔE 2000 gate tool
├── test_pano_pipeline.sh                # NEW — invoked by verify-pano-golden
├── bench_pano.sh                        # NEW — invoked by verify-pano-perf
└── gen-pano-references.sh               # NEW — regenerates references/
```

## 14. Out-of-Scope but Adjacent

- Share the feature / matching / BA stack with a future **Maple focus-stacking** and **exposure-bracket merging** feature — all three problems share alignment.
- **Gigapixel mode** (motorized pan head, hundreds of frames) — pipeline handles it if BA switches to Ceres; UI doesn't. Park.
- **Live video stitching** — explicitly out of scope. Different real-time constraints.
- **`papp:` panorama source-list schema** — tracked under `docs/xmp-canonical-format.md`; not blocked on this spec but consumed by Step P5.
- **`renderToData` output-color-space extension** — not panorama-specific; tracked with the Phase 3 Color Engine work per Open Question #10.

---

_Next steps (in order):_

1. _Finish Phase A (`tasks.md` — currently on A2.6 / A3.4 per `BLOCKED.md`)._
2. _Ship Phase 3 Color Engine; bundle the `renderToData` color-space extension into that work._
3. _Draft the `papp:` panorama source-list schema in `docs/xmp-canonical-format.md`._
4. _Convert § 11 Steps P1–P5 into a new "Phase 4 — Panorama" section of `tasks.md`, each with its `verify-pano_` gate.\*
