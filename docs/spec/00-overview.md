# 00 — Overview

Clean-room specification of Maple for a full rewrite. This document is the anchor the other nine cross-link back to.

The goal of this specification is simple: a second engineer, reading only these ten documents, should be able to produce a functionally equivalent v1 without reading a line of the existing source. Where a behavior is unclear or undocumented, it is captured in [`09-open-questions.md`](./09-open-questions.md) instead of being guessed.

---

## Elevator pitch

Maple is a non-destructive RAW photo editor with three first-class shells — macOS, iPadOS/iOS, and the web — that share a single image-processing core written in Rust. Edits live in Adobe-compatible XMP sidecars, originals are never modified, and every platform renders the same adjustment model to the same pixels (within one ΔE).

It is deliberately shaped around three premises:

1. **Portable math, native chrome.** The expensive, testable image pipeline — RAW decode, demosaic, DCP-driven color transforms, tone curves — lives in a portable Rust crate (`raw-core`). Interactive edits and display run on each platform's native GPU stack: Metal via Core Image on Apple, WebGL2 on the web.
2. **Non-destructive, round-trippable, Adobe-shaped.** Every adjustment is a field in a domain model that round-trips byte-for-byte through XMP using Adobe's `crs:` namespace. Maple sidecars open cleanly in Lightroom; Lightroom sidecars open cleanly in Maple.
3. **Three real sources, treated symmetrically.** Apple Photos (PhotoKit), the filesystem (security-scoped bookmarks), and SMB network shares (AMSMB2) all produce the same `ImageAsset` and participate in the same sidecar layer. The UI does not fork on source type.

The result is an app where an edit made on iPad over SMB is pixel-identical to the same edit made on the web client, and lossless round-trip with Lightroom is a hard invariant rather than a marketing claim.

---

## Philosophy: lineage and departures

Maple is heavily influenced by three prior art lineages, each adopted selectively.

**From Adobe Lightroom — adopted as contract.** The `crs:` XMP namespace is a well-designed, stable, reverse-engineerable schema for non-destructive RAW edits. Maple treats it as the wire format: slider ranges, default values, process-version semantics, and tone-curve representation all match Lightroom's PV11 (Process Version 2022). Adobe has effectively standardized this, and fighting it buys nothing. What Maple does *not* take from Lightroom is the catalog-centric data model — there is no single monolithic catalog file; each folder carries its own sidecars and its own lightweight per-folder metadata.

**From RawTherapee — adopted as algorithm library.** RawTherapee's color-science choices are the reference for several non-trivial algorithms: the AMaZE and Hamilton-Adams demosaic, the dual-illuminant DCP interpolation, the HueSatMap tri-linear interpolator, the vibrance skin-protection heuristic, and the Richardson-Lucy capture-sharpening variant. Maple reimplements these from the published papers plus cross-reference to RT's source, without copying code. Where RT is conservative (e.g., the 11×11 Gaussian kernel in capture sharpening), Maple's implementation stays conservative; where RT has exposed an incoherent tuning surface over the years, Maple narrows the knobs. See [`03-algorithms.md`](./03-algorithms.md) for per-algorithm lineage.

**From Darktable — adopted as pipeline philosophy, including scene-referred.** The idea that the pipeline is a declarative chain of modules, each with a pure function from input image + parameters to output image, and that the UI manipulates the parameter set rather than the image, is taken from Darktable. Maple's `AdjustmentModel` is the parameter set; the Metal pipeline on Apple and the WebGL2 fused shader on the web are two implementations of the same pure function. Maple also takes Darktable's **scene-referred** color philosophy: the interactive working space is linear Rec.2020 at scene reference (values can and do exceed 1.0), and a single **view transform** (AgX) at the end of the chain maps scene-linear to display-linear. See [`04-color-management.md`](./04-color-management.md).

**Deliberate departures from all three:**

- **No catalog.** Sidecars are authoritative. The server-side library index is a cache, not a source of truth.
- **No Combine-style reactive streams.** State is `@Observable` (Apple Observation framework) or Angular signals on the web — coarse-grained invalidation, not stream composition.
- **No pluggable pipeline order in v1.** The stage order is fixed and documented in [`02-pipeline.md`](./02-pipeline.md). Users do not reorder modules.
- **Replaceable view transform, not pluggable.** The view transform is AgX in v1. The stage is shaped as a clean interface (scene-linear in, display-linear out) so a future switch to OpenDRT or an in-house transform doesn't require rewriting the chain — but users do not pick the view transform. See [`04-color-management.md`](./04-color-management.md).

---

## Target platforms

| Platform | Deployment target | Shell | Render path |
| --- | --- | --- | --- |
| **macOS** | 26.3 (native, not Catalyst) | SwiftUI + AppKit interop | Core Image + Metal, two custom `CIColorKernel`s |
| **iPadOS / iOS** | 26.4 | SwiftUI | Core Image + Metal (same binary path as Mac) |
| **visionOS** | 26.4 | SwiftUI (scaffold only — deferred) | Core Image + Metal |
| **Web** | Evergreen Chromium/WebKit/Firefox | Angular + TypeScript | WebGL2 (RGBA32F via `EXT_color_buffer_float`) + WASM raw-core |
| **Server** | Bun runtime on Linux | Elysia + MongoDB (design phase) | No rendering — sidecar sync + thumbnails |

The iPhone collapses the three-column shell to a bottom-tab single column; the iPad in portrait tucks the left panel into a slide-in drawer. No functional surface is desktop-only. See [`07-ui-architecture.md`](./07-ui-architecture.md).

WebGPU was considered and rejected for v1 because Safari support is still landing. The web pipeline assumes WebGL2 with `EXT_color_buffer_float`; a Rust SIMD CPU fallback is a Phase 5 item.

---

## Explicit stack inventory

**Rust core (`raw-pipeline/` Cargo workspace):**

- `raw-core` — platform-agnostic: RAW decode (rawler), demosaic (bilinear, half-res quad, Hamilton-Adams, AMaZE), DCP parsing + HueSatMap interpolation, tone curves, vibrance, dehaze, local contrast, capture sharpening, auto-exposure, histogram matching, Bradford chromatic adaptation. No platform deps.
- `raw-ffi` — `crate-type = ["staticlib"]`; C ABI surface (`#[no_mangle] extern "C"`), three exported functions, opaque handle. Header generated by cbindgen. Compiled per Apple target and assembled into `RawPipeline.xcframework`.
- `raw-wasm` — `crate-type = ["cdylib"]`; wasm-bindgen surface. Built via `wasm-pack build --target web`.

**Apple (Swift):**

- `Maple` — thin app target, SwiftUI views, design tokens. Bundle ID `app.justmaple.Maple-Maple`. Info.plist is generated via `INFOPLIST_KEY_*` build settings.
- `MapleCore` — local SPM package containing all business logic: `EditSession`, `ImageEditPipeline`, `CIFilterMapping`, `XMPSidecarStore`, `RenderedPreviewCache`, library and source adapters, Metal kernels.
- `RawPipeline` — SPM wrapper around `RawPipeline.xcframework` (the Rust FFI staticlib).

**Apple dependencies:**

- `CIRAWFilter` — fallback RAW decode when rawler refuses a format.
- `CIContext` backed by `MTLDevice` — the shared GPU context.
- `CIFilter` graph — 11-stage adjustment chain. Two stages are replaced by custom `CIColorKernel` implementations (`RtToneCurve`, `RtVibrance`).
- `MetalCaptureSharpening` — proof-of-concept, **not wired** in v1.
- ImageIO (`CGImageSource`) — embedded-JPEG thumbnail extraction from RAW.
- PhotoKit — Apple Photos source.
- AMSMB2 — SMB client.
- Security-scoped bookmarks — filesystem source.

**Web (TypeScript):**

- Angular workspace with three projects: `editor` (the RAW editor), `browse` (library browser), `Maple-common` (shared models, XMP parser/serializer, domain types).
- Angular signals for reactive state; no RxJS in the adjustment loop.
- `webgl-pipeline.ts` — three GLSL programs (fused main pipeline, separable blur, unsharp mask), a triple-FBO chain to avoid Safari feedback-loop detection, canvas tagged `colorSpace: 'srgb'`.
- `raw-decoder.service.ts` — thin wrapper around the WASM `raw-core`.
- `xmp-serializer.service.ts` — byte-identical round-trip with Swift's `XMPSerializer` (see [`xmp-canonical-format.md`](../xmp-canonical-format.md)).

**Server (Bun/TypeScript, design phase):**

- Elysia HTTP framework.
- MongoDB for the library index (non-authoritative — sidecars win).
- WebAuthn/passkey authentication (deferred to Phase 5).
- Workers for background thumbnail generation and sidecar sync.

**Tooling:**

- `src/scripts/test_color_pipeline.sh` — CIEDE2000 perceptual-distance harness comparing the Rust pipeline output to the DNG's embedded preview JPEG. Gates every change to raw-core.
- `src/scripts/test-dcp-flow.js` — Playwright-driven end-to-end for the web editor.
- `src/scripts/compare_images.py` — ΔE, per-channel bias, luminance, saturation metrics.

---

## Top-level module map

One line each. "Lives in" paths are descriptive, not load-bearing — a rewrite is free to reshape them.

```
raw-core                 Pure Rust image math: decode → demosaic → color → tone → sharpen
raw-ffi                  C ABI wrapping raw-core for Apple consumers
raw-wasm                 wasm-bindgen wrapping raw-core for web consumers

RawPipeline (Swift SPM)  Thin Swift wrapper around the xcframework
MapleCore (Swift SPM)    Everything non-UI on Apple: pipeline, sidecar, sources, caches, session
Maple (app target)       SwiftUI shell: AppShell, Browse grid, FullImage, DetailPanel tabs

Maple-common (Angular)   Shared models, XMP parser/serializer, color math, type definitions
editor (Angular)         WebGL2 editor: canvas, sliders, tone-curve editor, WASM bridge
browse (Angular)         Library browser mirroring the Apple three-column shell

server (Bun)             Library index + sync endpoints + passkey auth (design phase)
```

**Where to look for what** (pointers into this spec):

| If you need to... | Start here |
| --- | --- |
| Understand the adjustment data types and their invariants | [`01-data-model.md`](./01-data-model.md) |
| Trace one RAW file from load to on-screen preview | [`02-pipeline.md`](./02-pipeline.md) |
| Understand a specific algorithm's math | [`03-algorithms.md`](./03-algorithms.md) |
| Decide what colorspace a value is in at stage X | [`04-color-management.md`](./04-color-management.md) |
| Understand caching, tiling, threading | [`05-performance.md`](./05-performance.md) |
| Understand how Swift and web stay in sync | [`06-cross-platform.md`](./06-cross-platform.md) |
| Understand the state model of the editor | [`07-ui-architecture.md`](./07-ui-architecture.md) |
| Understand sidecars, exports, library persistence | [`08-io.md`](./08-io.md) |
| See what's genuinely unresolved | [`09-open-questions.md`](./09-open-questions.md) |

---

## Non-goals for v1

Spelling these out keeps the rewrite honest.

- **Not a DAM.** No face recognition, no auto-tagging, no smart collections, no keywording UI beyond what the sidecar already carries. Library browsing exists; library *management* does not.
- **Not a compositor.** No layers, no blend modes in the adjustment model. Masking in Phase 4 produces local adjustments, not stacked raster layers.
- **Not a Lightroom feature clone.** Maple will ship without presets, before/after, and the HSL panel in Phase 2. Those are Phase 3. Shipping a narrow slice well is the goal.
- **Not cross-catalog collaborative.** Multi-user edit merge is out of scope. If two clients edit the same sidecar, last-writer-wins with a version bump; see [`08-io.md`](./08-io.md).
- **Not a plugin platform in v1.** No user-extensible pipeline. Phase 5.

---

## Reading order for the rest of this spec

If you're implementing: read [`01-data-model.md`](./01-data-model.md) → [`08-io.md`](./08-io.md) → [`02-pipeline.md`](./02-pipeline.md) → [`04-color-management.md`](./04-color-management.md) → [`03-algorithms.md`](./03-algorithms.md), then the rest as needed. The sidecar format and the adjustment model are the contracts every platform observes; get those stable first.

If you're reviewing: read [`02-pipeline.md`](./02-pipeline.md) and [`09-open-questions.md`](./09-open-questions.md) first. The pipeline document explains the shape of the system; the open-questions document is where the honest unknowns live.
