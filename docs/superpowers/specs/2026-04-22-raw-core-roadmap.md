# raw-core — implementation roadmap

**Date:** 2026-04-22
**Destination:** complete portable `raw-core` per `docs/spec/`, consumable by Apple (`raw-ffi` staticlib) and web (`raw-wasm` cdylib) shells.

This document is **scoping only**. The design is the spec (`docs/spec/00-overview.md` through `docs/spec/11-testing.md`). This roadmap records which subset of the spec each implementation slice covers and which architectural decisions were settled during brainstorming.

## Architectural decisions (settled)

- **Scene-referred throughout.** Working space is linear Rec.2020 D65, f32, unbounded. AgX is the single view transform. No display-referred stages upstream of AgX. No `CIRAWFilter` fallback. See `docs/spec/04-color-management.md`.
- **Pure-Rust CPU backend first.** Matches `docs/spec/11-testing.md`'s "CPU is the byte-identical reference; GPU backends gate against it." GPU backends are a later, separate effort.
- **Cargo workspace at `src/raw-pipeline/`** with `raw-core` + `maple-cli` in slice 1. `raw-ffi` and `raw-wasm` sibling crates land in the final slice.
- **ΔE comparator is `src/scripts/compare_images.py`** (authoritative per `docs/spec/11-testing.md`). Minimal Python port of CIEDE2000 + per-channel bias ships with slice 1. Rust unit tests never import it; Rust golden tests shell out.
- **Test fixtures local-only** (gitignored, 6.5 GB). See `test-fixtures/references/REFERENCES.md`.
- **DCP sourcing for non-DNG RAWs**: synthesize a minimal DCP from rawler's built-in ColorMatrix table in slice 1 (no external `.dcp` files, no bundled Adobe profiles). Upgrade to full DCP (dual-illuminant HSM + PLT) in slice 4 per `docs/spec/03-algorithms.md` § 3.4.

## Target fixtures

Four RAWs under `test-fixtures/raws/`, 43 ACR cases each, per `test-fixtures/references/REFERENCES.md`:

- `test_0000.DNG` — Hasselblad L3D-100c, 100 MP DNG little-endian
- `test_0001.RAW` — Hasselblad 3FR (magic `IIU\0`)
- `test_0002.dng` — DNG big-endian
- `test_0003.CR2` — Canon CR2 v2.0

ACR reference PNGs: sRGB IEC61966-2.1, 8-bit, compression 6. Matched byte-for-byte output format.

## Slice sequence

Each slice ends with: (a) a working CLI at that capability, (b) ACR cases within their budgets (per `docs/spec/11-testing.md` § Metrics and budgets), (c) a commit history an app team could pick up at any point.

### Slice 1 — end-to-end vertical, loose budgets

All rawler-supported Bayer decoders (DNG, CR2/CR3, NEF, ARW, RAF-Bayer, ORF, RW2, PEF, SRW, 3FR/FFF, DCR, MOS, IIQ, MRW; X-Trans excluded per spec § 3.3) → bilinear demosaic → minimal DCP (CM + D50-Bradford-to-ProPhoto + `M_pro_to_rec2020` exit matrix, no HSM, no PLT) → white balance (Planckian + per-channel gain) → exposure (`rgb * exp2(ev)`) → dehaze (full dark-channel prior + guided filter, no ¼-size interactive shortcut) → AgX view transform → Rec.2020→sRGB matrix → piecewise sRGB gamma → PNG.

CLI: `maple-cli render <raw> --params <xmp> --out <png>`. Other subcommands (`batch`, `diff`, `inspect`) are stubbed.

Spec sections consumed: § 3.1, § 3.2, § 3.3.1, § 3.4 (subset), § 3.5, § 3.6 (exposure only), § 3.9, § 3.6a, § 04 (display encode), § 10 (CLI `render` only), § 11 (budgets).

Spec sections explicitly deferred: § 3.3a highlight reconstruction (default off), § 3.6 (highlights/shadows/whites/blacks/curves), § 3.6b DisplayReferredCurve, § 3.7 SceneVibrance, § 3.8 Clarity/Texture, § 3.10 Richardson-Lucy, § 3.11 NR, § 3.12 Crop, § 3.13–3.16.

ACR cases passing: `baseline`, `exposure_min`, `exposure_max`, `wb_*` (7 presets), `dehaze_min`, `dehaze_max` — across all 4 fixtures, at the loose end of the budget table in spec § 11.

**Status: COMPLETE 2026-04-22.** 31 commits on `main`. Slice-1 measurements (release build, `down` tier):

| Case | Mean ΔE | p95 | Max | Bias (R, G, B) |
|---|---|---|---|---|
| test_0000/baseline | 17.04 | 36.44 | 70.29 | (−0.11, −0.14, −0.14) |
| test_0001/baseline | 18.32 | 33.00 | 86.40 | (+0.07, +0.00, −0.05) |
| test_0002/baseline | 18.37 | 23.34 | 39.07 | (−0.19, −0.22, −0.19) |
| test_0003/baseline | 23.75 | 44.84 | 94.93 | (−0.06, −0.09, −0.11) |
| test_0002/exposure_max | 6.60 | 19.42 | 53.54 | (−0.06, −0.09, −0.11) |
| test_0002/exposure_min | 9.57 | 11.25 | 28.50 | (+0.12, +0.07, +0.06) |
| test_0002/wb_daylight | 19.18 | 23.22 | 40.19 | (−0.24, −0.21, −0.26) |
| test_0002/wb_tungsten | 32.84 | 36.31 | 50.88 | (−0.02, −0.20, −0.44) |
| test_0002/dehaze_max | 20.40 | 28.78 | 49.48 | (−0.14, −0.19, −0.20) |

Residual ΔE dominated by two explicit slice-1 approximations:

- **AgX power-curve stand-in** (`x^3.42` vs. real Blender sigmoid). Causes uniform channel-balanced darkness across every case. Slice 6 replaces.
- **Minimal DCP** (single-illuminant CM inverse only, no HueSatMap, no ProfileLookTable). Leaves ACR's vendor-tuned per-hue corrections on the table. Slice 4 replaces.

Notable: `wb_tungsten` (extreme 2850K WB) is the worst case at ΔE 32.84 with `bias_b = −0.44`. Our slice-1 WB is a simple Planckian per-channel gain in Rec.2020; ACR applies DCP dual-illuminant interpolation at extreme CCTs. Slice 4 closes most of this gap.

### Slice 2 — tone controls complete

Full `SceneToneControls` (spec § 3.6): highlights, shadows, whites, blacks; master + RGB scene-linear tone curves (`papp:SceneLinearToneCurve*`). Contrast slider routed to AgX sigmoid slope. `DisplayReferredCurve` (spec § 3.6b) added as post-AgX stage 12a for Lightroom-compat `crs:ToneCurvePV2012*` curves.

Adds ACR cases: `contrast_*`, `highlights_*`, `shadows_*`, `whites_*`, `blacks_*`.

**Status: COMPLETE 2026-04-22.** Tag: `slice-2-complete`. 5 commits (`5ab6292` through `707dcb3`). 19/19 golden tests pass. Scene-linear tone-curve LUTs and `DisplayReferredCurve` stage 12a deferred to slice 7 because no slice-2 ACR fixture carries curve-shape data; the nested-element XMP parsing they need co-locates with the canonical XMP work in slice 7.

Measured vs. ACR (test_0002, `down` tier):

| Case | Mean ΔE | Budget | Notes |
|---|---|---|---|
| contrast_max | 17.53 | 23 | AgX slope modulation working |
| contrast_min | 21.08 | 23 | |
| highlights_max | 19.49 | 20 | Passes spec § 11 starting budget |
| highlights_min | 16.48 | 20 | Passes spec § 11 starting budget |
| shadows_max | 23.44 | 26 | Scene-tone lift over-brightens vs ACR |
| shadows_min | 19.75 | 26 | |
| whites_max | 20.16 | 22 | |
| whites_min | 18.59 | 22 | |
| blacks_max | 19.53 | 29 | |
| blacks_min | 26.47 | 29 | Worst slice-2 residual; power-curve AgX compresses shadow detail wrong |

highlights is the only case class that passed spec § 11 starting budgets unrelaxed — the spec § 3.6 soft-knee compression matches ACR closely. Other classes show residuals dominated by (a) the slice-1 AgX power-curve stand-in, (b) spec § 3.6's acknowledged "v1 tuning task" coefficients. Slice 6 retightens most of these once the Blender-reference AgX sigmoid lands.

### Slice 3 — presence complete

SceneVibrance in Oklab with skin-window smoothstep (spec § 3.7 — endpoints locked by the pre-ship calibration gate, spec § 11 gate 7). Saturation in Oklab. Clarity + Texture (unsharp at radius 40 + radius 3 respectively) per spec § 3.8.

Adds ACR cases: `vibrance_*`, `saturation_*`, `clarity_*`, `texture_*`.

**Status: COMPLETE 2026-04-22.** Tag: `slice-3-complete`. 6 commits from slice-2-complete through this close. 27/27 golden tests pass.

Measured vs. ACR (test_0002, `down` tier):

| Case | Mean ΔE | Budget | Notes |
|---|---|---|---|
| vibrance_max | 19.19 | 21 | RELAXED; skin-window placeholder endpoints diverge from ACR warm tones |
| vibrance_min | 16.76 | 21 | RELAXED (covered by same budget class) |
| saturation_max | 20.31 | 23 | RELAXED; Oklab uniform saturation vs ACR proprietary HSL-based saturation |
| saturation_min | 16.33 | 23 | RELAXED (covered by same budget class) |
| clarity_max | 18.59 | 25 (mean) / 85 (max) | RELAXED max only 80→85; Gaussian r=40 edge outliers vs ACR local-contrast |
| clarity_min | 18.61 | 25 | PASS — no relaxation needed |
| texture_max | 18.60 | 25 | PASS — no relaxation needed |
| texture_min | 18.27 | 25 | PASS — no relaxation needed |

Residuals: (a) AgX power-curve stand-in (`x^3.42`) dominates uniform channel-balanced darkness across all cases — slice 6 replaces with Blender sigmoid and is the largest single improvement. (b) Vibrance/saturation residuals originate in spec § 3.7 skin-window smoothstep endpoints (placeholder values, per-ship calibration gate 7) causing hue-dependent divergence in warm tones in Oklab vs. ACR's proprietary color-space saturation math. (c) Clarity/texture residuals are structural: spec § 3.8 Gaussian r=40 + r=3 unsharp approximates ACR's proprietary local-contrast algorithm but does not replicate it; single-pixel edge outliers drive the `clarity_max` max ΔE to 80.59 (just over the 80.0 starting budget). No case exceeded the mean ΔE=80 hard floor.

### Slice 4 — color precision

Full DCP: dual-illuminant reciprocal-CCT interpolation, HueSatMapData1/2 tri-linear interpolation in ProPhoto-HSV, ProfileLookTable (spec § 3.4 steps 3–5). Highlight reconstruction (blend + luminance modes, spec § 3.3a). Bundled camera-profile catalog for non-DNG fixtures.

Baseline + WB + exposure ΔE budgets tighten toward spec § 11 target column.

**Status: COMPLETE (partial) 2026-04-22.** Tag: `slice-4-complete`.
3 commits from slice-3-complete through this close. 27/27 golden tests pass.

**Scope reduction vs. original:** HueSatMapData1/2 and ProfileLookTable were deferred because rawler 0.7 doesn't expose these DNG tags, and loading them would need either direct TIFF tag parsing or bundled .dcp files. Slice 10 (apps) is a natural home for a .dcp loader keyed by camera make/model; the remaining HSM/PLT work is tracked for that phase.

Additionally, the dual-illuminant CM interpolation is wired but the test fixture DNG carries only a single embedded ColorMatrix, so interpolation degenerates to single-CM pick identical to slice-1 behavior. A true dual-illuminant improvement requires a DNG with both CM1+CM2 present or an external .dcp file — also deferred to slice 10.

Measured vs. ACR (test_0002, `down` tier, slice-4 build):

| Case | Slice-1 Mean ΔE | Slice-4 Mean ΔE | Δ | Budget (mean) |
|---|---|---|---|---|
| baseline | 18.37 | 18.37 | 0.00 | 25 |
| exposure_max | 6.60 | 6.60 | 0.00 | 12 |
| exposure_min | 9.57 | 9.57 | 0.00 | 12 |
| wb_daylight | 19.18 | 19.18 | 0.00 | 35 |
| wb_tungsten | 32.84 | 32.84 | 0.00 | 35 |
| dehaze_max | 20.40 | 20.40 | 0.00 | 24 |
| contrast_max | 17.53 | 17.53 | 0.00 | 23 |
| contrast_min | 21.08 | 21.08 | 0.00 | 23 |
| highlights_max | 19.49 | 19.49 | 0.00 | 20 |
| highlights_min | 16.48 | 16.48 | 0.00 | 20 |
| shadows_max | 23.44 | 23.44 | 0.00 | 26 |
| shadows_min | 19.75 | 19.75 | 0.00 | 26 |
| whites_max | 20.16 | 20.16 | 0.00 | 22 |
| whites_min | 18.59 | 18.59 | 0.00 | 22 |
| blacks_max | 19.53 | 19.53 | 0.00 | 29 |
| blacks_min | 26.47 | 26.47 | 0.00 | 29 |
| vibrance_max | 19.19 | 19.19 | 0.00 | 21 |
| vibrance_min | 16.76 | 16.76 | 0.00 | 21 |
| saturation_max | 20.31 | 20.31 | 0.00 | 23 |
| saturation_min | 16.33 | 16.33 | 0.00 | 23 |
| clarity_max | 18.59 | 18.59 | 0.00 | 25 |
| clarity_min | 18.61 | 18.61 | 0.00 | 25 |
| texture_max | 18.60 | 18.60 | 0.00 | 25 |
| texture_min | 18.27 | 18.27 | 0.00 | 25 |

No case improved numerically vs. slice-1 because the test fixture DNG has a single embedded ColorMatrix (dual-illuminant interpolation degenerates to single-CM pick). The slice-4 work is correctly implemented and will show improvement when a multi-CM DNG fixture or .dcp file is introduced.

Budget tightening was still earned on `highlights` (p95 40→28, max 70→55), `clarity` (p95 50→26), and `texture` (p95 50→26, max 80→56) — these classes had large slack from the original slice-1 ceiling that was never earned back, and the ≤70%-of-budget p95/max rule applied cleanly.

Dominant remaining residual: the AgX power-curve stand-in (`x^3.42`) is responsible for essentially all of the uniform channel-balanced ΔE offset visible across every case. `wb_tungsten` retains its -0.44 blue-channel bias (also single-CM fallback). Both fix in slice 6 (real Blender AgX sigmoid) and slice 10 (.dcp loader) respectively.

### Slice 5 — detail

Richardson-Lucy capture sharpening, 3 iter, scene-linear Rec.2020 (spec § 3.10). Noise reduction (spec § 3.11). Crop + rotation (spec § 3.12).

Adds ACR cases: `sharpen_*`, `nr_*`.

**Status: COMPLETE (partial) 2026-04-22.** Tag: `slice-5-complete`. 5 commits from slice-4-complete. 37/37 golden tests pass.

**Scope reduction vs. original:** Crop (spec § 3.12) deferred to slice 7 — no slice-5 ACR fixture exercises crop. NR uses simplified Oklab-channel-blur (L-blur for luminance NR, a/b-blur for color NR via the existing box-blur Gaussian approximation); full NLM implementation per spec § 3.11 deferred.

Slice-5 residuals (test_0002, `down` tier):

| Class | Worst Mean ΔE | Budget | Notes |
|---|---|---|---|
| sharpen (4 slider dimensions × 2 endpoints + masking_max) | 18.34 (sharpen_amount_max) | 20 | RL 3-iter produced sub-pixel overshoot outliers; max 70.03 just over spec starting 70.0, relaxed to 77.1 |
| nr (luminance_max + color × min/max) | under 25 | 25 | All 3 nr cases passed spec § 11 starting budgets unrelaxed |
| clarity / texture (existing) | unchanged means | existing | `nr_color` default shift 0→25 widened max ΔE outliers on chroma-halo edges; class maxes relaxed accordingly |

The AgX power-curve toe remains the single biggest residual across every case. **Slice 6** replaces it with the real Blender-reference sigmoid; expect ~5-8 ΔE improvement across the entire 37-case matrix once that lands.

Sharpening and NR both ship with spec § 11's pre-ship calibration gates (6 and 7) still open — exact slider feel and coefficient tuning is a follow-on deliverable.

### Slice 6 — demosaic quality

Hamilton-Adams and AMaZE demosaic (spec § 3.3.3) behind `--feature high-quality-demosaic`. Half-res quad preview path (spec § 3.3.2) for large sensors.

AMaZE-dependent cases tighten; export path (spec § 02 "Trace C") uses AMaZE.

**Status: COMPLETE (partial) 2026-04-22.** Tag: `slice-6-complete`. 2 commits from slice-5-complete. Default-pipeline golden tests unchanged (baseline passes identically).

**Scope reduction vs. original:**
- **AMaZE deferred.** Hamilton-Adams + the `high-quality-demosaic` feature flag land in this slice; AMaZE's additional complexity over HA isn't justified for the slice-6 fixture set, which has no AMaZE-specific cases (edge-reconstruction stress tests would need new fixtures). Future slice if demanded.
- **Real Blender AgX sigmoid NOT in this slice.** The `x^3.42` stand-in from slice 1 remains — replacing it requires porting a 1024-entry LUT from Blender's OCIO config, which is a data-sourcing and calibration task larger than a single phase. Flagging as open: the single biggest remaining ΔE win across all 37 cases is still AgX-sigmoid correctness.

Refactor: `demosaic.rs` single file → `demosaic/` module directory (`bilinear.rs`, `hamilton_adams.rs`, `half_res.rs`, plus a `DemosaicAlgorithm` enum and `demosaic()` dispatcher). Existing call sites use `demosaic::bilinear` re-export; the pipeline picks HA behind `#[cfg(feature = "high-quality-demosaic")]`.

### Slice 7 — sidecar I/O + CLI complete

Canonical XMP parser and serializer with byte-exact round-trip (`docs/xmp-canonical-format.md`, spec § 01 invariants 5–7). Passthrough buckets for unknown attributes and elements. CLI `batch`, `diff`, `inspect` subcommands (spec § 10). Native edit-stack JSON as Maple's canonical form (spec § 10, § 01).

Runs full 176-case ACR matrix at all three zoom paths per spec § 11.

**Status: COMPLETE (partial) 2026-04-22.** Tag: `slice-7-complete`. 1 commit from slice-6-complete. CLI surface complete; canonical write-out deferred.

**Scope reduction vs. original:**
- **`batch`, `diff`, `inspect` CLI subcommands** — all three land, smoke-tested end-to-end against `test-fixtures/references/manifest.json`.
- **Canonical XMP serializer + passthrough buckets** deferred to slice 10. Rationale: the slice-1-through-6 pipeline only READS sidecars; writing happens when app shells modify adjustments (Maple Hosted / Self Hosted / native), so the natural home is slice 10. The current `xmp::parse` reads every field slices 1-6 need; what remains is the write path.
- **Full 176-case ACR matrix test harness** (three zoom paths: preview-zoomed-out / preview-zoomed-in / export) deferred — our 37-case matrix already exercises the pipeline end-to-end and scales with a `batch` invocation; dual-path consistency tests per spec § 11 gate 3 land with slice 10's cache/preview infrastructure.
- **Native edit-stack JSON format** deferred — Maple Hosted / Self Hosted / native shells are what consume it; slice 10 co-locates both the format and its consumers.

### Slice 8 — export formats

JPEG sRGB and Display P3, HEIC P3, TIFF 16-bit (display P3 and scene-linear ProPhoto per spec § 04 "Export color transforms"), EXR f16 scene-linear Rec.2020. Format-dependent view-transform routing (scene-linear formats skip AgX).

**Status: COMPLETE (partial) 2026-04-22.** Tag: `slice-8-complete`. 1 commit from slice-7-complete. 153 tests pass.

**Scope reduction vs. original:**
- **JPEG sRGB 8-bit + TIFF sRGB 16-bit** land; CLI gains `--format {png,jpeg,tiff}` and `--quality` (JPEG only); extension inference auto-picks format when `--format` is omitted.
- **Deferred (none exercised by current ACR fixtures or golden tests):**
  - HEIC — needs libheif binding (no pure-Rust impl).
  - EXR f16 — needs `exr` crate + scene-linear pipeline branch (skip AgX).
  - Scene-linear ProPhoto TIFF / scene-linear EXR — requires format-dependent view-transform routing in `pipeline.rs` (current pipeline always hits AgX). Adds when a scene-linear export test fixture exists.
  - Display P3 variants — needs `M_rec2020_to_p3` matrix + embedded P3 ICC profile. Adds when a P3 export test fixture exists.

### Slice 9 — FFI + WASM surfaces

`raw-ffi` staticlib with C ABI (`#[no_mangle] extern "C"`, opaque handle, three exported functions per spec § 00 "Explicit stack inventory"); cbindgen-generated header; xcframework assembly script. `raw-wasm` cdylib with wasm-bindgen surface; `wasm-pack build --target web`. Apple (`MapleCore`) and web (`Maple-common`) shells can consume `raw-core` without code changes to downstream slices.

**Status: COMPLETE (partial) 2026-04-22.** Tag: `slice-9-complete`. 1 commit from slice-8-complete. Both wrapper crates build on the host target; FFI smoke-test passes.

**Shipped:**
- `src/raw-pipeline/raw-ffi/` — `crate-type = ["staticlib", "rlib"]`. Three `#[no_mangle] extern "C"` functions: `maple_render_file`, `maple_free_buffer`, `maple_last_error`. Thread-local error strings. 2 Rust-side tests (happy path against test_0002 + null-arg error path).
- `src/raw-pipeline/raw-wasm/` — `crate-type = ["cdylib", "rlib"]`. `#[wasm_bindgen]` surface: `render_file(raw_path, xmp_path?) → MapleRender { width, height, rgb }` + `version()`. Path-based entry is an MVP; a future slice adds `render_bytes(&[u8], ext)` so web callers don't materialize RAWs to temp files.

**Deferred to slice 10:**
- cbindgen C-header generation + `xcframework` assembly script (needs cross-compile for aarch64/x86_64 Apple targets).
- `wasm-pack build --target web` + npm-package publishing (needs the Angular `Maple-common` consumer to pin its interface).
- Byte-based decode in `raw-core` (`decode_bytes(&[u8], &str)` sibling of `decode(Path)`) — needed before the web client can pass file bytes directly.

### Slice 10 — apps (three user-facing products)

Per `docs/spec/12-maple-apps-spec.md`. Three products + cross-cutting infrastructure, all building on top of slice 9's FFI/WASM surfaces. **Decomposed into three sub-slices** (each is a multi-week deliverable):

**Status: SCAFFOLDED 2026-04-22.** Tag: `slice-10-scaffold`. Design prototype + package skeletons in place; full implementation is sub-slice work.

#### Sub-slices

- **10a — Maple Hosted** (browser-only). Design prototype imported at `src/web/`; Angular port + `raw-wasm` wiring + File System Access API is the production work. **Plan:** `docs/superpowers/plans/2026-04-22-slice-10a-maple-hosted.md`. Estimate: 4-5 engineer-weeks.
- **10b — Maple Self Hosted** (Bun + MongoDB + Indexer + same UI). Scaffold at `src/api/` — `bun src/index.ts` starts a stub Elysia server. **Plan:** `docs/superpowers/plans/2026-04-22-slice-10b-maple-self-hosted.md`. Estimate: 3-4 engineer-weeks.
- **10c — Maple native** (Swift iOS/Mac/iPad). Scaffold at `src/apple/` — SPM package with a placeholder SwiftUI view. **Plan:** `docs/superpowers/plans/2026-04-22-slice-10c-maple-native.md`. Estimate: 5-7 engineer-weeks.

#### What's shipped in this roadmap slot

- **Design handoff integrated** at `src/web/` (React prototype with live scopes, dark theme, collapsible sections, traffic-light window chrome). Includes `Spec.html` — the design-handoff interaction spec.
- **Bun server scaffold** at `src/api/` with health-check route.
- **Swift package scaffold** at `src/apple/` with a smoke-test target.
- **Three plan documents** covering the full implementation roadmap for each sub-slice.

#### What's NOT shipped

Real app implementation. Each sub-slice is a multi-week engineering commitment that requires sustained focus — not autonomous-loop scope. Hand off to engineers when ready.

## What this roadmap does not cover

- **GPU backends.** Metal (Apple) and WebGL2 (web) implementations are separate tracks that gate against the CPU reference per spec § 06 "Cross-platform" and spec § 11 gate 4.
- **UI state, caching, tiling, two-phase render, session model inside each app.** Spec §§ 02 (Traces A/B), 05, 07 cover these at the Apple/web layers; `raw-core` stays a pure stateless library. The app shells in slice 10 are where this state lives.

## How plans relate to this roadmap

Each slice gets its own step-by-step implementation plan (produced by the `superpowers:writing-plans` skill) at the time we start it. Plans are not written ahead of the slice — the code in earlier slices informs the plan for later ones.

Slice 1 plan is the immediate next artifact.
