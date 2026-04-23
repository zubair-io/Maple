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

### Slice 2 — tone controls complete

Full `SceneToneControls` (spec § 3.6): highlights, shadows, whites, blacks; master + RGB scene-linear tone curves (`papp:SceneLinearToneCurve*`). Contrast slider routed to AgX sigmoid slope. `DisplayReferredCurve` (spec § 3.6b) added as post-AgX stage 12a for Lightroom-compat `crs:ToneCurvePV2012*` curves.

Adds ACR cases: `contrast_*`, `highlights_*`, `shadows_*`, `whites_*`, `blacks_*`.

### Slice 3 — presence complete

SceneVibrance in Oklab with skin-window smoothstep (spec § 3.7 — endpoints locked by the pre-ship calibration gate, spec § 11 gate 7). Saturation in Oklab. Clarity + Texture (unsharp at radius 40 + radius 3 respectively) per spec § 3.8.

Adds ACR cases: `vibrance_*`, `saturation_*`, `clarity_*`, `texture_*`.

### Slice 4 — color precision

Full DCP: dual-illuminant reciprocal-CCT interpolation, HueSatMapData1/2 tri-linear interpolation in ProPhoto-HSV, ProfileLookTable (spec § 3.4 steps 3–5). Highlight reconstruction (blend + luminance modes, spec § 3.3a). Bundled camera-profile catalog for non-DNG fixtures.

Baseline + WB + exposure ΔE budgets tighten toward spec § 11 target column.

### Slice 5 — detail

Richardson-Lucy capture sharpening, 3 iter, scene-linear Rec.2020 (spec § 3.10). Noise reduction (spec § 3.11). Crop + rotation (spec § 3.12).

Adds ACR cases: `sharpen_*`, `nr_*`.

### Slice 6 — demosaic quality

Hamilton-Adams and AMaZE demosaic (spec § 3.3.3) behind `--feature high-quality-demosaic`. Half-res quad preview path (spec § 3.3.2) for large sensors.

AMaZE-dependent cases tighten; export path (spec § 02 "Trace C") uses AMaZE.

### Slice 7 — sidecar I/O + CLI complete

Canonical XMP parser and serializer with byte-exact round-trip (`docs/xmp-canonical-format.md`, spec § 01 invariants 5–7). Passthrough buckets for unknown attributes and elements. CLI `batch`, `diff`, `inspect` subcommands (spec § 10). Native edit-stack JSON as Maple's canonical form (spec § 10, § 01).

Runs full 176-case ACR matrix at all three zoom paths per spec § 11.

### Slice 8 — export formats

JPEG sRGB and Display P3, HEIC P3, TIFF 16-bit (display P3 and scene-linear ProPhoto per spec § 04 "Export color transforms"), EXR f16 scene-linear Rec.2020. Format-dependent view-transform routing (scene-linear formats skip AgX).

### Slice 9 — FFI + WASM surfaces

`raw-ffi` staticlib with C ABI (`#[no_mangle] extern "C"`, opaque handle, three exported functions per spec § 00 "Explicit stack inventory"); cbindgen-generated header; xcframework assembly script. `raw-wasm` cdylib with wasm-bindgen surface; `wasm-pack build --target web`. Apple (`MapleCore`) and web (`Maple-common`) shells can consume `raw-core` without code changes to downstream slices.

## What this roadmap does not cover

- **GPU backends.** Metal (Apple) and WebGL2 (web) implementations are separate tracks that gate against the CPU reference per spec § 06 "Cross-platform" and spec § 11 gate 4.
- **Server (Bun).** Spec § 00 marks the server as "design phase." Out of raw-core scope entirely.
- **Apple and web shells.** `MapleCore` (Swift SPM), `Maple` (SwiftUI app), Angular workspace. Built on top of `raw-core` via the FFI/WASM surfaces from slice 9.
- **UI state, caching, tiling, two-phase render, session model.** Spec §§ 02 (Traces A/B), 05, 07 cover these at the Apple/web layers; `raw-core` is a pure stateless library.

## How plans relate to this roadmap

Each slice gets its own step-by-step implementation plan (produced by the `superpowers:writing-plans` skill) at the time we start it. Plans are not written ahead of the slice — the code in earlier slices informs the plan for later ones.

Slice 1 plan is the immediate next artifact.
