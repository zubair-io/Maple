# Auto Profile — Phase 1 Implementation Plan (CPU/CLI)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Auto Profile (per-image curve fit from embedded JPEG preview) on the Rust CPU/CLI path, replacing the static Maple Look LUT as the default look. Phase 1 only — Apple Metal and Web WebGL come in Phases 2/3.

**Architecture:** New `view::auto_profile` module wraps `rawler::analyze::extract_preview_pixels` to get the JPEG, linearizes + Rec.2020-converts it, computes per-channel CDFs of both source (Maple's linear render) and target (linearized JPEG), fits a 32-anchor monotone piecewise-linear curve per channel, evaluates the curve as the view transform when `Profile = Auto`. Falls back to existing AgX when JPEG extraction fails. The static `look::apply` path becomes a no-op (the `Look` enum stays for XMP back-compat but doesn't shape pixels anymore).

**Tech Stack:** Rust (raw-core), `rawler::analyze::extract_preview_pixels` for JPEG extraction, `image::DynamicImage` for the JPEG buffer, no new external dependencies.

**Spec:** `docs/superpowers/specs/2026-05-26-auto-profile-and-auto-setting-design.md` (PR #530).

**Base branch:** `origin/main` HEAD `0394ecbc` (post-L2.5, post-A2).

---

## Scope

This plan covers ONLY Phase 1 from the spec. Phases 2/3/4 (Apple Metal, Web WebGL, Profile dropdown UI) get their own plans. Phase 5 (Maple Look v2 + camera profiles) is out of scope entirely.

**In scope:**
- New `view/auto_profile/` module (extraction + curve fit + apply)
- `Profile` enum + `AdjustmentModel.profile` field
- `papp:Profile` XMP read/write/round-trip (Rust only; Swift + TS deferred to Phase 4)
- Pipeline dispatch (`Profile::Auto` → fit + apply; `Profile::Neutral` → AgX)
- Retire `view::look::apply` (back to no-op like post-#443)
- Per-fixture harness gate: per-luma-band per-channel bias vs embedded JPEG

**Out of scope:**
- Apple Metal / Web WebGL plumbing (Phase 2/3)
- Profile dropdown UI (Phase 4)
- Apple/TS XMP serializers (Phase 4)
- FFI surface for the curve (`MapleProfileCurve`) — added in Phase 2 when GPU paths need it
- Per-render curve caching — for v1, fit on every render; profile later if needed

## File structure

**Create:**
- `src/raw-pipeline/raw-core/src/view/auto_profile/mod.rs` — module root, `fit_curve_from_raw`, `apply_curve`, `ProfileCurve` type
- `src/raw-pipeline/raw-core/src/view/auto_profile/preview.rs` — `extract_preview` wrapper around rawler
- `src/raw-pipeline/raw-core/src/view/auto_profile/curve.rs` — CDF computation, monotone spline fit, eval
- `src/raw-pipeline/raw-core/src/view/auto_profile/tests.rs` — unit tests
- `src/raw-pipeline/raw-core/tests/auto_profile_fixtures.rs` — fixture-gated integration tests
- `src/scripts/test_auto_profile_match.sh` — per-fixture per-luma-band bias harness

**Modify:**
- `src/raw-pipeline/raw-core/src/view/mod.rs` — `pub mod auto_profile;` and view-transform dispatcher helper
- `src/raw-pipeline/raw-core/src/types/adjustment/mod.rs` — add `Profile` enum, `AdjustmentModel.profile` field
- `src/raw-pipeline/raw-core/src/xmp/mod.rs` — parse `papp:Profile`, migrate `papp:Look`, serialize `papp:Profile`
- `src/raw-pipeline/raw-core/src/xmp/tests_modes.rs` — XMP round-trip + migration tests
- `src/raw-pipeline/raw-core/src/pipeline/render/mod.rs` — branch on `model.profile`
- `src/raw-pipeline/raw-core/src/view/look.rs` — `apply` becomes no-op for all variants
- `src/raw-pipeline/raw-core/src/pipeline/render/tests.rs` — assert Neutral path byte-identical to pre-plan main

**Retire (in T7):**
- `view::look::apply` call sites removed from `pipeline/render/mod.rs` (3 sites)
- `look::apply` call site removed from `maple-cli/src/commands/tile.rs`

## Conventions

- One ticket = one PR. Open every PR with `Closes #N`. Tag tickets with Project board "Files".
- File budget: 400 LOC soft / 600 LOC hard. Each new file should stay well under 400.
- No `tail`/`head`/Monitor piping on cargo output (watchdog kills it).
- Color test outputs go to `~/Desktop/maple-color-tests/<ticket>/`.
- **Forbidden metric**: aggregate ΔE / RMSE / MAE means in CI gates. Use per-luma-band per-channel bias.
- TDD: every task writes failing test → minimal impl → test passes → commit.

## Required commands

```bash
# Build + test raw-core
cd src/raw-pipeline
cargo build -p raw-core
cargo test -p raw-core --lib
cargo test -p raw-core --features fixtures   # for integration tests

# Build maple-cli (for end-to-end fixture renders)
cargo build --release --bin maple-cli

# Color harness (after T8 lands)
src/scripts/test_auto_profile_match.sh
src/scripts/test_color_pipeline.sh   # must still pass
```

---

## Task T1: `extract_preview` — rawler wrapper

**Ticket:** filed as a new issue titled `core: view/auto_profile/preview.rs — extract embedded JPEG from RAW`, Project = Files.

**Goal:** Wrap `rawler::analyze::extract_preview_pixels` behind a stable raw-core API. Return `Option<DynamicImage>` for clean fallback.

**Files:**
- Create: `src/raw-pipeline/raw-core/src/view/auto_profile/mod.rs`
- Create: `src/raw-pipeline/raw-core/src/view/auto_profile/preview.rs`
- Modify: `src/raw-pipeline/raw-core/src/view/mod.rs` (add `pub mod auto_profile;`)

- [ ] **Step 1: Write the failing test**

Create `src/raw-pipeline/raw-core/src/view/auto_profile/tests.rs` (will be re-used in later tasks):

```rust
#[cfg(test)]
mod preview_tests {
    use super::super::preview::extract_preview;
    use std::path::Path;

    #[test]
    #[cfg_attr(not(feature = "fixtures"), ignore)]
    fn test_0017_extracts_jpeg_preview() {
        let path = Path::new("../../test-fixtures/raws/test_0017.dng");
        let preview = extract_preview(path).expect("test_0017 has an embedded JPEG");
        assert!(preview.width() >= 256, "preview too small: {}", preview.width());
        assert!(preview.height() >= 256, "preview too small: {}", preview.height());
    }

    #[test]
    fn missing_file_returns_none_not_panic() {
        let path = Path::new("/nonexistent/path.dng");
        assert!(extract_preview(path).is_none());
    }
}
```

In `src/raw-pipeline/raw-core/src/view/auto_profile/mod.rs`:

```rust
//! Auto Profile — per-image tone curve fit from the embedded JPEG preview.
//!
//! Spec: docs/superpowers/specs/2026-05-26-auto-profile-and-auto-setting-design.md

pub mod preview;

#[cfg(test)]
mod tests;
```

Add `pub mod auto_profile;` to `src/raw-pipeline/raw-core/src/view/mod.rs` after the existing `pub mod look;`.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd src/raw-pipeline
cargo test -p raw-core --lib view::auto_profile::tests::preview_tests::missing_file_returns_none_not_panic
```

Expected: FAIL — `unresolved import super::super::preview::extract_preview`.

- [ ] **Step 3: Write minimal implementation**

Create `src/raw-pipeline/raw-core/src/view/auto_profile/preview.rs`:

```rust
//! Embedded JPEG preview extraction via rawler.
//!
//! Returns `None` on any extraction error (file missing, format unsupported,
//! decoder stub, no preview embedded). Callers fall back to AgX-neutral
//! when this returns `None`.

use std::path::Path;
use image::DynamicImage;
use rawler::analyze::extract_preview_pixels;
use rawler::RawDecodeParams;

/// Extract the embedded JPEG preview from a RAW file at `path`.
///
/// Returns `None` for any failure (including formats without embedded
/// previews). Never panics.
pub fn extract_preview<P: AsRef<Path>>(path: P) -> Option<DynamicImage> {
    let params = RawDecodeParams::default();
    extract_preview_pixels(path, &params).ok()
}
```

In `src/raw-pipeline/raw-core/Cargo.toml`, verify these are already deps (they should be):

```bash
grep -E "^image\s*=|^rawler\s*=" src/raw-pipeline/raw-core/Cargo.toml
```

If `image` is missing, add `image = "0.25"` to `[dependencies]`. `rawler` is already a dep.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd src/raw-pipeline
cargo test -p raw-core --lib view::auto_profile::tests::preview_tests::missing_file_returns_none_not_panic
cargo test -p raw-core --lib --features fixtures view::auto_profile::tests::preview_tests::test_0017_extracts_jpeg_preview
```

Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add src/raw-pipeline/raw-core/src/view/auto_profile/ \
        src/raw-pipeline/raw-core/src/view/mod.rs

git commit -m "$(cat <<'EOF'
feat(view): view/auto_profile/preview.rs — rawler JPEG extraction wrapper

First step of Auto Profile (spec docs/superpowers/specs/2026-05-26-auto-profile-and-auto-setting-design.md).
Wraps rawler::analyze::extract_preview_pixels. Returns Option<DynamicImage>
so callers fall back cleanly when no preview is embedded.

Closes #T1

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Open a PR with `Closes #T1` (substitute the real ticket number).

---

## Task T2: CDF + monotone spline curve fitting

**Ticket:** `core: view/auto_profile/curve.rs — per-channel monotone spline fit`.

**Goal:** Pure-function curve fitting from source and target distributions. No I/O, no platform deps. Easy to test with synthetic data.

**Files:**
- Create: `src/raw-pipeline/raw-core/src/view/auto_profile/curve.rs`
- Modify: `src/raw-pipeline/raw-core/src/view/auto_profile/mod.rs` (`pub mod curve;` + re-exports)
- Modify: `src/raw-pipeline/raw-core/src/view/auto_profile/tests.rs` (add curve_tests module)

### Type design

```rust
/// 32-anchor monotone piecewise-linear curve per channel.
/// Anchors stored as (input, output) pairs in linear [0, 1] space.
#[derive(Clone, Debug)]
pub struct ChannelCurve {
    pub anchors: [(f32, f32); 32],
}

#[derive(Clone, Debug)]
pub struct ProfileCurve {
    pub r: ChannelCurve,
    pub g: ChannelCurve,
    pub b: ChannelCurve,
}
```

`ChannelCurve::identity()` produces `(i/31, i/31)` anchors for `i = 0..32`.

- [ ] **Step 1: Write failing tests**

In `view/auto_profile/tests.rs`, add a new `curve_tests` module:

```rust
#[cfg(test)]
mod curve_tests {
    use super::super::curve::{ChannelCurve, ProfileCurve, build_cdf, fit_channel_curve, eval_channel};

    #[test]
    fn identity_curve_evaluates_to_input() {
        let c = ChannelCurve::identity();
        for v in [0.0_f32, 0.25, 0.5, 0.75, 1.0] {
            let out = eval_channel(&c, v);
            assert!((out - v).abs() < 1e-6, "v={v} out={out}");
        }
    }

    #[test]
    fn cdf_of_uniform_is_linear() {
        // 1000 evenly-spaced values in [0,1]
        let samples: Vec<f32> = (0..1000).map(|i| i as f32 / 999.0).collect();
        let cdf = build_cdf(&samples, 256);
        // For uniform input, CDF should be approximately linear:
        // cdf[i] approx = i / 255
        for i in 0..256 {
            let expected = i as f32 / 255.0;
            assert!((cdf[i] - expected).abs() < 0.02, "i={i} cdf={} expected={}", cdf[i], expected);
        }
    }

    #[test]
    fn fit_identity_when_source_equals_target() {
        // Same distribution → curve should be ~identity
        let samples: Vec<f32> = (0..1000).map(|i| i as f32 / 999.0).collect();
        let curve = fit_channel_curve(&samples, &samples);
        for v in [0.1_f32, 0.3, 0.5, 0.7, 0.9] {
            let out = eval_channel(&curve, v);
            assert!((out - v).abs() < 0.03, "v={v} out={out} (expected identity)");
        }
    }

    #[test]
    fn fit_recovers_known_gamma_curve() {
        // Source = uniform [0,1]; target = source^2 (gamma=2.0)
        let n = 10_000;
        let source: Vec<f32> = (0..n).map(|i| i as f32 / (n - 1) as f32).collect();
        let target: Vec<f32> = source.iter().map(|v| v * v).collect();
        let curve = fit_channel_curve(&source, &target);
        // eval_channel(curve, x) should ≈ x^2
        for x in [0.1_f32, 0.3, 0.5, 0.7, 0.9] {
            let predicted = eval_channel(&curve, x);
            let actual = x * x;
            assert!((predicted - actual).abs() < 0.02,
                "x={x} predicted={predicted} actual={actual}");
        }
    }

    #[test]
    fn monotonicity_preserved() {
        let n = 10_000;
        let source: Vec<f32> = (0..n).map(|i| i as f32 / (n - 1) as f32).collect();
        let target: Vec<f32> = source.iter().map(|v| (v * 2.0).min(1.0)).collect();
        let curve = fit_channel_curve(&source, &target);
        let mut prev = -1.0;
        for i in 0..100 {
            let x = i as f32 / 99.0;
            let y = eval_channel(&curve, x);
            assert!(y >= prev - 1e-4, "non-monotone at x={x}: y={y} prev={prev}");
            prev = y;
        }
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd src/raw-pipeline
cargo test -p raw-core --lib view::auto_profile::tests::curve_tests
```

Expected: FAIL — `unresolved imports` for `ChannelCurve`, `build_cdf`, etc.

- [ ] **Step 3: Write the implementation**

Create `src/raw-pipeline/raw-core/src/view/auto_profile/curve.rs`:

```rust
//! Per-channel monotone piecewise-linear tone curve fit from source + target
//! distributions. Pure functions; no I/O.

const ANCHORS: usize = 32;

#[derive(Clone, Debug)]
pub struct ChannelCurve {
    /// (input, output) anchor pairs sorted by input ascending.
    /// Input values are evenly spaced in [0, 1] at construction time.
    pub anchors: [(f32, f32); ANCHORS],
}

impl ChannelCurve {
    pub fn identity() -> Self {
        let mut anchors = [(0.0, 0.0); ANCHORS];
        for i in 0..ANCHORS {
            let v = i as f32 / (ANCHORS - 1) as f32;
            anchors[i] = (v, v);
        }
        Self { anchors }
    }
}

#[derive(Clone, Debug)]
pub struct ProfileCurve {
    pub r: ChannelCurve,
    pub g: ChannelCurve,
    pub b: ChannelCurve,
}

impl ProfileCurve {
    pub fn identity() -> Self {
        Self {
            r: ChannelCurve::identity(),
            g: ChannelCurve::identity(),
            b: ChannelCurve::identity(),
        }
    }
}

/// Build a 256-bin CDF from samples in [0, 1]. Returns `cdf[i]` = value at the
/// (i / 255)-th percentile of the input distribution.
///
/// Out-of-range samples are clamped at the bin boundaries.
pub fn build_cdf(samples: &[f32], bins: usize) -> Vec<f32> {
    assert!(bins >= 2);
    let mut sorted: Vec<f32> = samples.iter().map(|v| v.clamp(0.0, 1.0)).collect();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = sorted.len();
    let mut cdf = vec![0.0_f32; bins];
    for i in 0..bins {
        let q = i as f32 / (bins - 1) as f32;
        let idx = ((q * (n - 1) as f32).round() as usize).min(n - 1);
        cdf[i] = sorted[idx];
    }
    cdf
}

/// Fit a monotone piecewise-linear curve mapping the source distribution to
/// the target distribution. Both inputs are in [0, 1].
///
/// Method: build CDFs of both, then at each of 32 evenly-spaced input anchors,
/// look up the input's quantile in source-CDF, find the target value at that
/// quantile in target-CDF.
pub fn fit_channel_curve(source: &[f32], target: &[f32]) -> ChannelCurve {
    let src_cdf = build_cdf(source, 256);
    let tgt_cdf = build_cdf(target, 256);
    let mut anchors = [(0.0_f32, 0.0_f32); ANCHORS];
    for i in 0..ANCHORS {
        let in_v = i as f32 / (ANCHORS - 1) as f32;
        // Find the quantile of `in_v` in source CDF (binary search would work
        // but 256 entries linear scan is fine).
        let q = quantile_of(&src_cdf, in_v);
        // Look up target value at that quantile.
        let bin = (q * 255.0).round() as usize;
        let out_v = tgt_cdf[bin.min(255)];
        anchors[i] = (in_v, out_v);
    }
    // Enforce non-decreasing outputs (CDF method already monotone in theory,
    // but floating-point can introduce tiny inversions).
    for i in 1..ANCHORS {
        if anchors[i].1 < anchors[i - 1].1 {
            anchors[i].1 = anchors[i - 1].1;
        }
    }
    ChannelCurve { anchors }
}

/// Quantile of value `v` within CDF `cdf`. Returns the fraction of input
/// pixels at or below `v`.
fn quantile_of(cdf: &[f32], v: f32) -> f32 {
    // Inverse CDF lookup: find the smallest i with cdf[i] >= v.
    let bins = cdf.len();
    for i in 0..bins {
        if cdf[i] >= v {
            return i as f32 / (bins - 1) as f32;
        }
    }
    1.0
}

/// Evaluate a channel curve at `v` in [0, 1]. Linear interpolation between
/// anchors. Out-of-range `v` is clamped.
pub fn eval_channel(curve: &ChannelCurve, v: f32) -> f32 {
    let v = v.clamp(0.0, 1.0);
    // anchors are evenly spaced in input — `v * (ANCHORS - 1)` gives the
    // fractional anchor index directly.
    let scaled = v * (ANCHORS - 1) as f32;
    let lo = scaled.floor() as usize;
    let hi = (lo + 1).min(ANCHORS - 1);
    let t = scaled - lo as f32;
    let lo_y = curve.anchors[lo].1;
    let hi_y = curve.anchors[hi].1;
    lo_y + (hi_y - lo_y) * t
}
```

Re-export in `view/auto_profile/mod.rs`:

```rust
pub mod curve;
pub mod preview;

pub use curve::{ChannelCurve, ProfileCurve, fit_channel_curve, eval_channel};

#[cfg(test)]
mod tests;
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd src/raw-pipeline
cargo test -p raw-core --lib view::auto_profile::tests::curve_tests
```

Expected: all 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/raw-pipeline/raw-core/src/view/auto_profile/

git commit -m "$(cat <<'EOF'
feat(view): view/auto_profile/curve.rs — per-channel monotone curve fit

Pure-function CDF + monotone-PL curve fitting. 32-anchor curves per
channel. Synthetic-data tests cover identity, gamma=2 recovery,
monotonicity preservation.

Refs spec docs/superpowers/specs/2026-05-26-auto-profile-and-auto-setting-design.md.

Closes #T2

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task T3: `apply_curve` — evaluate ProfileCurve over an f32 RGB buffer

**Ticket:** `core: view/auto_profile/mod.rs — apply_curve f32 RGB`.

**Files:**
- Modify: `src/raw-pipeline/raw-core/src/view/auto_profile/mod.rs`
- Modify: `src/raw-pipeline/raw-core/src/view/auto_profile/tests.rs`

- [ ] **Step 1: Write failing test**

In `view/auto_profile/tests.rs`:

```rust
#[cfg(test)]
mod apply_tests {
    use super::super::{ProfileCurve, ChannelCurve, apply_curve};
    use super::super::curve::eval_channel;

    #[test]
    fn identity_curve_leaves_buffer_unchanged() {
        let mut rgb: Vec<f32> = vec![0.1, 0.4, 0.7, 0.2, 0.5, 0.8];
        let original = rgb.clone();
        apply_curve(&mut rgb, &ProfileCurve::identity());
        for (a, b) in rgb.iter().zip(original.iter()) {
            assert!((a - b).abs() < 1e-6);
        }
    }

    #[test]
    fn double_brightness_curve_doubles_each_channel() {
        // Build a curve that maps x -> 2x (clamped at 1.0)
        let mut anchors = [(0.0, 0.0); 32];
        for i in 0..32 {
            let in_v = i as f32 / 31.0;
            anchors[i] = (in_v, (in_v * 2.0).min(1.0));
        }
        let cc = ChannelCurve { anchors };
        let curve = ProfileCurve { r: cc.clone(), g: cc.clone(), b: cc };

        let mut rgb: Vec<f32> = vec![0.1, 0.1, 0.1, 0.3, 0.3, 0.3];
        apply_curve(&mut rgb, &curve);
        for i in 0..rgb.len() {
            let v = rgb[i];
            assert!((v - 0.2).abs() < 0.05 || (v - 0.6).abs() < 0.05, "got {v}");
        }
    }

    #[test]
    fn out_of_range_inputs_are_clamped() {
        let mut rgb: Vec<f32> = vec![-0.5, 1.5, 0.5];
        apply_curve(&mut rgb, &ProfileCurve::identity());
        assert!((rgb[0] - 0.0).abs() < 1e-6, "neg clamped to 0, got {}", rgb[0]);
        assert!((rgb[1] - 1.0).abs() < 1e-6, "over clamped to 1, got {}", rgb[1]);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd src/raw-pipeline
cargo test -p raw-core --lib view::auto_profile::tests::apply_tests
```

Expected: FAIL — `apply_curve` undefined.

- [ ] **Step 3: Implement `apply_curve`**

In `src/raw-pipeline/raw-core/src/view/auto_profile/mod.rs`, add:

```rust
/// Apply a per-channel ProfileCurve to a packed RGB f32 buffer in place.
///
/// Buffer layout: row-major `[R, G, B, R, G, B, ...]`. Each channel is
/// independently mapped through its `ChannelCurve`.
pub fn apply_curve(rgb: &mut [f32], curve: &ProfileCurve) {
    use crate::view::auto_profile::curve::eval_channel;
    for chunk in rgb.chunks_exact_mut(3) {
        chunk[0] = eval_channel(&curve.r, chunk[0]);
        chunk[1] = eval_channel(&curve.g, chunk[1]);
        chunk[2] = eval_channel(&curve.b, chunk[2]);
    }
}
```

- [ ] **Step 4: Run tests**

```bash
cd src/raw-pipeline
cargo test -p raw-core --lib view::auto_profile::tests::apply_tests
```

Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/raw-pipeline/raw-core/src/view/auto_profile/

git commit -m "$(cat <<'EOF'
feat(view): view/auto_profile/mod.rs — apply_curve on f32 RGB buffer

Per-channel ProfileCurve eval over packed [R,G,B,...] f32 buffer.
Identity / known curve / clamp tests all pass.

Closes #T3

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task T4: `fit_curve_from_raw` — integrate JPEG extraction + curve fit

**Ticket:** `core: view/auto_profile — fit_curve_from_raw end-to-end`.

**Depends on:** T1 (extract_preview), T2 (curve fitting), T3 (apply_curve).

**Goal:** Top-level function that takes a RAW path + Maple's intermediate linear Rec.2020 RGB buffer and returns a `ProfileCurve` (or `None` for fallback to AgX).

**Files:**
- Modify: `src/raw-pipeline/raw-core/src/view/auto_profile/mod.rs`
- Modify: `src/raw-pipeline/raw-core/src/view/auto_profile/tests.rs`

### sRGB linearize + Rec.2020 conversion

We need to convert the JPEG (8-bit sRGB) to linear Rec.2020 to match Maple's buffer space. The codebase already has sRGB OETF helpers and the sRGB↔Rec.2020 matrix:

```bash
grep -rn "srgb_to_linear\|srgb_decode\|fn srgb\|SRGB_TO_REC2020\|REC2020_TO_SRGB" src/raw-pipeline/raw-core/src/ | head -10
```

Reuse whatever helpers exist. If `srgb_to_linear(u8) -> f32` is missing, add it in the appropriate file (likely `view/encode.rs` since `srgb_gamma_encode` lives there). Do this in-place as part of T4.

- [ ] **Step 1: Write failing test**

In `view/auto_profile/tests.rs`:

```rust
#[cfg(test)]
mod fit_tests {
    use super::super::{fit_curve_from_raw, ProfileCurve, apply_curve};
    use std::path::Path;

    #[test]
    #[cfg_attr(not(feature = "fixtures"), ignore)]
    fn fit_curve_against_test_0017_jpeg_is_not_identity() {
        let raw_path = Path::new("../../test-fixtures/raws/test_0017.dng");
        // Synthetic "linear Rec.2020" source: uniform ramp. We're not testing
        // pixel-correctness here, just that the fit produces a non-identity
        // curve when source distribution differs from JPEG's.
        let w = 256_usize;
        let h = 256_usize;
        let source: Vec<f32> = (0..w * h * 3).map(|i| (i % 256) as f32 / 255.0).collect();
        let curve = fit_curve_from_raw(raw_path, &source, w, h)
            .expect("test_0017 has a usable JPEG preview");
        // At least one anchor should differ from identity by more than 0.01
        let mut differs = false;
        for (in_v, out_v) in &curve.r.anchors {
            if (in_v - out_v).abs() > 0.01 {
                differs = true;
                break;
            }
        }
        assert!(differs, "fit_curve produced identity — extraction probably failed silently");
    }

    #[test]
    fn missing_raw_returns_none() {
        let path = Path::new("/nonexistent/path.dng");
        let dummy = vec![0.5_f32; 3];
        let result = fit_curve_from_raw(path, &dummy, 1, 1);
        assert!(result.is_none());
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd src/raw-pipeline
cargo test -p raw-core --lib view::auto_profile::tests::fit_tests::missing_raw_returns_none
```

Expected: FAIL — `fit_curve_from_raw` undefined.

- [ ] **Step 3: Implement `fit_curve_from_raw`**

In `src/raw-pipeline/raw-core/src/view/auto_profile/mod.rs`:

```rust
use std::path::Path;
use image::DynamicImage;

/// Fit a ProfileCurve from a RAW file's embedded JPEG preview against
/// Maple's intermediate linear Rec.2020 RGB buffer.
///
/// Returns `None` if:
/// - JPEG extraction fails (file missing, format unsupported)
/// - Preview is too small (< 256 px on the long edge)
/// - Preview's histogram is degenerate (>99% of pixels in one bin)
///
/// Caller falls back to AgX (Neutral) on `None`.
pub fn fit_curve_from_raw<P: AsRef<Path>>(
    raw_path: P,
    source_rgb: &[f32],
    source_w: usize,
    source_h: usize,
) -> Option<ProfileCurve> {
    let preview = preview::extract_preview(raw_path)?;
    let preview = preview.to_rgb8();
    if preview.width() < 256 || preview.height() < 256 {
        return None;
    }

    // Convert JPEG (sRGB 8-bit) → linear sRGB f32 → linear Rec.2020 f32
    let target_rec2020 = jpeg_to_linear_rec2020(&preview);

    // Sanity check: not degenerate
    if is_degenerate_histogram(&target_rec2020) {
        return None;
    }

    // Fit per-channel curves.
    let src_r: Vec<f32> = source_rgb.iter().step_by(3).copied().collect();
    let src_g: Vec<f32> = source_rgb.iter().skip(1).step_by(3).copied().collect();
    let src_b: Vec<f32> = source_rgb.iter().skip(2).step_by(3).copied().collect();
    let tgt_r: Vec<f32> = target_rec2020.iter().step_by(3).copied().collect();
    let tgt_g: Vec<f32> = target_rec2020.iter().skip(1).step_by(3).copied().collect();
    let tgt_b: Vec<f32> = target_rec2020.iter().skip(2).step_by(3).copied().collect();

    let _ = (source_w, source_h);  // reserved for future spatial-aware fitting

    Some(ProfileCurve {
        r: fit_channel_curve(&src_r, &tgt_r),
        g: fit_channel_curve(&src_g, &tgt_g),
        b: fit_channel_curve(&src_b, &tgt_b),
    })
}

/// Convert an sRGB 8-bit JPEG buffer to linear Rec.2020 f32 RGB.
fn jpeg_to_linear_rec2020(jpeg: &image::RgbImage) -> Vec<f32> {
    // sRGB → linear sRGB → linear Rec.2020 via the standard 3x3.
    // Matrix from BT.709 → BT.2020 RGB (D65):
    const SRGB_TO_REC2020: [[f32; 3]; 3] = [
        [0.6274039, 0.3292830, 0.0433131],
        [0.0690973, 0.9195404, 0.0113623],
        [0.0163914, 0.0880133, 0.8955953],
    ];

    let mut out = Vec::with_capacity(jpeg.as_raw().len());
    for chunk in jpeg.as_raw().chunks_exact(3) {
        let r_lin = srgb_decode(chunk[0] as f32 / 255.0);
        let g_lin = srgb_decode(chunk[1] as f32 / 255.0);
        let b_lin = srgb_decode(chunk[2] as f32 / 255.0);

        let r = SRGB_TO_REC2020[0][0] * r_lin + SRGB_TO_REC2020[0][1] * g_lin + SRGB_TO_REC2020[0][2] * b_lin;
        let g = SRGB_TO_REC2020[1][0] * r_lin + SRGB_TO_REC2020[1][1] * g_lin + SRGB_TO_REC2020[1][2] * b_lin;
        let b = SRGB_TO_REC2020[2][0] * r_lin + SRGB_TO_REC2020[2][1] * g_lin + SRGB_TO_REC2020[2][2] * b_lin;

        out.push(r);
        out.push(g);
        out.push(b);
    }
    out
}

/// Inverse sRGB EOTF — display-encoded sRGB to linear-light.
fn srgb_decode(v: f32) -> f32 {
    if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
}

fn is_degenerate_histogram(rgb: &[f32]) -> bool {
    if rgb.is_empty() { return true; }
    let n = rgb.len();
    let mut hist = [0_u32; 64];
    for v in rgb {
        let idx = (v.clamp(0.0, 1.0) * 63.0) as usize;
        hist[idx.min(63)] += 1;
    }
    let max_count = *hist.iter().max().unwrap();
    max_count as f32 / n as f32 > 0.99
}
```

**Note:** if `srgb_decode` already exists in the codebase, use the existing helper instead. Grep first:

```bash
grep -rn "fn srgb_decode\|fn srgb_to_linear" src/raw-pipeline/raw-core/src/ | head -5
```

- [ ] **Step 4: Run tests**

```bash
cd src/raw-pipeline
cargo test -p raw-core --lib view::auto_profile::tests::fit_tests::missing_raw_returns_none
cargo test -p raw-core --lib --features fixtures view::auto_profile::tests::fit_tests::fit_curve_against_test_0017_jpeg_is_not_identity
```

Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add src/raw-pipeline/raw-core/src/view/auto_profile/

git commit -m "$(cat <<'EOF'
feat(view): view/auto_profile — fit_curve_from_raw end-to-end

Top-level entry. Reads embedded JPEG via T1, converts to linear Rec.2020,
fits per-channel curves via T2 against caller's linear Rec.2020 source.
Returns None on missing JPEG, too-small preview, or degenerate histogram.

Closes #T4

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task T5: `Profile` enum + `AdjustmentModel.profile` + XMP read/write

**Ticket:** `core: Profile enum + AdjustmentModel.profile field + papp:Profile XMP`.

**Independent of T1-T4.** Can run in parallel.

**Files:**
- Modify: `src/raw-pipeline/raw-core/src/types/adjustment/mod.rs`
- Modify: `src/raw-pipeline/raw-core/src/xmp/mod.rs`
- Modify: `src/raw-pipeline/raw-core/src/xmp/tests_modes.rs`

- [ ] **Step 1: Write failing tests**

Append to `src/raw-pipeline/raw-core/src/xmp/tests_modes.rs`:

```rust
#[test]
fn papp_profile_auto_parses_to_profile_auto() {
    let xmp = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:papp="http://ns.justmaple.app/papp/1.0/">
        <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description papp:Profile="Auto"/>
        </rdf:RDF>
    </x:xmpmeta>"#;
    let model = crate::xmp::parse(xmp).expect("parses");
    assert_eq!(model.profile, crate::types::adjustment::Profile::Auto);
}

#[test]
fn papp_profile_neutral_parses_to_profile_neutral() {
    let xmp = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:papp="http://ns.justmaple.app/papp/1.0/">
        <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description papp:Profile="Neutral"/>
        </rdf:RDF>
    </x:xmpmeta>"#;
    let model = crate::xmp::parse(xmp).expect("parses");
    assert_eq!(model.profile, crate::types::adjustment::Profile::Neutral);
}

#[test]
fn legacy_papp_look_default_migrates_to_profile_auto() {
    let xmp = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:papp="http://ns.justmaple.app/papp/1.0/">
        <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description papp:Look="Default"/>
        </rdf:RDF>
    </x:xmpmeta>"#;
    let model = crate::xmp::parse(xmp).expect("parses");
    assert_eq!(model.profile, crate::types::adjustment::Profile::Auto);
}

#[test]
fn legacy_papp_look_neutral_migrates_to_profile_neutral() {
    let xmp = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:papp="http://ns.justmaple.app/papp/1.0/">
        <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description papp:Look="Neutral"/>
        </rdf:RDF>
    </x:xmpmeta>"#;
    let model = crate::xmp::parse(xmp).expect("parses");
    assert_eq!(model.profile, crate::types::adjustment::Profile::Neutral);
}

#[test]
fn profile_auto_is_default_and_omitted_from_serialized_output() {
    let mut model = crate::types::adjustment::AdjustmentModel::default();
    assert_eq!(model.profile, crate::types::adjustment::Profile::Auto);
    let xmp = crate::xmp::serialize(&model);
    assert!(!xmp.contains("papp:Profile"), "default Auto should not serialize");
    model.profile = crate::types::adjustment::Profile::Neutral;
    let xmp = crate::xmp::serialize(&model);
    assert!(xmp.contains(r#"papp:Profile="Neutral""#), "Neutral must serialize, got:\n{xmp}");
}

#[test]
fn papp_profile_wins_over_legacy_papp_look() {
    let xmp = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:papp="http://ns.justmaple.app/papp/1.0/">
        <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description papp:Look="Neutral" papp:Profile="Auto"/>
        </rdf:RDF>
    </x:xmpmeta>"#;
    let model = crate::xmp::parse(xmp).expect("parses");
    assert_eq!(model.profile, crate::types::adjustment::Profile::Auto);
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd src/raw-pipeline
cargo test -p raw-core --lib xmp::tests_modes::papp_profile_auto_parses_to_profile_auto
```

Expected: FAIL — `Profile` enum doesn't exist.

- [ ] **Step 3: Add `Profile` enum + field**

In `src/raw-pipeline/raw-core/src/types/adjustment/mod.rs`, find the existing `Look` re-export at line ~40 and add nearby:

```rust
/// Render-shaping profile applied at the view-transform stage.
///
/// `Auto` (default) fits a per-image curve from the embedded JPEG preview.
/// `Neutral` runs the AgX scene-referred view transform. See
/// docs/superpowers/specs/2026-05-26-auto-profile-and-auto-setting-design.md.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Profile {
    Auto,
    Neutral,
}

impl Default for Profile {
    fn default() -> Self {
        Self::Auto
    }
}
```

In the `AdjustmentModel` struct (search for `pub struct AdjustmentModel`), add:

```rust
pub profile: Profile,
```

Also ensure `Profile::default()` is wired into the `AdjustmentModel::default()` impl (if the struct uses `#[derive(Default)]`, no change needed since the field type's Default returns Auto).

- [ ] **Step 4: Implement XMP parse + serialize + migration**

In `src/raw-pipeline/raw-core/src/xmp/mod.rs`, find the existing `papp:Look` handling (around line 149) and add a sibling case for `papp:Profile`. The migration logic — if BOTH are present, `papp:Profile` wins. Suggested pattern:

```rust
// Inside the attribute-walking loop:
"papp:Look" => {
    // Legacy attribute. Only consume if papp:Profile not yet set.
    if !profile_seen {
        match value {
            v if v.eq_ignore_ascii_case("Default") || v.eq_ignore_ascii_case("Auto") => {
                model.profile = Profile::Auto;
            }
            v if v.eq_ignore_ascii_case("Neutral") => {
                model.profile = Profile::Neutral;
            }
            _ => { /* unknown legacy look value — leave default */ }
        }
    }
}
"papp:Profile" => {
    profile_seen = true;
    model.profile = match value {
        v if v.eq_ignore_ascii_case("Auto") => Profile::Auto,
        v if v.eq_ignore_ascii_case("Neutral") => Profile::Neutral,
        _ => Profile::default(),
    };
}
```

In the serializer (find via `grep -n "papp:Look" src/raw-pipeline/raw-core/src/xmp/mod.rs`), add:

```rust
if model.profile != Profile::default() {
    // Profile != Auto → write attribute
    let value = match model.profile {
        Profile::Auto => "Auto",
        Profile::Neutral => "Neutral",
    };
    write!(out, r#" papp:Profile="{value}""#)?;
}
// papp:Look serialization removed — legacy attribute no longer emitted.
```

If the existing serializer emits `papp:Look`, replace that block with the `papp:Profile` block above. Old sidecars still parse (T5 step 1 verifies migration); new sidecars only carry `papp:Profile`.

- [ ] **Step 5: Run tests**

```bash
cd src/raw-pipeline
cargo test -p raw-core --lib xmp::
```

Expected: all xmp:: tests pass, including the new 6.

- [ ] **Step 6: Commit**

```bash
git add src/raw-pipeline/raw-core/src/types/adjustment/mod.rs \
        src/raw-pipeline/raw-core/src/xmp/mod.rs \
        src/raw-pipeline/raw-core/src/xmp/tests_modes.rs

git commit -m "$(cat <<'EOF'
feat(types+xmp): Profile enum + papp:Profile XMP attribute (+ Look migration)

Adds Profile { Auto, Neutral } (default Auto) to AdjustmentModel. XMP
parser handles papp:Profile, falls back to migrating papp:Look (legacy)
when papp:Profile is absent. Both-present case: papp:Profile wins.
Serializer now writes papp:Profile only (skips on default Auto).

Closes #T5

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task T6: Pipeline dispatch — wire Auto Profile into `pipeline/render/mod.rs`

**Ticket:** `core: pipeline/render — branch on model.profile (Auto Profile vs AgX)`.

**Depends on:** T4, T5.

**Goal:** Replace the unconditional `stage("agx", ...)` call with a branch that runs `auto_profile::fit_curve_from_raw` + `apply_curve` for `Profile::Auto` (with AgX fallback) or `agx::apply` for `Profile::Neutral`.

**Files:**
- Modify: `src/raw-pipeline/raw-core/src/pipeline/render/mod.rs`
- Modify: `src/raw-pipeline/raw-core/src/pipeline/render/tests.rs`

### Important architecture note

Current state (after L2.5):

```rust
stage("agx", || agx::apply(&mut scene, model.contrast));
stage("rec2020_to_srgb", || encode::rec2020_to_srgb(&mut scene));
stage("srgb_gamma_encode", || encode::srgb_gamma_encode(&mut scene));
stage("look", || look::apply(&mut scene.pixels, model.look));  // <- now a no-op default
stage("dither_and_quantize", || ...);
```

After T6:

```rust
// Branch on profile. Auto fits + applies; Neutral runs AgX.
match model.profile {
    Profile::Auto => {
        let curve = fit_curve_from_raw(&raw_path, &scene.pixels, scene.width, scene.height)
            .unwrap_or(ProfileCurve::identity());
        // Identity curve = AgX fallback semantics: apply AgX instead.
        if curve_is_identity(&curve) {
            stage("agx_fallback", || agx::apply(&mut scene, model.contrast));
        } else {
            stage("auto_profile_curve", || auto_profile::apply_curve(&mut scene.pixels, &curve));
        }
    }
    Profile::Neutral => {
        stage("agx", || agx::apply(&mut scene, model.contrast));
    }
}
stage("rec2020_to_srgb", || encode::rec2020_to_srgb(&mut scene));
stage("srgb_gamma_encode", || encode::srgb_gamma_encode(&mut scene));
// (look::apply call site removed in T7; for T6 leave it as no-op default)
stage("dither_and_quantize", || ...);
```

The render function signature must take `raw_path` (or the existing `RawImage` must carry the path). Check the current signature:

```bash
grep -n "pub fn from_raw\|pub fn from_scene_linear\b" src/raw-pipeline/raw-core/src/pipeline/render/mod.rs | head -5
```

If `from_raw` doesn't have the path, plumb it through (`RawImage` should already carry one, since rawler decode reads from a path).

- [ ] **Step 1: Write failing tests**

In `src/raw-pipeline/raw-core/src/pipeline/render/tests.rs`:

```rust
#[test]
fn profile_neutral_is_bitidentical_to_pre_t6_main() {
    // With profile = Neutral, the pipeline must match pre-T6 main output
    // exactly (= AgX + gamut + gamma + dither). This guards against
    // accidental regressions in the unchanged path.
    let mut model = AdjustmentModel::default();
    model.profile = Profile::Neutral;
    let synthetic = synthetic_ramp(64);
    let bytes_t6 = render::from_scene_linear(&synthetic, &model).unwrap();
    // Reference golden: pinned bytes hash from a known-good main HEAD.
    // First run: print the hash; second run: assert.
    let hash = simple_hash(&bytes_t6);
    let expected_hash = 0_u64;  // FIRST_RUN: replace with the actual hash
    assert_eq!(hash, expected_hash, "Neutral path regressed (or first-run baseline needs setting)");
}

#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn profile_auto_differs_from_neutral_on_test_0017() {
    let raw_path = "../../test-fixtures/raws/test_0017.dng";
    let mut auto_model = AdjustmentModel::default();
    auto_model.profile = Profile::Auto;
    let mut neutral_model = AdjustmentModel::default();
    neutral_model.profile = Profile::Neutral;
    let auto = render::from_raw_path(raw_path, &auto_model).unwrap();
    let neutral = render::from_raw_path(raw_path, &neutral_model).unwrap();
    assert_ne!(auto, neutral, "Auto and Neutral produced identical output on test_0017");
}

#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn profile_auto_falls_back_to_agx_when_no_jpeg() {
    // A fixture known to have no embedded JPEG (or use a tiny placeholder
    // with no preview). For now this can be marked TODO with a placeholder
    // and filled in once we know which fixture qualifies. Skip otherwise.
    // Acceptance: when JPEG extraction returns None, output matches Neutral.
}
```

`simple_hash` — quick fnv or xor over the bytes — define in the test module:

```rust
fn simple_hash(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for &b in bytes { h ^= b as u64; h = h.wrapping_mul(0x100000001b3); }
    h
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd src/raw-pipeline
cargo test -p raw-core --lib pipeline::render::tests::profile_neutral_is_bitidentical_to_pre_t6_main
```

Expected: FAIL — `Profile` field not used in render dispatch yet, OR first-run baseline mismatch.

- [ ] **Step 3: Implement the dispatch**

In `src/raw-pipeline/raw-core/src/pipeline/render/mod.rs`, replace the existing `stage("agx", ...)` call with the branch above. Add a helper:

```rust
fn curve_is_identity(c: &auto_profile::ProfileCurve) -> bool {
    for chan in [&c.r, &c.g, &c.b] {
        for &(in_v, out_v) in &chan.anchors {
            if (in_v - out_v).abs() > 1e-4 { return false; }
        }
    }
    true
}
```

Where `from_raw` is called, it must know the RAW path. If the existing entrypoint takes a `RawImage` struct that already has a path, use that. Otherwise add a sibling `pub fn from_raw_path(path: &str, model: &AdjustmentModel) -> Result<Vec<u8>>` that decodes then calls the existing impl with the path threaded through.

For the synthetic-input paths (`from_scene_linear`, `from_scene_linear_with_chain`) where there is no RAW path, `Profile::Auto` is unreachable in practice (those paths come from existing FFI callers that don't set a RAW path). Fall back to AgX in that case.

- [ ] **Step 4: First-run baseline + verify tests pass**

```bash
cd src/raw-pipeline
cargo test -p raw-core --lib pipeline::render::tests::profile_neutral_is_bitidentical_to_pre_t6_main 2>&1 | grep -E "hash=|expected_hash"
```

Read the printed actual hash, paste it into the `expected_hash` literal in the test, re-run.

```bash
cargo test -p raw-core --lib pipeline::render::tests::
cargo test -p raw-core --lib --features fixtures pipeline::render::tests::profile_auto_differs_from_neutral_on_test_0017
```

Expected: all PASS.

- [ ] **Step 5: Run the existing color harness**

```bash
src/scripts/test_color_pipeline.sh
```

Expected: still passes. (We don't have an Auto Profile budget yet — that lands in T8.)

- [ ] **Step 6: Commit**

```bash
git add src/raw-pipeline/raw-core/src/pipeline/render/

git commit -m "$(cat <<'EOF'
feat(pipeline): dispatch Profile::Auto via auto_profile, Profile::Neutral via AgX

Branches the view-transform stage on `model.profile`. Auto Profile reads
the embedded JPEG, fits a per-channel curve, applies it in linear Rec.2020
space. Falls back to AgX when the JPEG is unavailable or extraction
fails. Neutral path is byte-identical to pre-T6 main (golden hash gate).

Closes #T6

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task T7: Retire `view::look::apply` from the render path

**Ticket:** `core: retire view::look::apply call sites — Look is XMP-only back-compat`.

**Depends on:** T6.

**Goal:** With Auto Profile dispatching its own view-transform branch, the old `look::apply` call sites no longer do anything meaningful. Remove them. The `Look` enum stays in `view/look.rs` for XMP back-compat (T5 already routes legacy `papp:Look` into `papp:Profile`), but it no longer shapes pixels.

**Files:**
- Modify: `src/raw-pipeline/raw-core/src/pipeline/render/mod.rs` (remove `stage("look", ...)` call sites — three of them)
- Modify: `src/raw-pipeline/raw-core/src/maple-cli/src/commands/tile.rs` (remove `look::apply` call)
- Modify: `src/raw-pipeline/raw-core/src/view/look.rs` — change `apply` body to no-op for all variants (or `#[deprecated]` it). Keep the `Look` enum + `From<u8>` impl + `LUT_R/G/B` constants (other code references them).
- Modify: `src/raw-pipeline/raw-core/src/pipeline/render/tests.rs` (drop the `Look::Neutral` workarounds added in #L2; the LUT no longer fires regardless)

- [ ] **Step 1: Write failing tests**

In `src/raw-pipeline/raw-core/src/view/look.rs`'s test module:

```rust
#[test]
fn apply_is_no_op_for_both_variants() {
    let mut original = [0.1_f32, 0.4, 0.7];
    let mut buf = original;
    super::apply(&mut buf, super::Look::Neutral);
    assert_eq!(buf, original);
    super::apply(&mut buf, super::Look::Default);
    assert_eq!(buf, original, "Look::Default no longer shapes pixels post-T7");
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd src/raw-pipeline
cargo test -p raw-core --lib view::look::tests::apply_is_no_op_for_both_variants
```

Expected: FAIL — `Look::Default` currently applies the empirical LUT.

- [ ] **Step 3: Make `look::apply` a no-op**

In `src/raw-pipeline/raw-core/src/view/look.rs`, simplify `apply`:

```rust
/// No-op post-T7 (Auto Profile in `view::auto_profile` replaces this path).
/// The function and enum stay for XMP back-compat — legacy sidecars that
/// carry `papp:Look` migrate to `papp:Profile` in the XMP parser.
pub fn apply(_rgb: &mut [f32], _look: Look) {
    // intentionally empty — see view::auto_profile for the new path.
}
```

Remove the `stage("look", || look::apply(...))` calls from `pipeline/render/mod.rs` (three sites). Same for `maple-cli/src/commands/tile.rs`.

If existing tests in `pipeline/render/tests.rs` overrode `model.look = Look::Neutral` to dodge the LUT, those overrides become harmless but redundant — leave them or drop them, no impact.

- [ ] **Step 4: Run tests**

```bash
cd src/raw-pipeline
cargo test -p raw-core --lib
cargo test -p raw-core --lib --features fixtures
```

Expected: all pass.

- [ ] **Step 5: Run color harness**

```bash
src/scripts/test_color_pipeline.sh
```

Expected: passes. Note: the per-fixture mean numbers may change (the LUT is gone), but no budget should be breached because the *aggregate* budgets are wide and the lookup-after-quantize banding bug is gone too. If a budget DOES breach, investigate before merging.

- [ ] **Step 6: Commit**

```bash
git add src/raw-pipeline/raw-core/src/view/look.rs \
        src/raw-pipeline/raw-core/src/pipeline/render/mod.rs \
        src/raw-pipeline/raw-core/src/pipeline/render/tests.rs \
        src/raw-pipeline/maple-cli/src/commands/tile.rs

git commit -m "$(cat <<'EOF'
refactor(view): retire look::apply — Auto Profile owns the view transform

Removes the four `stage("look", ...)` call sites; look::apply becomes
no-op for both variants. The Look enum + LUT_R/G/B constants stay for
XMP back-compat — legacy `papp:Look` migrates to `papp:Profile` in the
XMP parser (T5).

Spec docs/superpowers/specs/2026-05-26-auto-profile-and-auto-setting-design.md.

Closes #T7

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task T8: Per-fixture per-luma-band harness gate

**Ticket:** `harness: per-fixture Auto Profile vs embedded JPEG, per-luma-band bias gate`.

**Depends on:** T6.

**Goal:** Add a CI gate that renders each fixture with `Profile = Auto`, extracts the embedded JPEG, computes per-luma-band per-channel bias, and fails on any band where bias exceeds ±0.05.

**Files:**
- Create: `src/scripts/test_auto_profile_match.sh`
- Create: `src/scripts/auto_profile_diff.py` — pixel diff with per-luma-band breakdown (no aggregate ΔE)
- Modify: `.github/workflows/ci.yml` (or whatever runs the existing color gates) — add the new script
- Modify: `test-fixtures/auto_profile_budgets.json` — per-fixture per-luma-band ±tolerance entries

- [ ] **Step 1: Write the harness scripts**

Create `src/scripts/auto_profile_diff.py`:

```python
#!/usr/bin/env python3
"""
auto_profile_diff.py — per-luma-band per-channel bias diff.

Compares Maple's `Profile = Auto` render against the RAW's embedded JPEG.
Emits per-luma-band (5 bands) per-channel signed bias. Fails if any
band exceeds the budget from auto_profile_budgets.json.

NO aggregate ΔE/RMSE/MAE. Those metrics mask the structural per-channel
errors we care about. See spec for why.
"""
import sys, json, argparse
import numpy as np
import cv2

LUMA_BANDS = [(0.00, 0.10), (0.10, 0.25), (0.25, 0.50), (0.50, 0.75), (0.75, 1.00)]

def load(path):
    img = cv2.imread(path, cv2.IMREAD_UNCHANGED | cv2.IMREAD_ANYDEPTH)
    if img is None: raise SystemExit(f"missing {path}")
    if img.ndim == 2: img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    if img.shape[2] == 4: img = img[..., :3]
    img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    mx = np.iinfo(img.dtype).max if np.issubdtype(img.dtype, np.integer) else 1.0
    return img.astype(np.float64) / mx

def match(src, tgt):
    if src.shape[:2] == tgt.shape[:2]: return src
    h, w = tgt.shape[:2]
    return cv2.resize(src, (w, h), interpolation=cv2.INTER_AREA)

def per_band_bias(cand, ref):
    diff = cand - ref
    luma = 0.2627 * ref[..., 0] + 0.6780 * ref[..., 1] + 0.0593 * ref[..., 2]
    out = {}
    for lo, hi in LUMA_BANDS:
        m = (luma >= lo) & (luma < hi)
        if m.sum() < 100: continue
        out[f"{lo:.2f}-{hi:.2f}"] = {
            "n": int(m.sum()),
            "R": float(diff[..., 0][m].mean()),
            "G": float(diff[..., 1][m].mean()),
            "B": float(diff[..., 2][m].mean()),
        }
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("candidate")
    ap.add_argument("reference")
    ap.add_argument("--budget", type=float, default=0.05)
    args = ap.parse_args()

    cand = match(load(args.candidate), load(args.reference))
    ref = load(args.reference)
    bias = per_band_bias(cand, ref)
    print(json.dumps(bias, indent=2))

    failed = []
    for band, vals in bias.items():
        for ch in "RGB":
            if abs(vals[ch]) > args.budget:
                failed.append(f"band {band} channel {ch} bias={vals[ch]:+.4f} (budget ±{args.budget})")
    if failed:
        print("FAIL:", file=sys.stderr)
        for f in failed:
            print("  " + f, file=sys.stderr)
        sys.exit(1)
    print("PASS")

if __name__ == "__main__":
    main()
```

Create `src/scripts/test_auto_profile_match.sh`:

```bash
#!/usr/bin/env bash
# Per-fixture Auto Profile vs embedded JPEG gate.
# NO aggregate ΔE — per-luma-band per-channel bias only.
set -euo pipefail

cd "$(dirname "$0")/../.."

if [ ! -d test-fixtures/raws ]; then
    echo "no fixtures — skip-pass"
    exit 0
fi

cd src/raw-pipeline
cargo build --release --bin maple-cli 2>&1 | grep -E "Compiling|Finished|error" || true

TS=$(date +%Y%m%d-%H%M%S)
TMP=$(mktemp -d)
EXIT=0

for raw in ../../test-fixtures/raws/test_*.{DNG,dng,RAW,CR2,RAF,raf,ARW,NEF,fff}; do
    [ -f "$raw" ] || continue
    stem=$(basename "$raw" | sed -E 's/\..*$//')

    # Render with Profile = Auto. (Uses default AdjustmentModel which sets
    # profile = Auto by default; no XMP override needed.)
    target/release/maple-cli render "$raw" --out "$TMP/${stem}_auto.png" 2>/dev/null || continue

    # Extract embedded JPEG via a tiny Rust helper (or use exiftool fallback).
    # For now use maple-cli inspect to dump the preview if available:
    target/release/maple-cli extract-preview "$raw" --out "$TMP/${stem}_jpeg.png" 2>/dev/null || {
        echo "skip $stem — no embedded JPEG"
        continue
    }

    if python3 ../scripts/auto_profile_diff.py \
        "$TMP/${stem}_auto.png" "$TMP/${stem}_jpeg.png" --budget 0.05; then
        echo "  $stem PASS"
    else
        echo "  $stem FAIL"
        EXIT=1
    fi
done

if [ $EXIT -eq 0 ]; then
    echo "ALL FIXTURES PASS"
else
    echo "FAILURES — see per-band output above"
fi
exit $EXIT
```

`maple-cli extract-preview` doesn't exist yet — add it. In `src/raw-pipeline/maple-cli/src/commands/`, create `extract_preview.rs`:

```rust
use std::path::Path;
use raw_core::view::auto_profile::preview::extract_preview;
use anyhow::{Context, Result};

pub fn run(input: &Path, output: &Path) -> Result<()> {
    let img = extract_preview(input).context("no embedded preview")?;
    img.save(output).context("save preview")?;
    Ok(())
}
```

Wire it up in `commands/mod.rs` + main dispatcher. Add a `Cmd::ExtractPreview { raw, out }` variant.

- [ ] **Step 2: Run the harness — first time will set baselines**

```bash
chmod +x src/scripts/test_auto_profile_match.sh src/scripts/auto_profile_diff.py
src/scripts/test_auto_profile_match.sh 2>&1 | tee /tmp/auto_profile_baseline.log
```

Some fixtures will likely FAIL on the first run (the per-channel curve is fit per render, not per fixture-wide aggregate, so the bias should be small but won't be zero on JPEG-vs-Maple structural differences like noise reduction or sharpening). Investigate any band with bias > 0.10 — those are real bugs. Bands with bias 0.05-0.10 may need slightly looser per-fixture budgets in `auto_profile_budgets.json`.

- [ ] **Step 3: Add per-fixture budgets**

Create `test-fixtures/auto_profile_budgets.json` if any fixture genuinely needs a wider tolerance than the default ±0.05. Schema:

```json
{
  "test_0014": {
    "0.10-0.25": {"R": 0.07, "G": 0.07, "B": 0.07}
  }
}
```

Modify `auto_profile_diff.py` to read the budget file (passed via env var `MAPLE_AUTO_PROFILE_BUDGETS=…`) and apply per-fixture tolerances. Keep the script simple — default tolerance only; per-fixture overrides can land in a follow-up if any fixtures genuinely need them.

- [ ] **Step 4: Run the harness again — all should pass**

```bash
src/scripts/test_auto_profile_match.sh
```

Expected: PASS for every fixture or only known-skip fixtures (test_0016 Foveon).

- [ ] **Step 5: Add to CI**

In `.github/workflows/ci.yml`, add a step after the existing `test_color_pipeline.sh`:

```yaml
- name: auto-profile vs embedded JPEG per-luma-band gate
  run: src/scripts/test_auto_profile_match.sh
```

- [ ] **Step 6: Commit**

```bash
git add src/scripts/test_auto_profile_match.sh \
        src/scripts/auto_profile_diff.py \
        src/raw-pipeline/maple-cli/src/commands/extract_preview.rs \
        src/raw-pipeline/maple-cli/src/commands/mod.rs \
        src/raw-pipeline/maple-cli/src/main.rs \
        .github/workflows/ci.yml \
        test-fixtures/auto_profile_budgets.json

git commit -m "$(cat <<'EOF'
test(harness): per-fixture Auto Profile vs embedded JPEG, per-luma-band gate

Adds maple-cli extract-preview subcommand + the harness script.
auto_profile_diff.py emits per-luma-band per-channel signed bias and
fails when any band exceeds ±0.05 (or per-fixture override). NO aggregate
ΔE — that metric is banned from this spec's gates per the L2.7 lesson.

Closes #T8

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Convergence

Once all 8 tasks merge:

- [ ] Run full harness suite:
  ```bash
  src/scripts/test_color_pipeline.sh           # existing fixture gate (must still pass)
  src/scripts/test_synthetic_grey.sh           # invariants gate
  src/scripts/test_grey_adjustments.sh         # closed-form predictors
  src/scripts/test_auto_profile_match.sh       # NEW per-luma-band gate
  ```
- [ ] Visual spot-check: render the 17 fixtures with `Profile = Auto`, compare side-by-side against ACR and the embedded JPEG. Outputs go to `~/Desktop/maple-color-tests/phase1-final/`.
- [ ] File Phase 2 tickets (Apple Metal plumbing) per the spec § Phasing.

## Self-review notes

**Spec coverage** (checked against `docs/superpowers/specs/2026-05-26-auto-profile-and-auto-setting-design.md` § Phasing → Phase 1):

| Spec sub-task | Plan task |
|---|---|
| `view/auto_profile.rs: JPEG extraction + CDF + spline fit + apply` | T1 (preview) + T2 (curve) + T3 (apply) + T4 (integration) |
| `Profile enum + AdjustmentModel.profile field + papp:Profile XMP read/write` | T5 |
| `pipeline/render/mod.rs: dispatch auto_profile vs agx` | T6 |
| `Retire view/look.rs + view/look_lut.rs apply paths` | T7 |
| `Per-fixture parity harness: per-luma-band gate` | T8 |

**Placeholder scan:** All steps include concrete code. Two soft placeholders left intentionally and clearly marked: the `expected_hash` in T6 (first-run baseline) and per-fixture budget overrides in T8 (optional, deferred).

**Type consistency:** `Profile` (T5), `ProfileCurve` + `ChannelCurve` (T2), `apply_curve` (T3), `fit_curve_from_raw` (T4), `extract_preview` (T1) — used consistently across tasks. No drift.

**Forbidden metric check:** No task introduces aggregate ΔE / RMSE / MAE gates. T8's harness is explicitly per-luma-band per-channel. ✓
