# Maple — Architecture Overview

Maple is a professional, non-destructive RAW photo editor by Just Maple. It runs natively on macOS, iPadOS, and iOS via a **Swift + SwiftUI** shell, and in evergreen browsers via **Angular** — both backed by a **single shared Rust image-processing core**. Every edit is non-destructive and persists to XMP sidecars; originals are never touched.

The product bar is: color quality a working photographer will trust, and a slider that responds inside a single 60 Hz frame on a 100 MP RAW.

For deep dives into specific systems, see the companion docs:

- [Image Pipeline & Editing](./pipeline.md) — decode, the scene-linear chain, the view transform, render entry points
- [Caching](./caching.md) — the cache layers, locations, eviction, flow
- [Sidecar schema](./sidecar-schema.md) — the XMP contract
- [Testing](./testing.md) — parity gates and diagnostic tools

---

## One Rust core, three native pipelines

Color math — decode, demosaic, calibration (DCP), the scene-linear adjustment chain, the AgX view transform, Auto Profile, dehaze, deconvolution — lives in one crate, `src/raw-pipeline/raw-core`. That crate compiles:

- once as a **static library for Apple** (C-FFI headers via `raw-ffi` / `cbindgen`, packaged as `RawPipeline.xcframework`), and
- once as **WebAssembly for browsers** (`wasm-bindgen` bindings via `raw-wasm`).

A third consumer, the Self-Hosted API (`src/api`), loads the same core as a `bun:ffi` dylib. Platform GPU paths are idiomatic on each platform but **gated against the Rust reference** — pixel parity between Apple and Web is a merge gate, not an aspiration (see [Testing](./testing.md)).

```
                         ┌──────────────────────────────┐
                         │  raw-core  (pure Rust math)   │
                         │  decode → demosaic → DCP →     │
                         │  scene-linear chain → AgX →    │
                         │  Auto Profile → display encode │
                         └──────────────────────────────┘
                  ┌───────────────┬──────────┴──────────┬───────────────┐
                  ▼               ▼                     ▼               ▼
          raw-ffi (C-FFI)   raw-wasm (WASM)      bun:ffi dylib     raw-gpu (WGSL)
                  │               │                     │          single-sourced
                  ▼               ▼                     ▼          GPU kernels
        RawPipeline.xcframework  maple-common          src/api
                  │            (Angular consumer)    (Self Hosted)
                  ▼               │
          Swift + SwiftUI app     ▼
        (Mac / iPad / iPhone)   Angular app (Web)
```

---

## Tech stack

| Layer         | Apple                                 | Web                                                                       | Shared                          |
| ------------- | ------------------------------------- | ------------------------------------------------------------------------- | ------------------------------- |
| UI            | SwiftUI                               | Angular 21 + standalone components                                        | —                               |
| State         | `@Observable` (Observation framework) | Signals + RxJS observables                                                | —                               |
| Image decode  | Rust core via C-FFI (xcframework)     | Rust core via WASM                                                        | `raw-core` crate                |
| GPU pipeline  | wgpu + WGSL (epic #925, default)      | wgpu/WebGPU + WGSL; GPU-live default (`navigator.gpu`); WASM-CPU fallback | `raw-gpu` WGSL from Rust consts |
| Sidecar I/O   | Custom XMP writer in Swift            | Custom XMP writer in TypeScript                                           | Schema validated on both sides  |
| Thumbnails    | `CGImageSource` + disk cache          | WASM thumb extraction + IndexedDB                                         | —                               |
| API (web)     | —                                     | Angular `HttpClient` → Bun/Elysia                                         | Shared DTO types via codegen    |
| Offline (web) | —                                     | Angular service worker + IndexedDB                                        | —                               |

**GPU path (epic #925).** The render math is unified on **wgpu + WGSL**, collapsing the previously separate Metal-Shading-Language and WebGL2-GLSL implementations against the Rust reference. The GPU path is the shipping default on Apple (`MAPLE_GPU_LIVE=0` is the runtime kill-switch) and is used on the Web where `navigator.gpu` is available. The WGSL kernels (`src/raw-pipeline/raw-gpu`) bake the Oklab/Rec.2020 matrices and AgX coefficients as consts generated from the same `raw-core` sources the CPU pipeline uses, so the GPU copy cannot silently diverge.

---

## Scene-linear chain

The working space is **linear Rec.2020 D65 at f32**. The pipeline is scene-referred: exposure is a linear multiply, and a single view transform at the end compresses scene range into display range. **Nothing before the view transform clips.**

The canonical chain is `develop_scene_linear_from_raw_with_quality` in `src/raw-pipeline/raw-core/src/pipeline/develop/mod.rs`. Every full-image entry point (CLI, WASM, Apple FFI, the parity harness) funnels through it, so all platforms develop bit-identically. In order: linearize → hot-pixel → demosaic → DefaultCrop → BaselineExposure → WB pre-gain → highlight recovery → DCP colorimetry (ColorMatrix/ForwardMatrix + HSM in linear ProPhoto-D50, then gamut-convert to Rec.2020) → ProfileGainTableMap → chroma pre-filter (#1104) → BM3D deep denoise (#1105) → capture sharpening → **auto-exposure (#429)** → white balance → **scene-tone controls (#1102/#1103: exposure, brightness, contrast, highlights, shadows, whites, blacks)** → tone curves → vibrance → saturation → clarity → texture → dehaze → local adjustments → **vignette (#1109)** → sharpen → NR luminance → NR color.

The result is an unbounded scene-linear Rec.2020 buffer. The **view transform** then applies **AgX** (Sobotka AgX with filmic hue restoration and Oklab gamut compression — scene-linear → display-linear Rec.2020), **colour grading (#275)** and **film grain (#1110)** in display-linear space, an optional **Auto Profile (#536)** per-image tone residual fit from the embedded JPEG, and a final Rec.2020 → sRGB / display-P3 encode. Full stage-by-stage detail, including the per-tick chain that re-runs only the cheap stages on each slider tick, is in [Image Pipeline & Editing](./pipeline.md).

Any change to a scene-linear stage or the view transform must pass the parity harness — see [Testing](./testing.md) § "Parity gates."

---

## Module boundary — Apple

The Apple app is an Xcode project consuming a local Swift package (`MapleCore`) plus the committed `RawPipeline.xcframework`. All business logic lives in `MapleCore`; the app target holds only SwiftUI views and the design system.

```
MapleApp (app target)            MapleCore (SPM package)
├── AppShell                          ├── Pipeline/        (RawPipeline FFI wrapper,
├── BrowseMode/                       │                     EditSession, render cache)
│   ├── ImageGridView                 ├── Sidecar/         (XMP read/write, path resolver)
│   ├── SourceTreeView                ├── Library/         (view models, thumbnail loader,
├── FullImageMode/                    │                     disk cache)
│   └── FullImageView                 ├── Sources/         (Filesystem, SMB, Photos adapters)
├── DetailPanel/                      ├── Generated/       (codegen Swift: AdjustmentModel,
│   └── ColorTabView                  │                     UITokens — from tools/codegen.sh)
└── DesignSystem/ (tokens)            └── Model/           (AdjustmentModel, ImageAsset)
```

`MapleCore.Pipeline` wraps the Rust FFI: it calls into the xcframework to decode + develop a scene-linear buffer, then presents via the platform GPU path. On the default wgpu path (#1066), the f32 scene-linear buffer is uploaded and the full view transform (AgX, colour grading, grain, display encode) plus sharpen/NR run as WGSL compute shaders, presenting via wgpu → CAMetalLayer — this present path has no Core Image filter chain. The CPU/Metal fallback (`MAPLE_GPU_LIVE=0`) runs the same Rust FFI view-transform chain to produce a 3-D LUT and applies it via a `CIColorCubeWithColorSpace` filter (CoreImage) plus Metal kernels for sharpen/NR; the Rust core computes the color math, CoreImage applies it.

## Module boundary — Web

The Angular workspace has three projects: `maple` (the editor/browse app), `maple-common` (shared components, services, models, and the `raw-wasm` consumer), and `maple-syrup`. On WebGPU-capable browsers the live canvas defaults to the GPU live path (`render_bytes_gpu`); `render_bytes` (WASM-CPU) is the fallback when WebGPU is unavailable. The canvas surface is tagged **display-P3**. Cross-language model and token shapes (`AdjustmentModel`, UI tokens) are generated from `raw-core` by `tools/codegen.sh`.

---

## Cross-platform parity & codegen

Every constant and schema that appears in more than one language is single-sourced from `raw-core` and emitted by the `codegen` crate, driven by **`tools/codegen.sh`** (not a hand-maintained per-platform port):

- adjustment schema (`raw_core::types::ADJUSTMENT_SCHEMA`) → Swift + TypeScript
- UI tokens (`raw_core::ui_tokens`) → Swift + TypeScript + SCSS
- color matrices (`raw_core::color::{matrices,oklab}`) → WGSL
- AgX coefficients (`derive_agx_lut.py`) → WGSL

A `codegen-drift` CI job (in `.github/workflows/cross.yml`) confirms the committed outputs match a fresh generation, so the individual platform copies cannot drift. When a matrix or schema changes, run `tools/codegen.sh` and commit the regenerated files.

---

## Concurrency model — Apple

| Component          | Isolation    | Pattern                                                                   |
| ------------------ | ------------ | ------------------------------------------------------------------------- |
| `EditSession`      | `@MainActor` | State mutations on main; RAW decode/develop offloaded off-actor.          |
| Library view model | `@MainActor` | `loadGeneration` counter rejects stale async loads after a folder switch. |
| Thumbnail loader   | `actor`      | Concurrency-limited with continuation waiters.                            |
| XMP sidecar store  | `actor`      | Serialized read/write access to sidecar files.                            |

Folder switching uses a generation counter: every `await` boundary re-checks the generation before writing state, so rapid folder clicks land only the last selection's data. RAW decode is cancellable — a slider tick during a cold open unwinds the in-flight develop mid-stage via a cancel token (#951).

---

## XMP sidecar persistence

All edits are non-destructive; the original file is never modified. The adjustment model serializes to an XMP sidecar using the `crs:` (Camera Raw Settings) namespace for Adobe-compatible fields, plus `papp:` for Maple-specific data (`papp:Profile`, `papp:Brightness`, `papp:AutoExposure`, ratings, flags, labels). The schema is versioned and passthrough XML preserves unknown fields byte-for-byte. The Swift and TypeScript writers are validated against the same schema.

| Asset source            | Sidecar location                           |
| ----------------------- | ------------------------------------------ |
| Local filesystem        | Sibling `.xmp` file next to the original   |
| SMB network share       | Sibling `.xmp` file on the share           |
| Apple Photos (PhotoKit) | App Support directory, keyed by asset UUID |

The sidecar is the contract; the pixels are derived. See [`sidecar-schema.md`](./sidecar-schema.md).
