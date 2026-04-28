# Synthetic Grey DNG — Pipeline Neutrality Test

**Status:** design approved, ready for implementation plan
**Date:** 2026-04-28
**Owner:** Zubair

## Problem

Every existing color-pipeline test in Maple is anchored against Adobe Camera Raw output. ACR-anchored gates catch *divergence from ACR*, but they cannot catch a bug that Maple and ACR share — for example, a uniform color cast on neutrals, or a per-channel scaling asymmetry that both pipelines happen to introduce.

We need a test with **mathematically known ground truth**, independent of any external reference. The simplest such test is: synthesize a RAW image whose scene-linear input is exactly neutral, run it through the full Maple pipeline, and assert the output is exactly neutral.

## Goal

Build a generator that emits synthetic Bayer DNGs with a known scene-linear neutral patch, plus a test harness that asserts two pipeline invariants on the rendered output:

1. **Neutrality**: every output pixel has `R == G == B` (within view-transform tolerance).
2. **Flatness**: every output pixel equals the image mean (within view-transform tolerance).

A flat-grey input is the unique signal where both invariants are simultaneously trivial in the math but easy to violate in implementation. Sharpen, demosaic, clarity, and the view transform all have failure modes that this test catches and `test_color_pipeline.sh` cannot.

## Non-goals

- Replacing `test_color_pipeline.sh`. The ACR-anchored harness still validates color *accuracy*; this validates *invariants*.
- Testing real DCP profile code paths in v1. The v1 fixture uses identity ColorMatrix and no DCP profile, so failures bisect to linearize / WB / demosaic / view-transform. A v2 with a real DCP is a follow-up.
- Highlight-rolloff behavior. The v1 sweep stops at L = 0.50 because near-white interacts with gain compression; that wants its own test.

## Architecture

```
raw-core/
  src/
    test_support/
      mod.rs
      synth_dng.rs           ← new: minimal DNG writer
    lib.rs                   ← #[cfg(any(test, feature = "test-support"))] pub mod test_support;
  examples/
    synth-grey.rs            ← new: CLI wrapper for ad-hoc generation
  tests/
    grey_invariants.rs       ← new: pipeline invariant tests
src/scripts/
  test_synthetic_grey.sh     ← new: CI gate, sibling of test_color_pipeline.sh
```

### Design decisions

- **Feature flag.** Generator code lives behind a `test-support` Cargo feature so it does not enter the shipping `libraw_ffi.a` (Apple xcframework) or `raw-wasm` binaries. Tests and the example enable the feature.
- **Hand-rolled TIFF writer.** Maple's decoder is hand-rolled; the writer mirrors it. We need only the ~12 tags `decode.rs` reads, so pulling the `tiff` crate as a dependency is unjustified (~200 LOC saved on the writer side).
- **Tempdir output.** Generated DNGs are written to `tempfile::tempdir()` per test. Nothing is committed to `test-fixtures/raws/`. The harness is fully self-contained, deterministic, and runs in CI with no fixture setup.

## Generator API

```rust
// raw-core/src/test_support/synth_dng.rs

pub struct SyntheticGreyDng {
    /// Scene-linear neutral target after black subtract + WB. Range 0.0-1.0.
    pub linear_value: f32,
    pub width: u32,            // default 64
    pub height: u32,           // default 64
    pub cfa: CfaPattern,       // default Rggb
    pub illuminant: Illuminant,// default D65
}

impl Default for SyntheticGreyDng {
    fn default() -> Self {
        Self {
            linear_value: 0.18,
            width: 64,
            height: 64,
            cfa: CfaPattern::Rggb,
            illuminant: Illuminant::D65,
        }
    }
}

impl SyntheticGreyDng {
    pub fn write_to(&self, path: &Path) -> io::Result<()>;
    pub fn write_to_bytes(&self) -> Vec<u8>;
}
```

### Per-channel raw value math

Given a target scene-linear neutral `L`, AsShotNeutral `N = (1/WB_R, 1/WB_G, 1/WB_B) = (0.5, 1.0, 0.5)` (a typical D65 daylight balance), black level `BL = 0`, and white level `WL = 65535`:

```
raw_R  = round(BL + (L / WB_R) × (WL - BL))
raw_G  = round(BL + (L / WB_G) × (WL - BL))   // G1 == G2
raw_B  = round(BL + (L / WB_B) × (WL - BL))
```

After Maple's pipeline subtracts black, divides by `(WL - BL)`, and applies WB multipliers, every channel lands on `L`. That is the input invariant the rest of the pipeline must preserve.

For `L = 0.18`: `raw_R = 5898`, `raw_G = 11796`, `raw_B = 5898`.

## Tag set

Minimal TIFF/DNG tag set — only what `raw-core/src/decode.rs` and `dng_ifd_walker.rs` consult.

| Tag                            | Value                                       | Purpose                                |
| ------------------------------ | ------------------------------------------- | -------------------------------------- |
| `NewSubfileType`               | 0                                           | Primary IFD                            |
| `ImageWidth` / `ImageLength`   | 64 / 64                                     | Patch dimensions                       |
| `BitsPerSample`                | 16                                          | 16-bit raw                             |
| `Compression`                  | 1 (none)                                    | Uncompressed strip                     |
| `PhotometricInterpretation`    | 32803 (CFA)                                 | Bayer-pattern raw                      |
| `SamplesPerPixel`              | 1                                           | Mosaic single-channel                  |
| `StripOffsets` / `StripByteCounts` / `RowsPerStrip` | computed                | Pixel data location                    |
| `CFARepeatPatternDim`          | (2, 2)                                      | 2×2 Bayer block                        |
| `CFAPattern`                   | RGGB bytes                                  | Per-position color                     |
| `BlackLevel` / `WhiteLevel`    | 0 / 65535                                   | Linearization range                    |
| `DNGVersion`                   | 1.4.0.0                                     | Spec version                           |
| `UniqueCameraModel`            | "Maple Synthetic"                           | Camera identity                        |
| `ColorMatrix1` (D65)           | identity 3×3                                | XYZ → camera RGB (identity for v1)     |
| `CameraCalibration1`           | identity 3×3                                | Per-camera tweak (identity)            |
| `AnalogBalance`                | (1, 1, 1)                                   | Analog gain                            |
| `AsShotNeutral`                | (0.5, 1.0, 0.5)                             | WB multipliers                         |
| `BaselineExposure`             | 0.0                                         | No exposure shift                      |
| `CalibrationIlluminant1`       | 21 (D65)                                    | Illuminant tag                         |

**No DCP profile tags** (`ProfileToneCurve`, `ProfileHueSatMapData*`, `ProfileLookTableData`). This routes the pipeline through the identity DCP path so any failure bisects to linearize / demosaic / WB / view-transform — not the DCP code path. A v2 fixture with a real DCP is a follow-up.

## Test invariants

### Invariant A — neutrality (color)

For every output pixel `p = (R, G, B)`:

```
|R - G| ≤ ε_color  ∧  |R - B| ≤ ε_color
```

Catches: WB asymmetry, DCP color rotation, view-transform per-channel divergence (e.g. AgX log basis tinting greys), gamma encode bugs.

### Invariant B — flatness (spatial)

For every output pixel `p`:

```
|p - mean(image)| ≤ ε_flat
```

Catches: demosaic seams on a flat patch, sharpen halos firing on noise-free input, vignette / clarity local-contrast leaking into a constant signal, any spatial filter that doesn't pass DC unchanged.

### Pipeline checkpoints

Maple's production pipeline ships exactly one view transform (AgX). To get bisection power without inventing test-only view transforms, we sample at two checkpoints:

| Checkpoint           | What it asserts                                         | API used                                                         |
| -------------------- | ------------------------------------------------------- | ---------------------------------------------------------------- |
| `SceneLinear`        | linearize + demosaic + WB + DCP preserve neutrality     | `pipeline::render_scene_linear_from_raw_with_quality`            |
| `DisplayEncodedSrgb` | full production chain (incl. AgX + sRGB encode) preserves neutrality | `pipeline::render_from_raw`                                      |

A failure that shows up at `DisplayEncodedSrgb` but not at `SceneLinear` localises the bug to the view tail (AgX, Rec.2020→sRGB, gamma encode). A failure at both points to the scene-linear chain.

### Tolerance budgets

| Checkpoint           | ε_color (relative) | ε_flat (relative) | Notes                                                        |
| -------------------- | ------------------ | ----------------- | ------------------------------------------------------------ |
| `SceneLinear` (f32)  | 1e-5               | 1e-5              | Float math, demosaic averaging — should be near-exact        |
| `DisplayEncodedSrgb` (8-bit LSB) | 2      | 2                 | AgX LUT interp + gamma encode + quantize                     |

Budgets ratchet downward only — same convention as `BUDGET` in `test_color_pipeline.sh`. CI rejects any PR that raises a budget.

### Test sweep

Three grey levels × two checkpoints = six cases per harness run:

- `L ∈ {0.05, 0.18, 0.50}`
- `checkpoint ∈ {SceneLinear, DisplayEncodedSrgb}`

Each case <1ms to render at 64×64; total harness time well under a second.

`L = 0.95` deliberately omitted — near-white interacts with highlight rolloff and gain compression, which is its own concern and deserves a separate "highlight neutrality" test.

## Test harness — `cargo test`

`raw-core/tests/grey_invariants.rs`:

```rust
#[test]
fn neutral_scene_linear_018()  { run_scene_linear_case(0.18, 1e-5, 1e-5); }

#[test]
fn neutral_display_srgb_018()  { run_display_case(0.18, 2, 2); }

// Parameterized sweep across L ∈ {0.05, 0.18, 0.50} for both checkpoints.
```

`run_scene_linear_case(L, ε_color, ε_flat)`:

1. Construct `SyntheticGreyDng { linear_value: L, ..Default::default() }`.
2. Write to `tempfile::tempdir()`.
3. Decode via `decode::decode_bytes`.
4. Run `pipeline::render_scene_linear_from_raw_with_quality` with `RenderQuality::Full`.
5. For each f32 pixel, assert `|R-G| ≤ ε_color ∧ |R-B| ≤ ε_color`.
6. Assert spatial flatness: `|p - mean| ≤ ε_flat`.

`run_display_case(L, ε_color, ε_flat)`:

1–3 same as above.
4. Run `pipeline::render_from_raw` (production AgX → sRGB → u8).
5. For each u8 RGB triple, assert `|R-G| ≤ ε_color ∧ |R-B| ≤ ε_color`.
6. Assert spatial flatness.
7. On failure, attach a per-pixel ΔRGB heatmap PNG as a debug artifact in `tempdir()`.

Tests are gated on the `test-support` feature.

## CI gate — `src/scripts/test_synthetic_grey.sh`

Sibling of `src/scripts/test_color_pipeline.sh`:

```bash
#!/usr/bin/env bash
# Synthetic grey neutrality/flatness gate.
# Inputs synthesized in-memory — no test-fixtures/raws/ needed, so this never skip-passes.
set -euo pipefail
cd "$(dirname "$0")/../raw-pipeline"
cargo test -p raw-core --features test-support --test grey_invariants -- --nocapture
```

Unlike `test_color_pipeline.sh`, this script **never skip-passes**: inputs are synthesized, so the harness always has data and always runs. That makes it a stricter regression net than the ACR-anchored harness and the right place to catch any future change that breaks neutrality or flatness.

## CLI example — `cargo run --example synth-grey`

`raw-core/examples/synth-grey.rs`:

```bash
cargo run --release -p raw-core --features test-support --example synth-grey -- \
    --value 0.18 --cfa rggb --width 64 --height 64 --out /tmp/grey.dng
```

Drops a standalone DNG you can pipe through any of the three pipeline implementations:

```bash
# Rust core via maple-cli
cargo run --release --bin maple-cli -- single /tmp/grey.dng --out /tmp/grey.png

# Apple xcframework — open /tmp/grey.dng in Maple.app

# WASM — load via the dev server's hidden file input
```

Useful for ad-hoc debugging of pipeline regressions, parity bisection across platforms, and shader development on a known-clean signal.

## Out of scope (follow-ups)

- **v2 with real DCP.** Reuse the same generator API; populate `ProfileToneCurve` + `ProfileHueSatMapData*` from a known camera profile. Tests that DCP preserves neutrals at the calibration illuminant.
- **Highlight neutrality.** Separate test sweeping `L ∈ {0.80, 0.90, 0.95, 0.99}` against the highlight-rolloff stage with looser tolerances.
- **Per-illuminant sweep.** Generate the same grey under D50, D65, A, F2 illuminants to validate WB interpolation.
- **Cross-platform parity.** Wrap the generated DNG in the existing parity harness so Apple Metal and Web WebGL outputs are also asserted neutral.

## Acceptance criteria

- `src/scripts/test_synthetic_grey.sh` exits 0 on `main` with all 6 cases passing.
- Generator round-trips through Maple's existing DNG decoder (i.e. `decode.rs` reads back the same width/height/CFA/black/white/AsShotNeutral that `SyntheticGreyDng` wrote).
- `cargo run --example synth-grey -- --value 0.18 --out /tmp/g.dng` produces a DNG that, when fed to `maple-cli single`, renders to a visually neutral grey patch (sanity check; the unit tests are the real gate).
- The new test gate runs in <2 seconds wall-clock locally.
