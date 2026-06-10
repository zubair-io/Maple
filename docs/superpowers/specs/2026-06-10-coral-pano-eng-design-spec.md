# Coral Pano — Engineering Design Spec

**Status:** Draft v1
**Companions:** `2026-06-10-coral-pano-stitching-spec.md` (pipeline tech spec — algorithm source of truth) · `2026-06-10-coral-pano-product-spec.md` (product spec)
**Workspace:** `src/raw-pipeline/` (this repo — where PR #17 lives today)
**Author:** Zubair Lawrence
**Date:** 2026-06-10

This document does not restate the algorithms — the tech spec owns those (§5 stage specs, §9 decisions). It covers how Coral Pano is built into the codebase: current-state inventory and migration, packaging and FFI, module layout, memory and GPU strategy, public API, the DNG writer, the test harness, milestones, and risks.

---

## 1. Relationship to prior specs

| Document                                                                                                            | Status                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `2026-06-10-coral-pano-stitching-spec.md` (Draft v2, 2026-06-10)                                                    | **Authoritative** for pipeline design and decisions §9.1–9.4.                                                                                                                                                                                                                                                                                                                                                   |
| `docs/tickets/04-maple-panorama-spec.md` (Draft v0.3; same lineage as Coral-Maple's `coral-maple-panorama-spec.md`) | **Superseded.** Three deliberate reversals: (a) working space is **Rec.2020 D65 linear**, not ProPhoto D50 — this matches what `raw-core`'s DCP stage actually outputs today; (b) pairwise-homography alignment is replaced by the rotation model + global BA; (c) the "No UniFFI" stance is revised — see Decision D2. Its repo paths (`web/projects/editor`, justfile recipes) also predate the current tree. |
| Maple PR #17 ("Pano/alignment refinement", open)                                                                    | **Superseded as an approach; mined as a parts bin.** See §2.1 disposition table. Build step 11 deletes this path.                                                                                                                                                                                                                                                                                               |

## 2. Current state

### 2.1 Maple PR #17 `pano-core` — module disposition

The PR contains a full crate at `src/raw-pipeline/pano-core/`. Per-module plan for the `coral_pano` rebuild:

| Module (PR #17)                                                                          | Disposition               | Rationale                                                                                                                                                   |
| ---------------------------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `features/lightglue.rs` + `ort` wiring                                                   | **Carry over**            | Tech spec §5.2: detector/matcher stack is "already built".                                                                                                  |
| `features/akaze.rs`, `features/orb.rs`, `matching/brute_force.rs`, `matching/gms.rs`     | **Delete**                | No classical fallback in v2; low-texture handling is gimbal-prior placement (§8), not a weaker detector.                                                    |
| `matching/overlap_graph.rs`, `matching/gimbal_filter.rs`                                 | **Adapt**                 | Becomes the §5.2 match-graph builder (capture order + gimbal angular proximity + top-k retrieval); verification switches to MAGSAC++ on the rotation model. |
| `ba/lm.rs`                                                                               | **Adapt**                 | LM harness reusable; residual model replaced (rotation + shared focal + k1,k2, analytic Jacobians, Huber δ=2 px, rayon-parallel residuals).                 |
| `ba/homography.rs`, `ba/joint.rs`                                                        | **Delete**                | Homography-chain model is the core defect being fixed.                                                                                                      |
| `ba/focal.rs`                                                                            | **Adapt**                 | Focal-from-homography-decomposition survives as the EXIF-fallback initializer (§5.3).                                                                       |
| `warp/project.rs`, `warp/distortion.rs`, `warp/canvas.rs`                                | **Adapt**                 | Projection math and canvas sizing reusable; extended to spherical/cylindrical/equirect inverse maps.                                                        |
| `warp/legacy_pair_offset.rs`, `warp/global_mesh.rs`, `warp/local_mesh.rs`, `warp/cpu.rs` | **Delete / demote**       | Plane-compositing path dies; a minimal CPU warp survives only as the parity-test reference (§10.4).                                                         |
| `seam/bk.rs`, `seam/graph_cut*.rs`, `seam/n_way.rs`                                      | **Carry over**            | Graph-cut seam is in-spec; data term changes to gradient-domain difference (§5.7).                                                                          |
| `blend/multi_band.rs`, `blend/pyramid.rs`                                                | **Keep as CPU reference** | New WGSL implementation becomes the production path; CPU version gates it (§10.4).                                                                          |
| `blend/simple_alpha.rs`                                                                  | **Delete**                | Naive blending is one of the named defects.                                                                                                                 |
| `compensation/gain.rs`, `compensation/block.rs`                                          | **Adapt**                 | Reshape to Brown-Lowe least squares over overlap means, linear space, optional per-channel (§5.5).                                                          |
| `backends/alicevision/*`                                                                 | **Delete**                | SfM is an explicit non-goal; we point users at AliceVision, we don't link it.                                                                               |
| `ingest.rs`, `color.rs`, `types.rs`, `error.rs`                                          | **Adapt**                 | Ingest gains vignette pre-correction and gimbal-prior XMP ingestion; color space pinned to Rec.2020 D65 linear.                                             |

**Migration mechanics:** build `coral_pano` as a fresh crate on main via a stacked PR series; cherry-pick modules from the PR #17 branch per the table. PR #17 itself closes unmerged once step 11's regression run passes. Do not try to morph the PR #17 branch in place — the alignment model swap touches every consumer of the camera type.

### 2.2 Other assets

- **`~/Projects/Maple Pano` standalone prototype (DronePano, local to the author's machine):** working ALIKED + LightGlue + `ort` CLI. Second source for the detector/matcher carry-over and for `ort` version/EP pinning experience.
- **`raw-gpu` (epic #925, shipping default on Apple + web):** Maple's headless GPU resource core — `GpuContext` (device/queue + lazily-cached compute pipelines), `GpuImage` (upload-once scene-linear f32 images), `Pass`/`ChainRunner` (ordered passes ping-ponging scratch buffers, zero inter-pass CPU readback), cooperative `CancelToken`, WGSL color matrices generated from the same `raw-core` constants the CPU path uses, and the per-stage CPU-oracle parity-gate pattern. Coral Pano's GPU stages are implemented **as `raw-gpu` passes** — same wgpu version pin, same vendored-offline xcframework flow (#1005/#1061), same WGSL authoring constraints (notably **≤ 4 storage buffers per compute stage** for WebGPU compatibility), same `navigator.gpu` routing on web. Pano introduces no second GPU stack.
- **`ort` history:** the earlier pano effort was blocked on an upstream `ort` 2.0 rc compile bug (VitisAI, rc.10/rc.12). Pin the exact known-good `ort` version from the prototype; treat `ort` upgrades as isolated PRs with the full pano regression run.

## 3. Packaging & FFI architecture

```
src/raw-pipeline/  (existing Cargo workspace)
├── raw-core            (existing — decode, demosaic, WB, DCP, matrices; gains decode_for_pano)
├── raw-gpu             (existing — GpuContext / GpuImage / Pass / ChainRunner / CancelToken)
├── coral-pano          (NEW crate `coral_pano` — all stitching stages; depends on raw-core + raw-gpu)
├── raw-ffi             (existing C-FFI staticlib — gains `pano` feature → links coral-pano)
├── raw-wasm            (existing wasm-bindgen cdylib — gains `pano` feature → links coral-pano)
└── maple-cli           (existing — gains `pano stitch` subcommand for the harness)
```

### D1 — One Rust binary artifact, separate Swift API module (flagged for author sign-off)

The tech spec header names a **CoralPano.xcframework**. Building that as a _second Rust staticlib_ alongside `RawPipeline.xcframework` is a link-time hazard: both libs would embed `raw-core` and the Rust std runtime, and two Rust staticlibs in one app binary produce duplicate-symbol failures. Resolution:

- **Compile once:** `coral_pano` is linked into the existing Rust binary artifact via a `pano` cargo feature on `raw-ffi` (the same pattern raw-wasm uses on web). The existing `build-xcframework.sh` + vendored-offline flow gains the feature flag; no second framework build pipeline.
- **Expose separately:** the _Swift_ surface ships as a distinct **`CoralPano` Swift module** (SPM target next to `MapleCore`), containing the UniFFI-generated bindings + a hand-written async facade. App code sees "CoralPano" exactly as the spec intends; the linker sees one Rust binary.
- **Documented alternative:** a true separate `CoralPano.xcframework` built as a _dynamic_ framework (cdylib) avoids the duplicate-symbol problem at the cost of shipping a second copy of raw-core + std (~tens of MB) and a second build pipeline. Only worth it if pano must ship on a separate release cadence from the raw pipeline.

### D2 — UniFFI for the control plane only; pixels never cross as UniFFI types

The predecessor spec rejected UniFFI; the tech spec (§6, step 10) adopts it. Both are honored by scoping:

- **UniFFI** generates the Swift bindings for the _control plane_: `StitchOptions` in; `StitchReport`, progress callbacks, and errors out. These are small, deeply structured types (`Vec<CameraPose>`, enums with payloads) where hand-rolled C accessor forests are exactly the error-prone boilerplate UniFFI eliminates.
- **The data plane never crosses as a UniFFI value.** The primary output is a **linear DNG written to a caller-supplied path** (§5.9 makes the file the product anyway); the API returns the path + report. Preview/export bytes (HEIF/JPEG, ≤ ~20 MB) may cross as plain byte buffers. A 120 MP f32 canvas (~1.4 GB) never serializes across any FFI.
- **Web is unaffected:** WASM bindings remain `wasm-bindgen` on `raw-wasm` (UniFFI has no WASM story). The Rust `Pipeline` API is the single shared surface both binding layers wrap.

## 4. Working space & data model

Carried from tech spec §6, pinned here for implementers:

- `Image<f32>`: **planar** R, G, B planes + explicit `ColorSpace { primaries: Rec2020, white_point: D65, transfer: Linear }`. Planar layout is the GPU- and SIMD-friendly choice and matches the WGSL kernel design below.
- **Validity mask on every buffer** (1 bit/px, `bitvec`). Created at decode (sensor margins), extended by warp (out-of-frame), consumed by gain/seam/blend. A pixel is either fully valid or fully ignored — no alpha blending of validity.
- **No sRGB anywhere in core.** `palette`-typed conversions at the boundaries only. The single tone-mapped path is the HEIF/JPEG preview export through the house view transform.
- Ingest normalization: `rawler` decode → demosaic → black/white level → **vignette correction** (DNG `OpcodeList` or estimated radial gain — _before_ features, §5.1) → camera `ColorMatrix`/`ForwardMatrix` → Rec.2020 D65 linear f32. Implemented as `raw_core::decode_for_pano(bytes, …) -> PanoIngest`, a composition of existing raw-core stages that **stops before any display-prep stage** (sharpening, histogram/auto-profile work) so descriptors and gain solving see unbiased pixels.
- Gimbal yaw/pitch/roll from DJI/Apple XMP rides in `PanoIngest.metadata` as the rotation **prior** (seeds RANSAC/BA; never constrains, §5.1).

## 5. Stage engineering notes

Algorithms per tech spec §5; this table adds the engineering shape. Indicative wall-time allocation for the reference job (6× 24 MP → 120 MP, M-series Mac, 12 s budget) — M0 harness rebalances these:

| Stage                                | Module                     | Compute                                     | Indicative budget             |
| ------------------------------------ | -------------------------- | ------------------------------------------- | ----------------------------- |
| Decode + demosaic + normalize        | `ingest/` (calls raw-core) | CPU, rayon across frames                    | 3.0 s                         |
| ALIKED + LightGlue + match graph     | `features/`, `matching/`   | `ort` (CoreML EP / WebGPU EP), graph on CPU | 2.5 s                         |
| Rotation init + global BA + leveling | `solve/`                   | CPU; rayon residuals/Jacobians              | 0.5 s (< 1 s @ 30 frames, §7) |
| Gain compensation                    | `gain/`                    | CPU (tiny LS system)                        | 0.1 s                         |
| Warp to canvas                       | `warp/` + WGSL             | GPU, tiled                                  | 2.0 s                         |
| Seam finding                         | `seam/`                    | CPU at 1–2 MP, masks upsampled              | 1.0 s                         |
| Multi-band blend                     | `blend/` + WGSL            | GPU, tiled pyramid                          | 1.5 s                         |
| Linear DNG write                     | `export/`                  | CPU                                         | 1.4 s                         |

**WGSL kernel inventory** — implemented as `raw-gpu` `Pass`es sharing `GpuContext` (each respecting the ≤ 4 storage-buffers/stage constraint):

- `warp_inverse.wgsl` — inverse map per output tile; projection variant (rectilinear/cylindrical/spherical) via specialization constant; bicubic Catmull-Rom taps; reads source plane + validity, writes canvas tile + validity. Gain multiplier folded in (saves a pass).
- `pyramid_reduce.wgsl` / `pyramid_expand.wgsl` — Laplacian pyramid construction with validity propagation.
- `blend_accumulate.wgsl` — per-band masked accumulate + final collapse.

Pano's tiled canvas passes don't fit `ChainRunner`'s single-image ping-pong shape; a sibling tiled runner reuses `GpuContext`/`CancelToken` (see Q6). Seam masks are computed on CPU (existing Boykov–Kolmogorov maxflow port) at 1–2 MP and upsampled with one blend-band-width feather — no GPU graph-cut.

**BA specifics:** state = per-image axis-angle (3·N) + shared `f` + `k1,k2` (+ per-image focals only where the §9.2 fallback triggers). `argmin` LM with analytic Jacobians; symmetric reprojection residuals over graph inliers; Huber δ = 2 px. The **convergence-basin benchmark** (init perturbed 5–15°) is a CI fixture, not a one-off — it's what keeps decision §9.1 (no Ceres) closed.

**Cancellation:** `raw-gpu`'s cooperative `CancelToken`, plumbed through the stitch API and checked between stages and between tiles; cancel ≤ 100 ms latency, no partial output files (DNG writes to temp + atomic rename).

**Progress:** `(stage: StitchStage, fraction: f32)` callback; stage enum maps 1:1 to the product spec's four UI stages.

## 6. Memory plan

The §7 "peak ≤ 6× input" gate needs a binding definition — decoded input for the reference job is already 1.73 GB (6 × 24 MP × 12 B/px planar f32), and 6× that is meaningless on iPhone. **Proposed binding interpretation (confirm in M0):**

- Hard per-platform resident-set caps: **≤ 6 GB Mac, ≤ 2.5 GB iPhone, ≤ 3 GB web** for the reference job; the "6×" language is treated as the Mac derivation (6 × decoded-frame ≈ one canvas-set working set).
- Reference-job accounting that forces the design:

| Buffer                                        | Size                                     |
| --------------------------------------------- | ---------------------------------------- |
| 1 decoded frame (24 MP planar f32 + validity) | ~291 MB                                  |
| 6 decoded frames simultaneously               | 1.75 GB — **not allowed on iPhone**      |
| 120 MP canvas (f32 + validity)                | ~1.46 GB — **never fully resident**      |
| Full-res Laplacian pyramid                    | ~4/3 × canvas — **never fully resident** |

- Consequences, all v1-mandatory: decoded frames are staged to disk and **memory-mapped** after feature extraction (features run on a downsampled proxy; full-res pixels are only touched again by warp); warp/blend run **tile-by-tile** over the canvas with only contributing source tiles mapped in; pyramid bands above the current tile never materialize globally. Tile size auto-tunes to the platform cap.
- The harness records peak RSS per run and gates it like any other budget (one-way ratchet).

## 7. Public API

### Rust (the single shared surface)

```rust
pub struct StitchOptions {
    pub projection: ProjectionChoice,      // Auto | Rectilinear | Cylindrical | Spherical
    pub max_canvas_px: Option<u64>,        // memory cap; None = preserve max input density
    pub per_channel_gain: bool,            // default false (scalar gain)
    pub hdr_f16_output: bool,              // default false (16-bit int LinearRaw)
}

pub fn stitch(
    inputs: &[PanoInput],                  // paths or bytes, + optional sidecar/DCP bytes
    out_dng: &Path,
    options: &StitchOptions,
    progress: impl Fn(StitchStage, f32),
    cancel: &CancelToken,
) -> Result<StitchReport, StitchError>;
```

`StitchReport` exactly as tech spec §6 (`cameras`, `mean/max_reproj_error_px`, `dropped_images: Vec<DropReason>`, `projection`, `fov_deg`). `DropReason ∈ {Disconnected, HighResidual, LowOverlap, LowTexturePlacedByPrior}` — the last is reported, not dropped, but rides the same diagnostics channel. Projection override re-render: `rewarp(report, new_projection, …)` reuses solved cameras without re-running features/BA (powers the product's cheap projection switch).

### Apple (UniFFI `CoralPano` module + facade)

```swift
let report = try await CoralPano.stitch(
    assets: selection,                      // resolved to bytes by the source layer
    to: destinationURL,
    options: .default,
    progress: { stage, fraction in … }      // 4 UI stages
)   // throws CoralPanoError; report.notices drives the result sheet
```

A thin notices mapper (`StitchReport → [UserNotice]`) lives in the Swift/TS layer, not in Rust — copy is a product asset and localizes there.

### Web (`raw-wasm` `pano` feature, wasm-bindgen)

- Runs inside the existing WASM worker context; inputs staged via OPFS; `stitch_pano(...)` returns the report as a serde-JSON value and writes the DNG to OPFS for download/import.
- **Web-only default:** `max_canvas_px` defaults to a capped value (proposal: 64 MP) — a 120 MP 16-bit DNG (~0.7 GB raw) is not a reasonable browser artifact. Override allowed; document the memory consequences. _(Open question Q3.)_
- Models (ALIKED ~5 MB, LightGlue ~13 MB) lazy-load on first stitch, SHA-pinned; never in the initial bundle.

## 8. Linear DNG writer

The output file is the product; this is the most compatibility-sensitive new code.

- IFD0: `PhotometricInterpretation = LinearRaw`, demosaiced 3-sample, 16-bit unsigned, lossless-JPEG or deflate compressed tiles; `WhiteLevel = 65535`; **bracketed/merged input maps scene white ≈ ¼ full scale** (2 stops headroom — stacked-DNG convention, decision §9.3); single-exposure input maps scene white to full scale (no wasted precision).
- Color: `ColorMatrix1/2` (+ forward matrices) expressing the **Rec.2020 D65 working space → XYZ** relationship so readers reconstruct color identically to a camera original; `AsShotNeutral` = D65 white so default WB opens neutral.
- Embedded preview IFD (display-referred via the house transform) — Finder/Photos/LR grid behavior depends on it.
- XMP: stitch metadata block — projection, FOV, per-camera `{R, f, k1, k2}`, source file list, pipeline version. GPano block on 360°×180° output.
- **f16 variant** behind `hdr_f16_output`, gated on the step-9 reader survey (Photos, Quick Look, LR, C1, darktable, DJI tooling) which sets the product warning copy.
- Validation: round-trip in CI through Adobe `dng_validate` plus a decode-reopen assertion in `maple-cli` (write → decode → ΔE against the pre-export canvas ≈ 0).

## 9. Testing & CI (build step 1 — lands before everything else)

Follows the house pattern: fixture-gated scripts that **skip-pass when fixtures are absent**, per-case budget files that **ratchet one way**, and CPU references gating GPU paths.

- **Corpus** at `test-fixtures/pano/` (gitignored, like the RAW fixtures): DJI Mini/Mavic gimbal sets (incl. one full 360°), iPhone ProRAW handheld sweeps, deliberately-broken sets (parallax walk, sky-only frame, mixed AE, disconnected pair).
- **Synthetic ground truth:** a dev binary renders N virtual cameras (known `R, f, k1, k2`, supersampled) from an equirect HDR source. Gates: recovered rotations within 0.1°; warp RMSE vs. ground-truth canvas < 0.5% full scale.
- **`src/scripts/test_pano_pipeline.sh`** — the end-to-end gate: runs `maple-cli pano stitch` over a manifest, evaluates per-set metrics (mean/max reprojection px, horizon tilt, loop closure px, seam-line gradient energy, wall time, peak RSS) against `test-fixtures/pano/budgets.json`. New sets enter via the same "run once → fail no-budget-entry → set ceilings 5–10% above observed → commit together" flow as the color harness.
- **Parity gates:** (a) GPU warp/blend vs. CPU reference on small fixtures — provisional tolerance: mean |Δ| < 1e-5, max < 1e-3 on normalized linear output (tighten once measured); (b) Metal vs. WebGPU full-pipeline output on the regression set within the same tolerance. EP nondeterminism (CoreML vs. WebGPU detector output) means match _sets_ may differ — parity is asserted on **final pixels and report metrics**, not on intermediate features.
- **Convergence-basin bench:** BA from inits perturbed 5–15°; must converge to the same minimum. CI fixture; closes decision §9.1 permanently.
- **Unit layer:** per-stage tests continue the existing `pano-core/tests/` pattern; DNG writer tests round-trip real files (house rule: no mocks at I/O contracts).

## 10. Milestones

Mapping of tech-spec build steps 1–11; each gate is a script exit code, not a judgment call.

| Milestone                 | Steps | Exit gate                                                                                                                                                      |
| ------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M0 Harness**            | 1     | Corpus assembled, synthetic renderer running, `test_pano_pipeline.sh` + budgets wired into CI (skip-pass without fixtures). **Blocks all other milestones.**   |
| **M1 Geometry**           | 2–4   | Match graph + rotation MAGSAC++ + BA + leveling green: reproj ≤ 1.5/6 px, rotations ≤ 0.1° synthetic, horizon ≤ 0.3°, basin bench green, BA < 1 s @ 30 frames. |
| **M2 Compositing**        | 5–8   | Projection selection + WGSL warp/blend + gain + seams green: loop closure ≤ 2 px, seam-energy gate, CPU↔GPU parity, perf + memory budgets on Mac.              |
| **M3 Output & platforms** | 9–10  | DNG writer + reader survey + UniFFI/wasm surfaces + notices wired in both apps; Metal↔WebGPU parity; iPhone perf/memory budgets.                               |
| **M4 Ship**               | 11    | Full regression green; PR #17 branch closed; legacy modules deleted per §2.1.                                                                                  |

## 11. Risks & mitigations

| Risk                                                                                            | Mitigation                                                                                                                                       |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ort` instability (history: 2.0-rc VitisAI compile bug blocked the previous ML-matching step)   | Pin the prototype's known-good version; vendor if needed; `ort` bumps are isolated PRs gated on the full pano regression.                        |
| EP numeric divergence (CoreML vs. WebGPU vs. CPU) breaks bit-level expectations                 | Parity defined on final output within tolerance, not on descriptors; identical SHA-pinned model files everywhere; CPU EP as diagnostic baseline. |
| BA convergence on degenerate graphs (long thin strips, sparse overlap)                          | Gimbal prior + spanning-tree init (§5.3); basin bench in CI; acceptance gate drops outlier frames rather than shipping a bad solve.              |
| iPhone memory ceiling                                                                           | §6 tiling + mmap staging is v1-mandatory, not an optimization; peak-RSS is a budgeted, ratcheted metric from M0.                                 |
| DNG reader compatibility (LinearRaw + headroom + Rec.2020 matrices is an unusual combo)         | Step-9 survey before the writer freezes; `dng_validate` + multi-reader smoke in CI; headroom only on merged input.                               |
| Two-Rust-staticlibs link failure if the spec's literal "CoralPano.xcframework" is built naively | Decision D1 (single artifact, separate Swift module); dynamic-framework fallback documented.                                                     |
| Graph-cut wall time on n-way 360° overlaps                                                      | Seams solved at 1–2 MP only (bounded); BK maxflow already ported (PR #17); budget tracked per-set in the harness.                                |
| Corpus acquisition (fixtures are gitignored; gates skip without them)                           | Treat corpus assembly as M0 _deliverable_, not ambient; one nightly/release runner must hold the fixtures or the gates never bite.               |
| WASM worker + OPFS plumbing underestimated                                                      | Web integration scoped into M3 explicitly; web canvas cap (Q3) keeps the first web ship inside browser memory reality.                           |

## 12. Decisions

Binding, in addition to tech-spec §9.1–9.4 (argmin-not-Ceres; shared focal with automatic fallback; 16-bit LinearRaw default with f16 opt-in; notices-in-UI/numbers-in-log):

- **D1** — One Rust binary artifact; `CoralPano` ships as a Swift API module over it, not a second staticlib. _(Flagged for author sign-off — diverges in mechanics, not intent, from the spec header's "CoralPano.xcframework".)_
- **D2** — UniFFI for control plane only; pixel data never crosses an FFI as a value; primary output is the DNG file; web stays wasm-bindgen.
- **D3** — Working space Rec.2020 D65 linear f32, planar, validity-masked; supersedes the ProPhoto-era predecessor specs.
- **D4** — GPU stages are `raw-gpu` passes riding the existing wgpu/WGSL toolchain and constraints (`GpuContext`, `CancelToken`, vendored wgpu, offline xcframework flow, ≤ 4 storage buffers/stage); no parallel GPU stack.
- **D5** — Fresh `coral-pano` crate on main via stacked PRs, mining PR #17 per the §2.1 table; PR #17 closes unmerged at M4.
- **D6** — CPU reference implementations are retained for warp/blend solely as parity gates for the WGSL paths.

## 13. Open questions (engineering)

| #   | Question                                                                                                                                                                                                    | Needed by          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Q1  | Binding memory-gate definition: confirm the §6 per-platform caps as the normative reading of "≤ 6× input".                                                                                                  | M0 (it's a budget) |
| Q2  | Parity tolerance numbers: provisional 1e-5 mean / 1e-3 max — set from measured M2 data, then ratchet.                                                                                                       | M2                 |
| Q3  | Web default canvas cap (64 MP proposed) and the OPFS-vs-download delivery of the output DNG.                                                                                                                | M3                 |
| Q4  | `rewarp` (projection switch without re-solve): v1.0 or v1.x? Product wants it on the result sheet; cost is small once cameras are solved.                                                                   | M3 scoping         |
| Q5  | Where the stitch-metadata XMP block's schema is registered (sidecar-schema docs) and whether the editor surfaces any of it read-only.                                                                       | M3                 |
| Q6  | Tiled GPU runner shape: `ChainRunner` is single-image ping-pong; pano needs a canvas-tile loop over multi-source reads. Extend `raw-gpu` with a sibling runner vs. compose passes manually in `coral_pano`. | M2                 |
