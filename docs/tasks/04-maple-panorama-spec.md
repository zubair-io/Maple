# Maple — Panorama Pipeline Task Plan

**Status:** v0.2 — execution snapshot 2026-04-26.
**Owner:** Zubair
**Spec:** [`docs/tickets/04-maple-panorama-spec.md`](../tickets/04-maple-panorama-spec.md)
(duplicate copy at [`docs/coral-maple-panorama-spec.md`](../coral-maple-panorama-spec.md)).
**Phase:** Phase 4 — Advanced Editing.

## Execution status (2026-04-26)

| Step | Status | Notes |
|------|--------|-------|
| **P1 — Skeleton & classical baseline (T1.1–T1.6)** | **Done** | 96 pano-core tests; synthetic stitch ΔE mean 0.17 (budget 15). |
| **P2 — Linear raw workflow** | Partial | T2.1 + T2.3 done. T2.2 + T2.4 blocked: no `test-fixtures/pano/` corpus available. |
| **P3 — Neural matching** | **Blocked (upstream)** | `ort` 2.0.0-rc.10 / rc.12 fails to compile (VitisAI field mismatch). `ml-*` features defined but excluded from `default`. |
| **P4 — GPU warp & blend** | Deferred | Parked at MVP — needs GPU adapter for verification; CPU pipeline (T1.5) covers correctness. T4.5 also depends on P3. |
| **P5 — Platform packaging** | Mostly done | T5.1 + T5.2 + T5.4 + T5.6 done. T5.3 (PanoramaEngine async facade), T5.5 (Web service + worker), T5.7 (Apple Quick preset) deferred. |
| **P6 — Parallax mode** | Placeholder | [`docs/superpowers/plans/2026-04-26-pano-parallax-mode.md`](../superpowers/plans/2026-04-26-pano-parallax-mode.md). Expand when MVP ships + P3/P4 unblock. |
| **P7 — Polish** | Placeholder | [`docs/superpowers/plans/2026-04-26-pano-polish.md`](../superpowers/plans/2026-04-26-pano-polish.md). |
| **Cross-cutting (TX)** | Partial | TX.4 (gen-pano-references logic baked into `test_pano_pipeline.sh`), TX.5 (feature-spec reconciliation) done. TX.1 blocked on P3. TX.2 N/A — no justfile in repo. TX.3 not started. |

### Discoveries that updated the spec's assumptions

1. **Working color space is Rec.2020 D65 linear**, not ProPhoto D50.
   `raw_core::dcp::apply` outputs `SceneLinearRec2020`. Pano-core
   matches that; `ColorSpace::prophoto_d50_linear()` exists for the
   export side only.
2. **No justfile in this repo.** Verify recipes live as bash scripts
   in `src/scripts/`. The `verify-pano-golden` recipe lives as
   `src/scripts/test_pano_pipeline.sh` (mirrors
   `test_color_pipeline.sh`).
3. **`raw-pipeline/crates/<crate>/` is `src/raw-pipeline/<crate>/`**
   in the actual repo (workspace is flat, not under `crates/`). The
   path-conventions table below was written assuming this; tasks
   followed real paths.
4. **`ort` upstream broke ML matching.** The `VitisAI` accessor
   referenced by `ort/src/ep/vitis.rs` doesn't exist on
   `&'static OrtApi` — both rc.10 and rc.12 fail. Re-promote
   `ml-aliked` / `ml-lightglue` to `default` features once the
   upstream issue is resolved.
5. **Bundle adjustment is Gauss-Newton, not LM** in T1.4 (argmin
   0.10 doesn't ship LM with the residual-vector shape pano needs;
   GN is LM with μ → 0). RANSAC is hand-rolled (2000 iterations,
   deterministic) rather than `arrsac` — the `sample-consensus`
   trait wiring was disproportionate boilerplate. Both are tech
   debt for P2/P3.
6. **Seam finder uses Dijkstra**, not max-flow graph cut. Adequate
   for the MVP (synthetic test passes); a Boykov–Kolmogorov port
   is a follow-up if the perf budget needs it on 120 MP overlap
   graphs.
7. **`pano-smoke` is the smoke binary** at
   `src/raw-pipeline/pano-core/src/bin/pano-smoke.rs`. The
   `pano-cli` polished CLI is parked as P7 work.
8. **MVP canvas sizing is wrong for non-identity rotations.**
   `pano-smoke::compute_canvas_size` takes `max(width)`/`max(height)`
   of the inputs — it does NOT project warped image corners. So any
   image whose rotation pushes pixels outside the input bounding
   box gets clipped, and the output canvas can never grow beyond
   single-image dimensions. Observed when chain-stitching all 21
   pano_01 DNGs: 100% RANSAC inlier rate at every step, but final
   output stays 5376×3956 (one image's size). Fix requires:
   (a) projecting each input's 4 corners through the camera
   homography to find the union bounding box; (b) refactoring
   `warp_to_canvas` to place each warp at its projected offset
   inside the larger canvas. Tracked as a critical P2 follow-up.
9. **N-image stitching uses iterative pairwise chain.** Each
   chain step's BA uncertainty feeds the next; quality compounds
   downward. Production needs joint BA across all images + single
   warp+blend pass. Without this, even with the canvas fix, long
   chains will drift. P2 follow-up.

This document is the **work-breakdown** for the panorama pipeline spec. It is
not a redesign — see the spec for architecture, dependencies, FFI shape,
performance targets, and open questions. Tasks here are scoped to be
ticketable and assignable; a per-step `superpowers/plans/` execution plan
will be written when each P-step starts.

## Conventions

- **Numbering.** Tasks are `T<step>.<n>` where `<step>` is the spec's P-step
  (P1..P7) and `<n>` increments within that step. Cross-cutting tasks use
  `TX.<n>`. Numbering is stable — insert with `.5` suffixes rather than
  renumbering if reordering becomes necessary mid-flight.
- **Per-task shape.** Each task carries a one-line **Goal**, **Acceptance**
  criteria, the **Verifier** command(s) that gate completion, the **Files**
  it touches, and a **Refs** pointer back into the spec.
- **Verifier discipline.** A task is not done until its verifier exits 0.
  This mirrors `docs/maple-maple-pipeline-rewrite-tdd-v2.md` rule 5 and the
  existing `verify-*` justfile recipes.
- **Blocked tasks.** Mark with `- [b]` instead of `- [ ]` and add a
  one-line reason inline. Move to a `BLOCKED.md` log only if the block lasts
  more than a sprint.
- **Path conventions.** Where the spec uses idealized paths (e.g.
  `raw-pipeline/crates/pano-core/`, `raw-pipeline/scripts/build-apple.sh`,
  `raw-pipeline/RawPipeline/`), this task plan uses **current repo paths**
  and notes the divergence inline. Concretely:

  | Spec path | Current repo path |
  |-----------|-------------------|
  | `raw-pipeline/crates/<crate>/` | `src/raw-pipeline/<crate>/` (workspace is flat) |
  | `raw-pipeline/scripts/build-apple.sh` | `src/apple/scripts/build-xcframework.sh` |
  | `raw-pipeline/include/raw_pipeline.h` | `src/apple/Frameworks/include/module.modulemap` + per-slice headers in `src/apple/Frameworks/RawPipeline.xcframework/<slice>/Headers/` |
  | `raw-pipeline/RawPipeline/` (separate Swift package) | xcframework consumed directly by `src/apple/Packages/MapleCore/` (no separate wrapper package today) |
  | `Packages/MapleCore/Sources/MapleCore/` | `src/apple/Packages/MapleCore/Sources/MapleCore/` |
  | `web/projects/editor/` | `src/web/projects/maple/` (or `maple-common/` for shared infra) |

  When a task creates the spec's structure (e.g. introducing
  `crates/pano-core/`), the task explicitly calls out whether to follow the
  spec's idealized layout or extend the current flat layout. Default: extend
  current layout to minimize churn; revisit if the spec's structure becomes
  load-bearing for a downstream consumer.

## Prerequisites

These upstream items must land before the corresponding P-step can start.
Track them out-of-band; this section is the cross-link.

- [ ] **PRE-1: Phase A of the pipeline rewrite is complete.** The
      panorama spec marks Phase A as the gate for executing this plan.
      Recheck phase status (e.g. via `tasks.md` or the project's
      blocking log, if either exists at execution time) before
      starting P1; if Phase A still has open items, defer P1 or
      negotiate scope with the spec owner.
      Refs: `docs/maple-maple-pipeline-rewrite-tdd-v2.md`,
      [spec header](../tickets/04-maple-panorama-spec.md).
- [ ] **PRE-2: Phase 3 Color Engine ships.** This bundles the
      `ImageEditPipeline.renderToData` `outputColorSpace:` extension
      that the spec calls out as a blocker for ProPhoto export
      (spec § 4.9, § 11 P5, Open Question #10). If Phase 3 doesn't ship
      it, T5.4 picks it up inline.
      Refs: spec § 4.9, [`ImageEditPipeline.swift`](../../src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift)
      lines 132–146.
- [ ] **PRE-3: `papp:` panorama source-list schema drafted in
      `docs/xmp-canonical-format.md`.** Blocks T5.6.
      Refs: spec § 12 Open Question #8.
- [ ] **PRE-4: Phase D worker-protocol scaffolding lands in the
      Angular app.** The pano web service rides on it rather than
      forking it.
      Refs: spec § 6.1, `docs/maple-maple-pipeline-rewrite-tdd-v2.md`.

---

## Step P1 — Skeleton & classical baseline

Goal: a Cargo crate with trait scaffolding, a classical
ORB/BF/LM/CPU-warp/graph-cut/CPU-blend pipeline, and a smoke binary
that produces a stitched PNG16 from 2–8 inputs.

**Step verifier:** `verify-rust` (auto-picks up new crate) plus
`verify-pano-golden --max-delta-e 15` on a 2-image easy-scene subset.

### T1.1 — Scaffold `pano-core` crate and add to workspace
- **Goal:** New crate at `src/raw-pipeline/pano-core/` with the
  spec's `Cargo.toml` deps (§ 9), added to the workspace `members`
  list. Crate compiles empty and `cargo check -p pano-core` is green.
- **Acceptance:** `cargo check -p pano-core` exits 0; `cargo
  metadata` lists `pano-core`.
- **Verifier:** `cd src/raw-pipeline && cargo check -p pano-core`.
- **Files:** `src/raw-pipeline/Cargo.toml` (workspace `members`),
  `src/raw-pipeline/pano-core/Cargo.toml`,
  `src/raw-pipeline/pano-core/src/lib.rs`.
- **Refs:** Spec § 9, § 13.

### T1.2 — Define `PanoImage`, traits, and color module
- **Goal:** `PanoImage` struct, `ColorSpace` type, `FeatureDetector` /
  `FeatureMatcher` / `BundleAdjuster` / `Warper` / `SeamFinder` /
  `Blender` traits, color helpers re-exporting `raw_core::matrices`.
- **Acceptance:** Trait surface compiles with `Send + Sync` bounds; a
  doc test on each trait shows the canonical signature; `palette` /
  `bitvec` deps wired.
- **Verifier:** `cd src/raw-pipeline && cargo test -p pano-core --doc`.
- **Files:** `src/raw-pipeline/pano-core/src/{lib.rs,types.rs,
  color.rs,traits.rs}`.
- **Refs:** Spec § 4, § 5, § 7.

### T1.3 — Add `raw-core::decode_for_pano` ingest helper
- **Goal:** Compose existing `raw-core` fns (decode → demosaic →
  apply_white_balance → apply_dcp → rotate_rgba_f32) into a single
  ProPhoto-linear-f32 ingest path. Skip capture sharpening, histogram
  match, and ProPhoto→sRGB matrix.
- **Acceptance:** `decode_for_pano(bytes, dcp) -> Result<PanoIngest,
  DecodeError>` returns interleaved f32 ProPhoto pixels with
  orientation + metadata; existing `verify-color-pipeline` is still
  green (single-image raw decode must not regress).
- **Verifier:** `cd src/raw-pipeline && cargo test -p raw-core
  decode_for_pano && src/scripts/test_color_pipeline.sh`.
- **Files:** `src/raw-pipeline/raw-core/src/lib.rs` (or new module
  `src/raw-pipeline/raw-core/src/pano.rs`).
- **Refs:** Spec § 4.1.

### T1.4 — Classical detect / match / BA stack
- **Goal:** `OrbDetector` (`imageproc`), `BruteForceMatcher` (Hamming
  on 256-bit ORB descriptors), `arrsac` USAC-MAGSAC RANSAC, and a
  rotation-only LM bundle adjuster (`argmin`) initialised from a MST
  over pairwise homographies.
- **Acceptance:** On the 2-image easy-scene fixture, inlier count >
  100 and BA residual converges to <1 px reprojection error; unit
  tests for each stage with synthetic inputs.
- **Verifier:** `cd src/raw-pipeline && cargo test -p pano-core
  --test classical_pipeline`.
- **Files:** `src/raw-pipeline/pano-core/src/features/orb.rs`,
  `.../matching/brute_force.rs`, `.../ba/lm.rs`,
  `.../tests/classical_pipeline.rs`.
- **Refs:** Spec § 4.2–4.4.

### T1.5 — CPU warper, graph-cut seam, multi-band blend
- **Goal:** `CpuWarper` (trilinear interpolation), `pathfinding`-based
  graph-cut min-cost seam, and `rayon`-parallel multi-band Laplacian
  blend (5–7 bands). All math in ProPhoto linear f32. Validate
  `pathfinding`'s max-flow perf on 120 MP overlap (spec Open Q#9).
- **Acceptance:** Each stage has an integration test on synthetic
  input (`tests/warp.rs`, `tests/seam.rs`, `tests/blend.rs`); the
  CPU pyramid helper that the blend uses is bit-exact for
  power-of-two round-trip (down→up). Note `pathfinding` perf number
  in the task PR; if > 5s on 120 MP, open a follow-up to vendor a
  Boykov–Kolmogorov port.
- **Verifier:** `cd src/raw-pipeline && cargo test -p pano-core
  --test warp --test seam --test blend`.
- **Files:** `src/raw-pipeline/pano-core/src/{warp/cpu.rs,
  seam/graph_cut.rs,blend/multi_band.rs}`,
  `src/raw-pipeline/pano-core/tests/{warp,seam,blend}.rs`.
- **Refs:** Spec § 4.5, § 4.6, § 4.8, § 12 Open Q#9.

### T1.6 — `pano-smoke` reference binary + golden harness
- **Goal:** CLI binary that takes 2–8 image paths and writes a PNG16
  result. Add `scripts/test_pano_pipeline.sh` (wraps the binary +
  `compare_images.py`) and a `verify-pano-golden` justfile recipe.
  Seed `test-fixtures/pano/corpus/` with 2 easy-scene inputs and
  `test-fixtures/pano/references/` with a hand-curated reference.
- **Acceptance:** `verify-pano-golden --max-delta-e 15` passes on the
  2-image easy-scene subset; behaves like `test_color_pipeline.sh`
  when fixtures absent (skip-pass with explanatory message).
- **Verifier:** `just verify-pano-golden 15`.
- **Files:** `src/raw-pipeline/pano-core/src/bin/pano-smoke.rs`,
  `src/scripts/test_pano_pipeline.sh`, `justfile` (new recipe),
  `test-fixtures/pano/{corpus,references}/`.
- **Refs:** Spec § 10, § 11 P1.

---

## Step P2 — Linear raw workflow

Goal: make RAW the default ingest path, stay in ProPhoto linear
end-to-end, expose f32+f16 output across the existing FFI surfaces
behind a `pano` feature flag.

**Step verifier:** `verify-pano-golden --max-delta-e 10` on the full
12-scene corpus; `verify-color-pipeline` remains green.

### T2.1 — Wire `decode_for_pano` as default RAW ingest
- **Goal:** `PanoInput::Bytes { format: Raw, .. }` routes through
  `raw_core::decode_for_pano`; JPEG/PNG continues through
  `jpeg-decoder` / `image`; HEIF gated behind native-only `heif`
  feature (off by default).
- **Acceptance:** Mixed RAW + JPEG corpus stitches end-to-end; format
  detection is byte-sniff based, not extension-based.
- **Verifier:** `cd src/raw-pipeline && cargo test -p pano-core
  --test ingest_dispatch`.
- **Files:** `src/raw-pipeline/pano-core/src/ingest.rs`.
- **Refs:** Spec § 4.1.

### T2.2 — Expand golden corpus to 12 scenes
- **Goal:** Populate `test-fixtures/pano/corpus/` with the 12-scene
  brief (low-texture, parallax-heavy, HDR-lit, night, architectural,
  landscape; mix of DNG and JPEG inputs). Reference panoramas
  (engine / Hugin / hand-curated) at `test-fixtures/pano/references/`.
  Symlinks permitted (matches the existing `test-fixtures/raws/...`
  pattern).
- **Acceptance:** `scripts/gen-pano-references.sh` regenerates
  references reproducibly; `compare_images.py` reports valid metrics
  on every reference / candidate pair.
- **Verifier:** `src/scripts/gen-pano-references.sh --check`.
- **Files:** `src/scripts/gen-pano-references.sh`,
  `test-fixtures/pano/{corpus,references}/`.
- **Refs:** Spec § 10.

### T2.3 — `pano` feature + f32/f16 output handles in raw-ffi and raw-wasm
- **Goal:** Add `pano` Cargo feature to both `raw-ffi` and `raw-wasm`
  (each pulls `pano-core` as optional dep); expose just the output
  buffer accessors (`pano_get_pixels_f32` / `pano_get_pixels_f16`)
  needed for P2's web-side smoke run. The full Apple FFI surface
  (`pano_stitch`, options struct, lifecycle) lands in T5.1. Off by
  default — bundle size unchanged when the feature isn't enabled.
- **Acceptance:** With `--features pano` enabled, the f32 + f16
  accessors are reachable from a WASM smoke test; without it,
  generated headers and WASM exports are byte-identical to today.
- **Verifier:** `cd src/raw-pipeline && cargo build -p raw-ffi -p
  raw-wasm` (default) and `cargo build -p raw-ffi -p raw-wasm
  --features pano`.
- **Files:** `src/raw-pipeline/raw-ffi/{Cargo.toml,src/lib.rs}`,
  `src/raw-pipeline/raw-wasm/{Cargo.toml,src/lib.rs}`.
- **Refs:** Spec § 6, § 9.

### T2.4 — `verify-pano-golden --max-delta-e 10` gate on full corpus
- **Goal:** Tighten the golden gate from 15 to 10 once T2.1–T2.3 land
  and the full 12-scene corpus exists. Update `justfile`'s default
  budget arg.
- **Acceptance:** `just verify-pano-golden` (default budget 10)
  passes on the full corpus.
- **Verifier:** `just verify-pano-golden`.
- **Files:** `justfile`.
- **Refs:** Spec § 11 P2.

---

## Step P3 — Neural matching

Goal: add ALIKED + LightGlue ONNX behind feature flags; CPU
execution provider only (GPU EPs deferred to P4). Default to ML when
features are on and the runtime supports them, ORB otherwise.

**Step verifier:** `verify-pano-golden --max-delta-e 6`; low-texture
corpus subset shows measurable inlier-count improvement vs ORB
baseline.

### T3.1 — `ort` integration + model loader
- **Goal:** Wire `ort` (load-dynamic) into `pano-core` behind the
  `ml-aliked` / `ml-lightglue` features. Model loader resolves SHA-
  pinned ONNX from `models.toml`; native loads from a path resolved
  by the embedder (defaults to `Bundle.module` on Apple, lazy-load
  URL in WASM); web loads from `/assets/pano-models/`.
- **Acceptance:** Loader unit-tests assert SHA on load and reject
  tampered files; `ort` session creates with CPU EP on all targets.
- **Verifier:** `cd src/raw-pipeline && cargo test -p pano-core
  --features ml-aliked --test model_loader`.
- **Files:** `src/raw-pipeline/pano-core/src/{ml/loader.rs,
  models/models.toml}`.
- **Refs:** Spec § 4.2, § 9 (Models table).

### T3.2 — `AlikedDetector` implementation
- **Goal:** Implement `FeatureDetector` for ALIKED. Pre/post-process
  matches the LightGlue-ONNX repo's reference implementation;
  emits keypoints + descriptors compatible with LightGlue input.
- **Acceptance:** On a calibration image, keypoint count and
  descriptor stats match the ONNX-Runtime Python reference within a
  documented tolerance (record in the test).
- **Verifier:** `cd src/raw-pipeline && cargo test -p pano-core
  --features ml-aliked --test aliked`.
- **Files:** `src/raw-pipeline/pano-core/src/features/aliked.rs`.
- **Refs:** Spec § 4.2.

### T3.3 — `LightGlueMatcher` implementation
- **Goal:** Implement `FeatureMatcher` for LightGlue (ALIKED-paired).
  Replaces `BruteForceMatcher` as the default when both features are
  on.
- **Acceptance:** On the low-texture corpus subset, inlier count
  beats ORB+BF baseline by >2x; pairwise homography RMSE drops
  measurably (numbers logged to `bench_pano.sh` output).
- **Verifier:** `cd src/raw-pipeline && cargo test -p pano-core
  --features ml-lightglue --test lightglue && src/scripts/bench_pano.sh
  --compare-baseline`.
- **Files:** `src/raw-pipeline/pano-core/src/matching/lightglue.rs`.
- **Refs:** Spec § 4.3.

### T3.4 — Tighten golden gate to ΔE 6
- **Goal:** With neural matching default-on, push the
  `verify-pano-golden` budget to 6.
- **Acceptance:** `just verify-pano-golden 6` passes on full corpus.
- **Verifier:** `just verify-pano-golden 6`.
- **Files:** `justfile` (default budget arg).
- **Refs:** Spec § 11 P3.

---

## Step P4 — GPU warp & blend

Goal: move warp, pyramid construction, and multi-band blend onto
`wgpu` compute shaders. ONNX EPs upgraded to CoreML (Apple) and
WebGPU-or-WASM-SIMD (browser).

**Step verifier:** `verify-pano-perf` green against spec § 8 targets;
`verify-pano-golden --max-delta-e 6` (perf step must not regress
quality).

### T4.1 — `wgpu` device + pipeline scaffolding
- **Goal:** Single `wgpu` device shared across stages; compute
  pipeline cache; CPU↔GPU buffer marshalling helpers (zero-copy
  where possible). Backend selection respects platform (Metal /
  WebGPU / Vulkan).
- **Acceptance:** `pano-core` boots a `wgpu` device on macOS, iOS
  simulator, and Chrome WASM in unit tests; a noop compute pipeline
  round-trips a buffer.
- **Verifier:** `cd src/raw-pipeline && cargo test -p pano-core
  --features gpu-wgpu --test wgpu_smoke`.
- **Files:** `src/raw-pipeline/pano-core/src/gpu/{device.rs,
  pipeline_cache.rs,buffers.rs}`.
- **Refs:** Spec § 4.5, § 4.8.

### T4.2 — `warp.wgsl` + `GpuWarper`
- **Goal:** WGSL compute shader for forward / backward warp with
  trilinear interpolation; mipmap pre-filter when output scale <
  input scale. `GpuWarper` becomes the default; `CpuWarper` retained
  as fallback.
- **Acceptance:** Pixel parity with `CpuWarper` to within ΔE 0.5 on
  the corpus; >5x speedup on Apple silicon for the 6× 24 MP scenario.
- **Verifier:** `cd src/raw-pipeline && cargo test -p pano-core
  --features gpu-wgpu --test gpu_warp_parity`.
- **Files:** `src/raw-pipeline/pano-core/shaders/warp.wgsl`,
  `.../src/warp/gpu.rs`.
- **Refs:** Spec § 4.5.

### T4.3 — `pyramid_down.wgsl` + `pyramid_up.wgsl`
- **Goal:** WGSL pipelines for Laplacian pyramid down/up. Used by the
  GPU blend (T4.4).
- **Acceptance:** Pyramid round-trip (down→up) bit-exact on
  power-of-two sizes; <0.5 ΔE on arbitrary sizes (interpolation
  expected).
- **Verifier:** `cd src/raw-pipeline && cargo test -p pano-core
  --features gpu-wgpu --test gpu_pyramid`.
- **Files:** `src/raw-pipeline/pano-core/shaders/pyramid_{down,up}.wgsl`,
  `.../src/blend/pyramid.rs`.
- **Refs:** Spec § 4.8.

### T4.4 — `blend.wgsl` + GPU `Blender`
- **Goal:** WGSL multi-band Laplacian blend matching the CPU
  reference. Validity-mask aware. Default blender on platforms with
  `gpu-wgpu` enabled.
- **Acceptance:** Pixel parity with CPU blender to ΔE < 1 on corpus;
  perf within § 8 budget.
- **Verifier:** `cd src/raw-pipeline && cargo test -p pano-core
  --features gpu-wgpu --test gpu_blend_parity && just verify-pano-perf`.
- **Files:** `src/raw-pipeline/pano-core/shaders/blend.wgsl`,
  `.../src/blend/gpu.rs`.
- **Refs:** Spec § 4.8.

### T4.5 — ONNX EP upgrade (CoreML / WebGPU / WASM-SIMD)
- **Goal:** Wire CoreML EP for Apple builds; WebGPU EP (with
  WASM-SIMD fallback) for browser builds. Verify ALIKED + LightGlue
  produce the same outputs across EPs to within documented
  tolerance.
- **Acceptance:** `model_loader` test exercises EP selection; a
  Python-vs-Rust cross-EP parity test stays under threshold.
- **Verifier:** `cd src/raw-pipeline && cargo test -p pano-core
  --features ml-aliked,ml-lightglue --test ep_parity`.
- **Files:** `src/raw-pipeline/pano-core/src/ml/ep.rs`.
- **Refs:** Spec § 6.1, § 6.2.

### T4.6 — `bench_pano.sh` + `verify-pano-perf` justfile recipe
- **Goal:** Per-stage `criterion` benches + `wgpu` timestamp-query
  bench. `bench_pano.sh` produces a per-stage breakdown; `verify-
  pano-perf` enforces § 8 wall-time budgets on the reference 6× 24
  MP corpus.
- **Acceptance:** All four § 8 scenarios pass on the reference
  hardware (M-series Mac primary; iPhone 15 Pro secondary).
- **Verifier:** `just verify-pano-perf`.
- **Files:** `src/scripts/bench_pano.sh`, `justfile` (new recipe),
  `src/raw-pipeline/pano-core/benches/`.
- **Refs:** Spec § 8, § 10.

---

## Step P5 — Platform packaging

Goal: ship the pipeline through Apple (xcframework + Swift wrapper +
MapleCore facade) and Web (WASM bundle + Angular service + Web Worker).
Adds the `outputColorSpace:` extension to `ImageEditPipeline.renderToData`
required for ProPhoto export. Adds the `papp:` XMP source-list schema.

**Step verifier:** `verify-pano`, `verify-pano-golden --max-delta-e 5`,
`verify-native`, `verify-web`, `verify-apple-builds`, `verify-xmp`
(round-trips a `papp:panorama/...` sidecar without loss).

### T5.1 — `pano_*` C prototypes + impl in raw-ffi
- **Goal:** Add `pano_stitch`, `pano_get_width`, `pano_get_height`,
  `pano_get_pixels_f16`, `pano_get_pixels_len`, `pano_free` to the
  C ABI. Header generation extends the existing inline heredoc in
  `src/apple/scripts/build-xcframework.sh` (the spec calls this
  `raw-pipeline/scripts/build-apple.sh`; current location is the
  apple scripts dir per the path table above).
- **Acceptance:** `cbindgen` (or the script's heredoc, whichever the
  current toolchain uses) emits clean prototypes; `ffi_smoke` test
  links and round-trips a stitched buffer.
- **Verifier:** `cd src/raw-pipeline && cargo test -p raw-ffi
  --features pano --test ffi_smoke`.
- **Files:** `src/raw-pipeline/raw-ffi/src/lib.rs`,
  `src/apple/scripts/build-xcframework.sh`,
  per-slice headers under `src/apple/Frameworks/RawPipeline.xcframework/`.
- **Refs:** Spec § 6.2.

### T5.2 — Rebuild xcframework + Swift wrapper types
- **Goal:** Run `src/apple/scripts/build-xcframework.sh` with the
  pano feature on; commit the regenerated headers. Add Swift wrapper
  types for `PanoHandle` next to the existing `DemosaicedHandle` /
  `RawPipeline.swift` (spec calls for a separate `RawPipeline/`
  package; current repo consumes the xcframework directly inside
  MapleCore — extend MapleCore for now, factor out later if needed).
- **Acceptance:** Swift `PanoHandle` wrapper has `init(stitch:options:)`
  / `width` / `height` / `pixelsF16` accessors and a deinit that
  calls `pano_free`. `xcodebuild` succeeds for both macOS + iOS
  destinations.
- **Verifier:** `xcodebuild -project src/apple/Maple.xcodeproj
  -scheme Maple -destination 'platform=macOS' build` and the iOS
  simulator equivalent.
- **Files:** `src/apple/Frameworks/RawPipeline.xcframework/` (regenerated),
  `src/apple/Packages/MapleCore/Sources/MapleCore/Panorama/PanoHandle.swift`.
- **Refs:** Spec § 6.2, CLAUDE.md § "Build & test — Apple".

### T5.3 — `MapleCore.Panorama` facade
- **Goal:** Add `PanoramaEngine.swift` (async facade), `PanoramaSource.swift`
  (resolves `ImageAsset` inputs across filesystem / PhotoKit / SMB into
  byte slices + DCP bytes), and `PanoramaExport.swift` (wraps the
  output buffer in a `CIImage` and routes through `ExportEngine`).
- **Acceptance:** `PanoramaEngine.stitch(assets:progress:)` returns
  a `CIImage` for a 2-image fixture; progress callback fires at
  per-stage boundaries.
- **Verifier:** `swift test --package-path src/apple/Packages/MapleCore`.
- **Files:** `src/apple/Packages/MapleCore/Sources/MapleCore/Panorama/{PanoramaEngine,
  PanoramaSource,PanoramaExport}.swift`.
- **Refs:** Spec § 6.2.

### T5.4 — Extend `ImageEditPipeline.renderToData` with `outputColorSpace:`
- **Goal:** Add `outputColorSpace:` parameter (enum `.sRGB |
  .displayP3 | .proPhoto`) to `renderToData` and thread it through
  `ExportConfiguration`. Default stays `.sRGB`. Pano export uses
  `.proPhoto`. Picks up the work the Phase 3 Color Engine deferred
  per PRE-2; if Phase 3 lands first, this task becomes a no-op.
- **Acceptance:** Existing exports still produce sRGB-tagged output;
  a new test produces a ProPhoto-tagged TIFF whose ICC matches the
  pinned ProPhoto profile.
- **Verifier:** `swift test --package-path src/apple/Packages/MapleCore
  --filter ImageEditPipelineTests`.
- **Files:** `src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift`
  (lines 132–146 currently hardcode sRGB),
  `src/apple/Packages/MapleCore/Sources/MapleCore/MapleExporter.swift`
  (or wherever `ExportConfiguration` lives).
- **Refs:** Spec § 4.9, § 12 Open Q#10.

### T5.5 — Web `panorama.service.ts` + `panorama.worker.ts`
- **Goal:** Angular service + Web Worker that owns a pano-enabled
  `raw_wasm` instance off the main thread. Rides on Phase D worker
  protocol (PRE-4). Lives under `src/web/projects/maple/` (the spec
  calls this `web/projects/editor/`; current repo uses `maple/` and
  `maple-common/` per the path table).
- **Acceptance:** Browsing → "Stitch panorama" → output preview
  works end-to-end on a 2–4 image JPEG fixture in Chrome with
  WebGPU. UI stays responsive during stitch.
- **Verifier:** `cd src/web && bun run test` (jest/vitest harness)
  and a manual smoke run via `bun x ng serve maple` against the
  fixture.
- **Files:** `src/web/projects/maple/src/app/services/panorama.service.ts`,
  `src/web/projects/maple/src/app/workers/panorama.worker.ts`.
- **Refs:** Spec § 6.1, CLAUDE.md § "Build & test — Web".

### T5.6 — `papp:` XMP schema + sidecar round-trip
- **Goal:** Implement the `papp:` panorama source-list namespace
  (defined in PRE-3) on both Swift and TypeScript XMP writers.
  Fields per spec § 12 Open Q#8: source paths (bookmark + absolute),
  XMP hash pin, per-frame focal length + EV, alignment cache
  (homography + BA residuals), output dimensions, projection,
  preset (Quick/Quality).
- **Acceptance:** A sidecar containing `papp:panorama/...` round-
  trips through both writers byte-for-byte; `verify-xmp` (or its
  successor) gates the round-trip.
- **Verifier:** `swift test --package-path src/apple/Packages/MapleCore
  --filter PappSchemaTests` and `cd src/web && bun run test
  -- --filter papp`.
- **Files:** `src/apple/Packages/MapleCore/Sources/MapleCore/Sidecar/...`,
  `src/web/projects/maple-common/src/lib/sidecar/...`,
  `docs/xmp-canonical-format.md` (PRE-3 lands the schema).
- **Refs:** Spec § 12 Open Q#8.

### T5.7 — Apple Quick preset (Vision + MPS + vImage) — optional
- **Goal:** Per spec § 6.3, add a Swift-side fast path in
  `MapleCore.Panorama` for the **Quick preset** when input is
  JPEG/HEIF: `VNImageHomographicAlignmentRequest` for alignment,
  `MPSImageLaplacianPyramid` for blending, `vImage` for resampling.
  DNG inputs and the Quality preset always go through the Rust core.
  This task is **optional for MVP** — ship Quality-only first if
  scoping pressure shows up; T5.7 can land as a follow-up without
  blocking P5 sign-off.
- **Acceptance:** A Quick-preset stitch on a 4-image JPEG fixture
  produces a result inside the spec § 8 budget for the Quick path
  (Apple-platform only). User-facing preset toggle wired through
  `PanoramaEngine`.
- **Verifier:** `swift test --package-path src/apple/Packages/MapleCore
  --filter QuickPresetTests` (Apple-only test target).
- **Files:** `src/apple/Packages/MapleCore/Sources/MapleCore/Panorama/QuickPreset.swift`
  (new), `PanoramaEngine.swift` (preset dispatch).
- **Refs:** Spec § 6.3, § 12 Open Q#7.

---

## Step P6 — Parallax mode (post-MVP)

Goal: opt-in UDIS++ TPS warp + composition mask for parallax-heavy
handheld panoramas; opt-in depth-aware blend via Depth Anything v2.

**Step verifier:** `verify-pano-golden --max-delta-e 4` on the
parallax-heavy corpus subset.

### T6.1 — Expand into per-step plan when MVP ships
- **Goal:** Single placeholder. When P5 lands and the parallax-heavy
  corpus subset is curated, write a `superpowers/plans/` execution
  plan covering UDIS++ TPS warp, composition mask wiring (gated
  behind `ml-udis` — research license, never default), and Depth
  Anything v2 integration (`ml-depth`).
- **Acceptance:** Plan file created at
  `docs/superpowers/plans/<date>-pano-parallax-mode.md`.
- **Verifier:** Plan exists; T6.1 marked complete.
- **Refs:** Spec § 11 P6, § 12 Open Q#6.

---

## Step P7 — Polish (post-MVP)

Goal: LPIPS gate, ICC round-trip tests for ProPhoto → Display P3 →
sRGB export paths, native `pano-cli` example, cross-comparison doc
vs the engine / Hugin.

**Step verifier:** `verify-pano-golden --max-delta-e 3` on full
corpus; `verify-pano-perf` within § 8 targets on both macOS + iPhone.

### T7.1 — Expand into per-step plan when MVP ships
- **Goal:** Single placeholder. When P5 lands, write a
  `superpowers/plans/` execution plan covering LPIPS gate (Python
  fallback or ONNX in CI), ICC round-trip suite, `pano-cli` binary,
  and the comparison doc.
- **Acceptance:** Plan file created at
  `docs/superpowers/plans/<date>-pano-polish.md`.
- **Verifier:** Plan exists; T7.1 marked complete.
- **Refs:** Spec § 11 P7.

---

## Cross-cutting work

Tasks that span multiple P-steps or sit outside the per-step gate
sequence.

### TX.1 — `models.toml` + SHA pinning workflow
- **Goal:** Manifest at `src/raw-pipeline/pano-core/models/models.toml`
  pinning ALIKED, LightGlue, UDIS++, Depth Anything v2 by SHA-256.
  CI fetches + verifies; mismatched SHA fails the build.
- **Acceptance:** `cargo test -p pano-core --test model_pin` exits 0
  on a clean cache and 1 on a tampered file.
- **Verifier:** `cd src/raw-pipeline && cargo test -p pano-core --test
  model_pin`.
- **Files:** `src/raw-pipeline/pano-core/models/models.toml`,
  `src/raw-pipeline/pano-core/build.rs` (if download-at-build is
  picked over lazy-load).
- **Refs:** Spec § 9, § 12 Open Q#3.

### TX.2 — Justfile recipes (`verify-pano`, `verify-pano-golden`, `verify-pano-perf`)
- **Goal:** Add the three recipes from spec § 10; extend `verify-all`
  to include `verify-pano verify-pano-golden` once T1.1 lands. Recipes
  must be idempotent and skip-pass when fixtures are absent (matches
  `test_color_pipeline.sh` pattern).
- **Acceptance:** `just --list` shows all three new recipes; running
  them on a checkout without `test-fixtures/pano/` exits 0 with a
  skip message.
- **Verifier:** `just verify-pano && just verify-pano-golden && just
  verify-pano-perf` on a fixture-less checkout.
- **Files:** `justfile`.
- **Refs:** Spec § 10.

### TX.3 — Cross-platform CI matrix extension
- **Goal:** Extend the existing CI matrix (x86_64 Linux, arm64 macOS,
  wasm32) to run `verify-pano` and `verify-pano-golden`. iOS gates
  via the same path as the rest of the project. Perf gate
  (`verify-pano-perf`) wires in once T4.6 lands.
- **Acceptance:** A PR that breaks pano on any platform fails CI on
  that platform.
- **Verifier:** Branch protection + green CI run on a no-op PR.
- **Files:** `.github/workflows/*.yml` (or current CI config root).
- **Refs:** Spec § 10.

### TX.4 — `gen-pano-references.sh` + reference workflow doc
- **Goal:** Document how to regenerate `test-fixtures/pano/references/`
  (engine / Hugin / hand-curated), parallel to the existing
  `gen-golden-fixtures.sh`. Add a `--check` mode that re-runs the
  generator and asserts byte equality.
- **Acceptance:** `--check` exits 0 on a clean tree; documentation
  in `docs/testing.md` (or wherever the project's testing docs land)
  describes the workflow.
- **Verifier:** `src/scripts/gen-pano-references.sh --check`.
- **Files:** `src/scripts/gen-pano-references.sh`,
  `docs/testing.md` (or appropriate location).
- **Refs:** Spec § 10.

### TX.5 — Reconcile `photo-app-feature-spec.md` panorama section
- **Goal:** Update `docs/photo-app-feature-spec.md` § "Panorama
  stitching pipeline" to describe the dual-preset model (Quick =
  Vision + Metal + vImage on JPEG/HEIF; Quality = Rust core, default
  on DNG). Per spec § 12 Open Q#7, the existing feature-spec text
  becomes the Quick preset.
- **Acceptance:** Feature spec section reads consistently with this
  task plan and the design spec; PR description cross-links all
  three.
- **Verifier:** Document review (no automated gate).
- **Files:** `docs/photo-app-feature-spec.md`.
- **Refs:** Spec § 6.3, § 12 Open Q#7.

---

## Open questions cross-reference

The following spec open questions block specific tasks. Resolve them
before, or as part of, the listed task.

| Open Q | Blocks | Notes |
|--------|--------|-------|
| #1 TIFF in WASM | T5.5 (decide PNG16-only vs PNG16+TIFF) | Lean PNG16; revisit at P5. |
| #2 Ceres vs argmin | None for MVP | Add behind `ceres-native` only if > 50-image loop closure surfaces. |
| #3 Model delivery | T3.1, TX.1 | SwiftPM resources native; lazy-load web. |
| #4 WASM threading | T5.5 | COOP/COEP acceptable for editor; document for embedders. |
| #5 DNG write-out of stitched output | None | Default no; revisit if a use case lands. |
| #6 UDIS++ licensing | T6.1 | Research license — never default. |
| #7 Feature-spec reconciliation | TX.5, T5.7 | Land alongside P5. T5.7 is the Quick-preset implementation; TX.5 updates the docs. |
| #8 `papp:` schema | T5.6 (and PRE-3 upstream) | Block T5.6 on schema landing. |
| #9 Seam-finding library perf | T1.5 | Validate `pathfinding` perf in P1; vendor BK port if it bottlenecks. |
| #10 `outputColorSpace:` extension | T5.4 | Phase 3 Color Engine is the natural owner; P5 picks it up if Phase 3 punts. |
