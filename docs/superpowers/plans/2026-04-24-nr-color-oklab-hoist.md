# nr_color Oklab Matrix Hoist + Rayon Parallelization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Related ticket:** [tickets/05-optimize-nr-color-chroma-blur.md](../../tickets/05-optimize-nr-color-chroma-blur.md) — this plan is the first pass at that ticket's primary direction. The Y'CbCr chroma-decorrelation fallback and the slice-5-shim → NLM replacement are both out of scope here (separate plans if needed).

**Goal:** Cut `nr_color` from 19.32 s to ~1.5 s on the reference 100 MP fixture by (1) hoisting the three per-pixel `Matrix3::inverse()` calls inside `oklab_to_rec2020` to `std::sync::OnceLock` constants, and (2) parallelizing the three per-pixel loops in `apply_color` / `apply_luminance` and the horizontal + vertical sweeps in `box_blur_channel` with `rayon`.

**Architecture:**
- The hoist is a **zero-math-change perf fix**: the hoisted matrices are bitwise-identical to what `Matrix3::inverse()` currently produces on every pixel, because the underlying constants (`M1_SRGB_TO_LMS`, `M2_LMS_TO_LAB`, `M_REC2020_TO_SRGB`) are `const` and deterministic at compile time. Output is not just within parity budget — it is bit-for-bit identical. The parity harness run at `BUDGET=15` exists as a belt-and-suspenders check, not as the authoritative gate.
- Rayon is already a workspace dependency and already used elsewhere in `raw-core` (`view/encode.rs`, `demosaic/half_res.rs`, `linearize.rs`, `color/dcp.rs`, etc.) — this plan adds it to two more files following the same patterns.
- The box-blur vertical sweep is column-major writes into a row-major buffer, which prevents a trivial `par_iter` over outer columns. The plan rewrites the vertical sweep to write into a column-major scratch buffer, parallelize by column, then transpose back — a well-understood pattern that preserves output exactly.
- Every task ends with both `cargo test -p raw-core --lib` (unit tests) and, for math-touching changes, `BUDGET=15 src/scripts/test_color_pipeline.sh` (perceptual gate).
- The final task re-runs `MAPLE_PROFILE=1 maple-cli batch …` on the reference fixture and embeds the post-optimization `[raw-core] nr_color` line in the commit body, so future profiling has a clear before/after delta.

**Tech Stack:** Rust 1.83+ (`std::sync::OnceLock`), `rayon` 1.x (already pinned in `src/raw-pipeline/Cargo.toml` workspace deps), existing `maple-cli` + `MAPLE_PROFILE` instrumentation from commit `ed96688`, existing `src/scripts/test_color_pipeline.sh` + `compare_images.py` parity harness.

**Verified findings (each maps to a task):**

1. **`oklab_to_rec2020` recomputes three `Matrix3::inverse()` results per pixel.** Confirmed at [`src/raw-pipeline/raw-core/src/color/oklab.rs:40`](../../src/raw-pipeline/raw-core/src/color/oklab.rs:40), [`:48`](../../src/raw-pipeline/raw-core/src/color/oklab.rs:48), [`:50`](../../src/raw-pipeline/raw-core/src/color/oklab.rs:50). All three operate on `const` matrices (`M2_LMS_TO_LAB`, `M1_SRGB_TO_LMS`, `M_REC2020_TO_SRGB`) — the results are invariant. At ~100 ns per inverse × 3 inverses × 25 Mpx (half-res of 100 MP) → ~7.5 s just on the inverses. Combined with the symmetric forward path (`rec2020_to_oklab`, which doesn't call `inverse()` but still does two matrix mults + three `cbrt` per pixel) and the blur overhead, this closes the ~19 s budget the profile exposes.

2. **`rec2020_to_oklab` at [`color/oklab.rs:29`](../../src/raw-pipeline/raw-core/src/color/oklab.rs:29) does NOT call `Matrix3::inverse()`.** It uses the forward `M_REC2020_TO_SRGB` and `M1_SRGB_TO_LMS` const matrices directly. Task 1's hoist applies only to `oklab_to_rec2020`. The spec's "apply the same hoisting pattern to `rec2020_to_oklab` if it has the same issue (check)" resolves to a no-op — recorded for traceability in Task 1 Step 5.

3. **The three per-pixel loops in `apply_color` at [`stages/noise_reduction.rs:47-62`](../../src/raw-pipeline/raw-core/src/stages/noise_reduction.rs:47) are strictly serial.** Each iterates over `img.pixels` / `oklab_img.pixels` independently; no cross-pixel dependency. Equivalent loops exist in `apply_luminance` at [`noise_reduction.rs:22-37`](../../src/raw-pipeline/raw-core/src/stages/noise_reduction.rs:22) — the plan parallelizes both since the spec calls out the `apply_color` loops explicitly and hitting `apply_luminance` is a trivial drop-in.

4. **`box_blur_channel` at [`stages/blur.rs:12`](../../src/raw-pipeline/raw-core/src/stages/blur.rs:12) has two independent sweeps.** The horizontal sweep ([`blur.rs:17`](../../src/raw-pipeline/raw-core/src/stages/blur.rs:17)) is trivially row-parallel because each row writes a contiguous `w`-element slice of `tmp`. The vertical sweep ([`blur.rs:33`](../../src/raw-pipeline/raw-core/src/stages/blur.rs:33)) is column-parallel but writes back into a row-major `out` buffer via stride-`w` scatter, which prevents a clean `par_iter_mut()` over output rows. The plan uses a column-major scratch buffer for the vertical pass, parallelizes by column, then transposes back.

5. **Workspace rayon is already present** at `src/raw-pipeline/Cargo.toml:20` and `raw-core` already depends on it (`raw-core/Cargo.toml:15`). No Cargo changes needed.

6. **`std::sync::OnceLock` is already in use in `raw-core`** — `view/agx.rs:35` uses `static CELL: std::sync::OnceLock<[f32; AGX_LUT_SIZE]>`. The same pattern drops into `color/oklab.rs`.

**Out of scope (explicit):**
- The Y'CbCr chroma-decorrelation + plane-only blur fallback (ticket 05's secondary direction). Separate plan if this plan's result is still above the 50 ms target.
- Replacing the slice-5 shim at [`noise_reduction.rs:1-4`](../../src/raw-pipeline/raw-core/src/stages/noise_reduction.rs:1) with a full NLM implementation. Separate plan.
- Anything outside `src/raw-pipeline/raw-core/src/color/oklab.rs`, `src/raw-pipeline/raw-core/src/stages/noise_reduction.rs`, and `src/raw-pipeline/raw-core/src/stages/blur.rs`.
- Tightening the radius scale at [`noise_reduction.rs:44`](../../src/raw-pipeline/raw-core/src/stages/noise_reduction.rs:44) — ticket 05 flags it but it's algorithmic, not a hoist/parallel fix.
- SIMD (`std::simd` / `wide`). Ticket 05's follow-up direction.

---

## File Structure

**Rust (read-write):**
- Modify: `src/raw-pipeline/raw-core/src/color/oklab.rs` — hoist three `Matrix3::inverse()` calls in `oklab_to_rec2020` to a module-level `OnceLock<(Matrix3, Matrix3, Matrix3)>`.
- Modify: `src/raw-pipeline/raw-core/src/stages/noise_reduction.rs` — convert the three serial per-pixel loops in `apply_color` (and the equivalent three in `apply_luminance`) to rayon `par_iter`/`par_iter_mut`.
- Modify: `src/raw-pipeline/raw-core/src/stages/blur.rs` — parallelize `box_blur_channel`'s horizontal sweep (trivial row-parallel) and vertical sweep (column-parallel via column-major scratch + transpose).

**Rust (read-only during verification):**
- `src/raw-pipeline/raw-core/src/math.rs` — `Matrix3::inverse()` definition (pure function, no mutation).
- `src/raw-pipeline/raw-core/src/color/matrices.rs` — `M_REC2020_TO_SRGB` const source.
- `src/raw-pipeline/raw-core/src/pipeline.rs` — `stage("nr_color", …)` call site, unchanged.

---

## Task 1: Hoist `oklab_to_rec2020` matrix inverses to a `OnceLock` cache

**Files:**
- Modify: `src/raw-pipeline/raw-core/src/color/oklab.rs`

**Why this matters:** Each call to `oklab_to_rec2020` currently invokes `Matrix3::inverse()` three times (at lines 40, 48, 50). Every inverse is a 9-determinant-cofactor computation (~100 ns in release) on a `const` matrix — the result never changes. At 25 Mpx × 3 inverses × 2 calls (one per Rec.2020 ↔ Oklab round-trip for color-NR + luminance-NR) that's 150 million redundant inverses per cold open. Hoisting to a `OnceLock` eliminates all of them after the first call.

**Parity risk:** zero. The hoisted matrices are bit-for-bit identical to whatever `Matrix3::inverse()` returns on the same inputs (the function is pure, the inputs are `const`). This is the safest optimization in this plan.

- [ ] **Step 1: Re-read `oklab.rs` to confirm the three inverse sites and current structure.**

Read `src/raw-pipeline/raw-core/src/color/oklab.rs` end-to-end. Confirm:
- `M1_SRGB_TO_LMS` is `const` at line 14.
- `M2_LMS_TO_LAB` is `const` at line 21.
- `M_REC2020_TO_SRGB` is imported at line 9 and is `const` in `color/matrices.rs:53` (verified).
- `rec2020_to_oklab` at line 29-36 uses `M_REC2020_TO_SRGB.mul_vec` and `M1_SRGB_TO_LMS.mul_vec` directly — **no inverses** (so the spec's "check `rec2020_to_oklab`" resolves to: nothing to do).
- `oklab_to_rec2020` at line 39-52 calls `.inverse().expect(...)` at lines 40, 48, 50.
- There are 5 existing unit tests in `mod tests`: `round_trip_preserves_neutral_gray`, `round_trip_preserves_saturated_red`, `round_trip_preserves_scene_headroom_values`, `neutral_gray_has_zero_ab`, `negative_inputs_do_not_produce_nan`.

- [ ] **Step 2: Write a failing test that asserts the hoisted inverses are bit-identical to `Matrix3::inverse()`.**

Add this test inside the existing `mod tests { … }` block in `src/raw-pipeline/raw-core/src/color/oklab.rs`, at the bottom (before the closing `}`):

```rust
    /// Lock down the matrix-inverse hoist: the cached inverses returned by
    /// `oklab_inverse_matrices()` must be bit-for-bit identical to what
    /// `Matrix3::inverse()` produces on the same const inputs. This is the
    /// only thing that guarantees the perf change is zero-parity-risk.
    #[test]
    fn cached_inverses_match_matrix3_inverse_bit_exact() {
        let (m2_inv, m1_inv, m_srgb_to_rec2020) = oklab_inverse_matrices();
        assert_eq!(*m2_inv, M2_LMS_TO_LAB.inverse().expect("M2 invertible"),
            "cached M2⁻¹ drifted from Matrix3::inverse(M2)");
        assert_eq!(*m1_inv, M1_SRGB_TO_LMS.inverse().expect("M1 invertible"),
            "cached M1⁻¹ drifted from Matrix3::inverse(M1)");
        assert_eq!(*m_srgb_to_rec2020, M_REC2020_TO_SRGB.inverse().expect("M_REC2020_TO_SRGB invertible"),
            "cached M_REC2020_TO_SRGB⁻¹ drifted from Matrix3::inverse(…)");
    }
```

- [ ] **Step 3: Run the new test to verify it fails (the helper does not exist yet).**

Run: `cd src/raw-pipeline && cargo test -p raw-core --lib color::oklab::tests::cached_inverses_match_matrix3_inverse_bit_exact 2>&1 | tail -10`
Expected: **compilation error** — `cannot find function 'oklab_inverse_matrices' in this scope`. That's the "fails" signal for TDD on a helper that doesn't exist yet.

- [ ] **Step 4: Add the `OnceLock`-backed helper and rewrite `oklab_to_rec2020` to use it.**

Open `src/raw-pipeline/raw-core/src/color/oklab.rs`.

Replace lines 27-52 (the `rec2020_to_oklab` + `oklab_to_rec2020` block):

```rust
/// Scene-linear Rec.2020 D65 → Oklab.
/// Per-pixel cost: two 3×3 matrix multiplies + three cube roots.
pub fn rec2020_to_oklab(rgb: Vec3) -> Vec3 {
    // Rec.2020 → sRGB → LMS.
    let srgb = M_REC2020_TO_SRGB.mul_vec(rgb);
    let lms = M1_SRGB_TO_LMS.mul_vec(srgb);
    // Cube root — preserves sign on negatives (cbrt of a negative is negative).
    let lms_cube = [lms[0].cbrt(), lms[1].cbrt(), lms[2].cbrt()];
    M2_LMS_TO_LAB.mul_vec(lms_cube)
}

/// Inverse of `rec2020_to_oklab`.
pub fn oklab_to_rec2020(lab: Vec3) -> Vec3 {
    let m2_inv = M2_LMS_TO_LAB.inverse().expect("M2 is invertible");
    let lms_cube = m2_inv.mul_vec(lab);
    // Cube (inverse of cbrt) — sign-preserving.
    let lms = [
        lms_cube[0] * lms_cube[0] * lms_cube[0],
        lms_cube[1] * lms_cube[1] * lms_cube[1],
        lms_cube[2] * lms_cube[2] * lms_cube[2],
    ];
    let m1_inv = M1_SRGB_TO_LMS.inverse().expect("M1 is invertible");
    let srgb = m1_inv.mul_vec(lms);
    let m_srgb_to_rec2020 = M_REC2020_TO_SRGB.inverse().expect("M_REC2020_TO_SRGB is invertible");
    m_srgb_to_rec2020.mul_vec(srgb)
}
```

with:

```rust
/// Cached inverses of the three forward matrices. Each inverse is a pure
/// function of `const` data, so computing it once at first call and
/// handing out references after is bit-for-bit identical to calling
/// `Matrix3::inverse()` at every pixel — just 25 Mpx × 3 = 75 million
/// times faster on a 100 MP half-res render.
///
/// Tuple order matches the order they're consumed inside
/// `oklab_to_rec2020`: (M2⁻¹, M1⁻¹, M_REC2020_TO_SRGB⁻¹).
fn oklab_inverse_matrices() -> &'static (Matrix3, Matrix3, Matrix3) {
    static CELL: std::sync::OnceLock<(Matrix3, Matrix3, Matrix3)> = std::sync::OnceLock::new();
    CELL.get_or_init(|| {
        (
            M2_LMS_TO_LAB.inverse().expect("M2 is invertible"),
            M1_SRGB_TO_LMS.inverse().expect("M1 is invertible"),
            M_REC2020_TO_SRGB.inverse().expect("M_REC2020_TO_SRGB is invertible"),
        )
    })
}

/// Scene-linear Rec.2020 D65 → Oklab.
/// Per-pixel cost: two 3×3 matrix multiplies + three cube roots.
/// This direction uses only forward (const) matrices — no inverse hoist
/// needed here; the reverse direction does the heavy lifting.
pub fn rec2020_to_oklab(rgb: Vec3) -> Vec3 {
    // Rec.2020 → sRGB → LMS.
    let srgb = M_REC2020_TO_SRGB.mul_vec(rgb);
    let lms = M1_SRGB_TO_LMS.mul_vec(srgb);
    // Cube root — preserves sign on negatives (cbrt of a negative is negative).
    let lms_cube = [lms[0].cbrt(), lms[1].cbrt(), lms[2].cbrt()];
    M2_LMS_TO_LAB.mul_vec(lms_cube)
}

/// Inverse of `rec2020_to_oklab`. Per-pixel cost: three 3×3 matrix
/// multiplies + three cubes. Inverse matrices are cached in a module-level
/// `OnceLock` — calling `Matrix3::inverse()` per pixel (as the previous
/// implementation did) was ~7.5 s on a 25 Mpx half-res image.
pub fn oklab_to_rec2020(lab: Vec3) -> Vec3 {
    let (m2_inv, m1_inv, m_srgb_to_rec2020) = oklab_inverse_matrices();
    let lms_cube = m2_inv.mul_vec(lab);
    // Cube (inverse of cbrt) — sign-preserving.
    let lms = [
        lms_cube[0] * lms_cube[0] * lms_cube[0],
        lms_cube[1] * lms_cube[1] * lms_cube[1],
        lms_cube[2] * lms_cube[2] * lms_cube[2],
    ];
    let srgb = m1_inv.mul_vec(lms);
    m_srgb_to_rec2020.mul_vec(srgb)
}
```

- [ ] **Step 5: Run the new test to verify it passes.**

Run: `cd src/raw-pipeline && cargo test -p raw-core --lib color::oklab::tests::cached_inverses_match_matrix3_inverse_bit_exact 2>&1 | tail -10`
Expected: **PASS**.

- [ ] **Step 6: Run the full `oklab.rs` test module to confirm no regression.**

Run: `cd src/raw-pipeline && cargo test -p raw-core --lib color::oklab 2>&1 | tail -15`
Expected: 6 tests pass (5 pre-existing + 1 new). The 5 round-trip tests are the real parity gate at the pixel level — they were passing before, must pass after, bit-identical behavior.

- [ ] **Step 7: Run the full `raw-core` lib test suite to catch any wider fallout.**

Run: `cd src/raw-pipeline && cargo test -p raw-core --lib 2>&1 | tail -5`
Expected: all ~94 tests pass.

- [ ] **Step 8: Run the color parity harness as a belt-and-suspenders check.**

Run: `BUDGET=15 src/scripts/test_color_pipeline.sh 2>&1 | tail -15`
Expected: PASS with mean ΔE within 15. Because the hoist is bit-identical, ΔE should match whatever the previous run produced — any drift here would indicate an implementation bug in the hoist (not a tolerance-level issue). If the harness exits non-zero, **do not commit** — re-read Step 4's replacement and diff the tuple ordering against the original sequence at lines 40, 48, 50.

- [ ] **Step 9: Commit.**

```bash
git add src/raw-pipeline/raw-core/src/color/oklab.rs
git commit -m "$(cat <<'EOF'
perf(raw-core): hoist oklab_to_rec2020 matrix inverses to OnceLock cache

Each call to `oklab_to_rec2020` was recomputing `Matrix3::inverse()` on
three `const` matrices per pixel — ~100 ns × 3 × 25 Mpx ≈ 7.5 s per
half-res render on a 100 MP RAW. The inverses are pure functions of
compile-time constants, so a module-level `std::sync::OnceLock` caches
them after the first call and hands out references thereafter. Output
is bit-for-bit identical; a new unit test asserts this invariant against
`Matrix3::inverse()` directly. `rec2020_to_oklab` uses only forward
matrices and was already optimal — no change there.

Ticket: docs/tickets/05-optimize-nr-color-chroma-blur.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Parallelize the per-pixel loops in `apply_color` and `apply_luminance`

**Files:**
- Modify: `src/raw-pipeline/raw-core/src/stages/noise_reduction.rs`

**Why this matters:** Even with Task 1's hoist, the six per-pixel loops in `noise_reduction.rs` (three in `apply_color`, three in `apply_luminance`) are strictly serial. Each is a straight map from one pixel buffer to another with zero cross-pixel dependency — textbook `par_iter`. On an 8-P-core M-series chip we should see roughly linear scaling, so these loops drop by ~6-8× once rayon takes over.

**Parity risk:** rayon's `par_iter` is deterministic for `map` / `for_each` over independent elements — output order matches input order. No math change.

- [ ] **Step 1: Re-read `noise_reduction.rs` to confirm the six target loops.**

Read `src/raw-pipeline/raw-core/src/stages/noise_reduction.rs`. Confirm:
- `apply_luminance` loops at lines 22-24 (forward Oklab), 28-30 (L-replicate), 32-34 (writeback), 35-37 (final Oklab → Rec.2020).
- `apply_color` loops at lines 48-50 (forward Oklab), 53-55 (chroma extract), 57-60 (writeback), 61-63 (final Oklab → Rec.2020).
- The existing unit tests (`zero_luminance_is_identity`, `zero_color_is_identity`, `luminance_smooths_without_killing_color`, `preserves_scene_headroom`) do not exercise parallelism directly but will fail if `par_iter` re-orders results.

- [ ] **Step 2: Add a rayon import and convert all six loops to parallel iterators.**

Open `src/raw-pipeline/raw-core/src/stages/noise_reduction.rs`. At the top of the file, extend the `use` block:

```rust
use crate::{
    color::oklab::{oklab_to_rec2020, rec2020_to_oklab},
    image::{ColorSpace, Image},
    stages::blur::gaussian_blur_rgb,
};
```

to:

```rust
use crate::{
    color::oklab::{oklab_to_rec2020, rec2020_to_oklab},
    image::{ColorSpace, Image},
    stages::blur::gaussian_blur_rgb,
};
use rayon::prelude::*;
```

Replace the body of `apply_luminance` (lines 13-38, from `pub fn apply_luminance` through the closing `}`):

```rust
/// Apply luminance NR: blur L in Oklab, leave chroma.
pub fn apply_luminance(img: &mut Image, amount: f32) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    if amount.abs() < 1e-3 { return; }
    // Blur radius scales with amount [0..100] → radius [0..2].
    let radius = ((amount / 100.0) * 2.0).ceil() as usize;
    let radius = radius.max(1);

    // Convert whole image to Oklab (L, a, b) stored per-pixel.
    let mut oklab_img = Image::new(img.width, img.height, ColorSpace::SceneLinearRec2020);
    for (i, p) in img.pixels.iter().enumerate() {
        oklab_img.pixels[i] = rec2020_to_oklab(*p);
    }
    // Blur only L (channel 0). Replicate L into a 3-channel image,
    // blur, and pick channel 0 back out.
    let mut l_only = Image::new(img.width, img.height, ColorSpace::SceneLinearRec2020);
    for (i, p) in oklab_img.pixels.iter().enumerate() {
        l_only.pixels[i] = [p[0], p[0], p[0]];
    }
    let blurred_l = gaussian_blur_rgb(&l_only, radius);
    for i in 0..oklab_img.pixels.len() {
        oklab_img.pixels[i][0] = blurred_l.pixels[i][0];
    }
    for (i, p) in oklab_img.pixels.iter().enumerate() {
        img.pixels[i] = oklab_to_rec2020(*p);
    }
}
```

with:

```rust
/// Apply luminance NR: blur L in Oklab, leave chroma.
///
/// The three per-pixel maps (Rec.2020 → Oklab, L-replicate, Oklab →
/// Rec.2020) are fully independent across pixels and run through rayon's
/// `par_iter`. The L-writeback (blurred L → oklab_img[0]) is the one
/// exception: it mutates `oklab_img` while reading `blurred_l`, so it
/// uses `par_iter_mut().zip(...).for_each(...)` — still pixel-local.
pub fn apply_luminance(img: &mut Image, amount: f32) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    if amount.abs() < 1e-3 { return; }
    // Blur radius scales with amount [0..100] → radius [0..2].
    let radius = ((amount / 100.0) * 2.0).ceil() as usize;
    let radius = radius.max(1);

    // Convert whole image to Oklab (L, a, b) stored per-pixel.
    let mut oklab_img = Image::new(img.width, img.height, ColorSpace::SceneLinearRec2020);
    oklab_img
        .pixels
        .par_iter_mut()
        .zip(img.pixels.par_iter())
        .for_each(|(dst, src)| *dst = rec2020_to_oklab(*src));

    // Blur only L (channel 0). Replicate L into a 3-channel image,
    // blur, and pick channel 0 back out.
    let mut l_only = Image::new(img.width, img.height, ColorSpace::SceneLinearRec2020);
    l_only
        .pixels
        .par_iter_mut()
        .zip(oklab_img.pixels.par_iter())
        .for_each(|(dst, src)| *dst = [src[0], src[0], src[0]]);

    let blurred_l = gaussian_blur_rgb(&l_only, radius);
    oklab_img
        .pixels
        .par_iter_mut()
        .zip(blurred_l.pixels.par_iter())
        .for_each(|(dst, src)| dst[0] = src[0]);

    img.pixels
        .par_iter_mut()
        .zip(oklab_img.pixels.par_iter())
        .for_each(|(dst, src)| *dst = oklab_to_rec2020(*src));
}
```

Replace the body of `apply_color` (lines 40-64, from `pub fn apply_color` through the closing `}`):

```rust
/// Apply color NR: blur a and b in Oklab, leave luminance.
pub fn apply_color(img: &mut Image, amount: f32) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    if amount.abs() < 1e-3 { return; }
    let radius = ((amount / 100.0) * 4.0).ceil() as usize;
    let radius = radius.max(1);

    let mut oklab_img = Image::new(img.width, img.height, ColorSpace::SceneLinearRec2020);
    for (i, p) in img.pixels.iter().enumerate() {
        oklab_img.pixels[i] = rec2020_to_oklab(*p);
    }
    // Blur (a, b) via a 3-channel image: put a in R, b in G, 0 in B.
    let mut chroma_only = Image::new(img.width, img.height, ColorSpace::SceneLinearRec2020);
    for (i, p) in oklab_img.pixels.iter().enumerate() {
        chroma_only.pixels[i] = [p[1], p[2], 0.0];
    }
    let blurred = gaussian_blur_rgb(&chroma_only, radius);
    for i in 0..oklab_img.pixels.len() {
        oklab_img.pixels[i][1] = blurred.pixels[i][0];
        oklab_img.pixels[i][2] = blurred.pixels[i][1];
    }
    for (i, p) in oklab_img.pixels.iter().enumerate() {
        img.pixels[i] = oklab_to_rec2020(*p);
    }
}
```

with:

```rust
/// Apply color NR: blur a and b in Oklab, leave luminance.
///
/// Same parallelization shape as `apply_luminance`: four pixel-local maps
/// driven through `par_iter_mut().zip(par_iter()).for_each(...)`.
pub fn apply_color(img: &mut Image, amount: f32) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    if amount.abs() < 1e-3 { return; }
    let radius = ((amount / 100.0) * 4.0).ceil() as usize;
    let radius = radius.max(1);

    let mut oklab_img = Image::new(img.width, img.height, ColorSpace::SceneLinearRec2020);
    oklab_img
        .pixels
        .par_iter_mut()
        .zip(img.pixels.par_iter())
        .for_each(|(dst, src)| *dst = rec2020_to_oklab(*src));

    // Blur (a, b) via a 3-channel image: put a in R, b in G, 0 in B.
    let mut chroma_only = Image::new(img.width, img.height, ColorSpace::SceneLinearRec2020);
    chroma_only
        .pixels
        .par_iter_mut()
        .zip(oklab_img.pixels.par_iter())
        .for_each(|(dst, src)| *dst = [src[1], src[2], 0.0]);

    let blurred = gaussian_blur_rgb(&chroma_only, radius);
    oklab_img
        .pixels
        .par_iter_mut()
        .zip(blurred.pixels.par_iter())
        .for_each(|(dst, src)| {
            dst[1] = src[0];
            dst[2] = src[1];
        });

    img.pixels
        .par_iter_mut()
        .zip(oklab_img.pixels.par_iter())
        .for_each(|(dst, src)| *dst = oklab_to_rec2020(*src));
}
```

- [ ] **Step 3: Build the crate to confirm rayon compiles cleanly.**

Run: `cd src/raw-pipeline && cargo build -p raw-core 2>&1 | tail -10`
Expected: `Finished` with no warnings about unused imports or moved values.

- [ ] **Step 4: Run the `noise_reduction` module tests.**

Run: `cd src/raw-pipeline && cargo test -p raw-core --lib stages::noise_reduction 2>&1 | tail -15`
Expected: all 4 existing tests pass (`zero_luminance_is_identity`, `zero_color_is_identity`, `luminance_smooths_without_killing_color`, `preserves_scene_headroom`).

- [ ] **Step 5: Run the full raw-core lib suite.**

Run: `cd src/raw-pipeline && cargo test -p raw-core --lib 2>&1 | tail -5`
Expected: all passing.

- [ ] **Step 6: Run the color parity harness.**

Run: `BUDGET=15 src/scripts/test_color_pipeline.sh 2>&1 | tail -15`
Expected: PASS. ΔE should match Task 1's run because pixel-local `par_iter` maps produce the same values as serial iteration (rayon guarantees this for `for_each`/`map` patterns — thread count affects scheduling, not arithmetic).

- [ ] **Step 7: Commit.**

```bash
git add src/raw-pipeline/raw-core/src/stages/noise_reduction.rs
git commit -m "$(cat <<'EOF'
perf(raw-core): parallelize apply_color and apply_luminance per-pixel loops

The six per-pixel maps in noise_reduction.rs (Rec.2020 → Oklab, channel
replicate/extract, blur-writeback, Oklab → Rec.2020 — three each in
apply_color and apply_luminance) were strictly serial. Each is a
pixel-local map with no cross-pixel dependency — textbook rayon work.
Converts to `par_iter_mut().zip(par_iter()).for_each(...)` following
the same pattern already used in view/encode.rs and demosaic/half_res.rs.
Output bit-identical; existing unit tests + color parity harness both
pass.

Ticket: docs/tickets/05-optimize-nr-color-chroma-blur.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Parallelize `box_blur_channel` horizontal and vertical sweeps

**Files:**
- Modify: `src/raw-pipeline/raw-core/src/stages/blur.rs`

**Why this matters:** `box_blur_channel` runs 6 times per chroma-blur call (3 box passes × 2 axes) and each of those 6 calls runs serial over w×h pixels. The horizontal sweep at line 17 is trivially row-parallel — each row writes a disjoint slice of the output buffer. The vertical sweep at line 33 is column-parallel by algorithm but writes into a row-major buffer with stride-`w` scatter, preventing a direct `par_iter_mut` over output rows. The fix is to write the vertical sweep into a column-major scratch buffer (each column is contiguous; columns are disjoint → parallel writes are safe), then transpose back to row-major.

This task is **higher risk than Tasks 1 and 2** because the vertical sweep requires a structural rewrite. The existing unit tests (`blur_of_constant_is_constant`, `blur_smooths_a_delta`, `radius_zero_is_identity`) cover output correctness; add a new test that exercises an asymmetric input to catch accidental axis swaps during the transpose.

**Parity risk:** low-to-moderate. The math is unchanged — same box-blur accumulator, same boundary handling, same `r` min/max clamps. The only new code is a transpose, which is deterministic. The parity harness (run after this task) is the final check.

- [ ] **Step 1: Re-read `blur.rs` to confirm the sweep structure and existing tests.**

Read `src/raw-pipeline/raw-core/src/stages/blur.rs`. Confirm:
- `box_blur_channel` at lines 12-47. Horizontal sweep lines 17-30. Vertical sweep lines 33-45.
- `gaussian_blur_plane` at lines 54-64 calls `box_blur_channel` 3 times (line 61).
- `gaussian_blur_rgb` at lines 66-91 calls `box_blur_channel` 9 times (3 passes × 3 planes) at lines 81-83.
- Existing tests: `blur_of_constant_is_constant`, `blur_smooths_a_delta`, `radius_zero_is_identity` (all in `mod tests`).

- [ ] **Step 2: Write a failing test that exercises the vertical sweep with an asymmetric input.**

The existing tests use either a constant image (symmetric under any axis bug) or a single centred delta on a square (also symmetric). A w≠h input with a known response would catch an axis-swap bug introduced by the transpose. Add this test inside the existing `mod tests { ... }` block in `src/raw-pipeline/raw-core/src/stages/blur.rs`, at the bottom (before the closing `}`):

```rust
    #[test]
    fn blur_asymmetric_horizontal_stripe_preserves_axis() {
        // A single bright horizontal stripe on a wide-short image. After
        // a box blur, energy must spread *vertically* (because the stripe
        // is already uniform horizontally) and leave the horizontal
        // profile untouched within the row. An axis-swap in the vertical
        // sweep (e.g. reading column-major data as row-major during the
        // transpose) would shift energy into the wrong axis.
        let w = 40;
        let h = 10;
        let mut img = Image::new(w as u32, h as u32, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels { *p = [0.0; 3]; }
        // Stripe at row 5, all columns.
        for x in 0..w { img.pixels[5 * w + x] = [1.0, 0.0, 0.0]; }

        let blurred = gaussian_blur_rgb(&img, 3);

        // Every row in [0..h] has the same value at every column (the
        // stripe was uniform horizontally). Check this by picking two
        // arbitrary columns on row 4 and asserting they agree.
        for row in 0..h {
            let left  = blurred.pixels[row * w + 3][0];
            let right = blurred.pixels[row * w + (w - 3)][0];
            assert!((left - right).abs() < 1e-5,
                "row {}: left={}, right={} (horizontal profile should be uniform)",
                row, left, right);
        }

        // Row 5 (the stripe) must have the max response; rows 0 and h-1
        // must have less. This locks the vertical axis of the sweep.
        let stripe  = blurred.pixels[5 * w][0];
        let top_row = blurred.pixels[0 * w][0];
        let bot_row = blurred.pixels[(h - 1) * w][0];
        assert!(stripe > top_row, "stripe row not brightest: stripe={}, top={}", stripe, top_row);
        assert!(stripe > bot_row, "stripe row not brightest: stripe={}, bot={}", stripe, bot_row);
    }
```

- [ ] **Step 3: Run the new test to verify it passes against the current (serial) implementation.**

Run: `cd src/raw-pipeline && cargo test -p raw-core --lib stages::blur::tests::blur_asymmetric_horizontal_stripe_preserves_axis 2>&1 | tail -10`
Expected: **PASS** (we're locking down correct behavior *before* refactoring — this is the regression test). If it fails against the serial impl, that's a pre-existing bug and the plan stops here.

- [ ] **Step 4: Add rayon import and rewrite `box_blur_channel` to parallelize both sweeps.**

Open `src/raw-pipeline/raw-core/src/stages/blur.rs`. Replace the entire file body from the top `use` line through the end of `box_blur_channel` (lines 8-47).

Old:

```rust
use crate::image::{ColorSpace, Image};

/// Separable box blur of a single channel plane.
/// `buf` is row-major w×h. Returns a new blurred buffer.
fn box_blur_channel(buf: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    if r == 0 { return buf.to_vec(); }

    let mut tmp = vec![0.0f32; buf.len()];
    // Horizontal.
    for y in 0..h {
        let row = &buf[y * w..(y + 1) * w];
        let mut out_row = vec![0.0f32; w];
        let right0 = r.min(w - 1);
        let mut acc: f32 = row[0..=right0].iter().sum();
        let mut count = right0 + 1;
        out_row[0] = acc / count as f32;
        for x in 1..w {
            if x + r < w { acc += row[x + r]; count += 1; }
            if x > r     { acc -= row[x - r - 1]; count -= 1; }
            out_row[x] = acc / count as f32;
        }
        tmp[y * w..(y + 1) * w].copy_from_slice(&out_row);
    }
    // Vertical.
    let mut out = vec![0.0f32; buf.len()];
    for x in 0..w {
        let mut out_col = vec![0.0f32; h];
        let bot0 = r.min(h - 1);
        let mut acc: f32 = (0..=bot0).map(|i| tmp[i * w + x]).sum();
        let mut count = bot0 + 1;
        out_col[0] = acc / count as f32;
        for y in 1..h {
            if y + r < h { acc += tmp[(y + r) * w + x]; count += 1; }
            if y > r     { acc -= tmp[(y - r - 1) * w + x]; count -= 1; }
            out_col[y] = acc / count as f32;
        }
        for y in 0..h { out[y * w + x] = out_col[y]; }
    }
    out
}
```

New:

```rust
use crate::image::{ColorSpace, Image};
use rayon::prelude::*;

/// Separable box blur of a single channel plane.
/// `buf` is row-major w×h. Returns a new blurred buffer.
///
/// Both sweeps run in parallel via rayon:
/// * **Horizontal sweep** writes `tmp` row by row; each row's output is a
///   disjoint `w`-element slice, so `par_chunks_mut(w)` is safe and trivial.
/// * **Vertical sweep** reads `tmp` column-by-column (stride `w`) and
///   historically wrote back into a row-major `out` via the same stride.
///   That stride-`w` scatter prevents a clean parallel-mut over rows. The
///   fix: write the vertical pass into a column-major `tmp_col` buffer
///   (each column is a contiguous `h`-element slice, so `par_chunks_mut(h)`
///   is safe), then transpose column-major → row-major in a final parallel
///   pass. Memory cost: one extra w×h f32 buffer (same size as `tmp`).
///   CPU cost: one extra pass, amortized against doing the full sweep in
///   parallel on 8+ cores.
fn box_blur_channel(buf: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    if r == 0 { return buf.to_vec(); }

    // --- Horizontal sweep: row-parallel, row-major output ---
    let mut tmp = vec![0.0f32; buf.len()];
    tmp.par_chunks_mut(w).enumerate().for_each(|(y, out_row)| {
        let row = &buf[y * w..(y + 1) * w];
        let right0 = r.min(w - 1);
        let mut acc: f32 = row[0..=right0].iter().sum();
        let mut count = right0 + 1;
        out_row[0] = acc / count as f32;
        for x in 1..w {
            if x + r < w { acc += row[x + r]; count += 1; }
            if x > r     { acc -= row[x - r - 1]; count -= 1; }
            out_row[x] = acc / count as f32;
        }
    });

    // --- Vertical sweep: column-parallel into a column-major scratch ---
    //
    // `tmp_col[x * h + y]` = `tmp[y * w + x]` after blur along y.
    // Each column is a contiguous `h`-element chunk of `tmp_col`, and
    // columns don't overlap, so par_chunks_mut(h) is safe.
    let mut tmp_col = vec![0.0f32; buf.len()];
    tmp_col.par_chunks_mut(h).enumerate().for_each(|(x, out_col)| {
        let bot0 = r.min(h - 1);
        let mut acc: f32 = (0..=bot0).map(|i| tmp[i * w + x]).sum();
        let mut count = bot0 + 1;
        out_col[0] = acc / count as f32;
        for y in 1..h {
            if y + r < h { acc += tmp[(y + r) * w + x]; count += 1; }
            if y > r     { acc -= tmp[(y - r - 1) * w + x]; count -= 1; }
            out_col[y] = acc / count as f32;
        }
    });

    // --- Transpose column-major → row-major (parallel by output row) ---
    let mut out = vec![0.0f32; buf.len()];
    out.par_chunks_mut(w).enumerate().for_each(|(y, out_row)| {
        for x in 0..w {
            out_row[x] = tmp_col[x * h + y];
        }
    });
    out
}
```

- [ ] **Step 5: Build to confirm rayon compiles cleanly.**

Run: `cd src/raw-pipeline && cargo build -p raw-core 2>&1 | tail -10`
Expected: `Finished`, no warnings.

- [ ] **Step 6: Run the blur module tests.**

Run: `cd src/raw-pipeline && cargo test -p raw-core --lib stages::blur 2>&1 | tail -15`
Expected: all 4 tests pass (3 pre-existing + 1 new axis-preservation test). If `blur_smooths_a_delta` or `blur_asymmetric_horizontal_stripe_preserves_axis` fails, the transpose is wrong — re-verify the `tmp_col[x * h + y] = tmp[y * w + x]` indexing against the scalar serial version.

- [ ] **Step 7: Run the full raw-core lib suite (catches downstream users of `gaussian_blur_rgb`: noise_reduction, sharpen, clarity, texture, dehaze).**

Run: `cd src/raw-pipeline && cargo test -p raw-core --lib 2>&1 | tail -5`
Expected: all passing. Stages `sharpen`, `clarity`, `texture`, `dehaze` all call `gaussian_blur_rgb` internally — their tests are the integration gate for the blur rewrite.

- [ ] **Step 8: Run the color parity harness.**

Run: `BUDGET=15 src/scripts/test_color_pipeline.sh 2>&1 | tail -15`
Expected: PASS with mean ΔE within 15. Because the blur math is byte-equivalent (same accumulator, same clamps), ΔE should match the post-Task-2 run to within float-reduction noise. If ΔE regresses, the transpose indexing is the first suspect.

- [ ] **Step 9: Commit.**

```bash
git add src/raw-pipeline/raw-core/src/stages/blur.rs
git commit -m "$(cat <<'EOF'
perf(raw-core): parallelize box_blur_channel horizontal and vertical sweeps

Both sweeps inside box_blur_channel were strictly serial — six calls per
chroma-blur (3 passes × 2 axes) × three calls per RGB image = 18 serial
w×h sweeps per gaussian_blur_rgb. The horizontal sweep parallelizes
trivially via par_chunks_mut(w). The vertical sweep's stride-w scatter
into a row-major buffer prevents a direct par_iter_mut, so the rewrite
lands the vertical output into a column-major scratch buffer (each
column a contiguous h-element slice — par-safe), then transposes back
in a final parallel pass. One extra w×h f32 buffer of memory; math is
otherwise unchanged. New regression test `blur_asymmetric_horizontal_
stripe_preserves_axis` guards against axis-swap bugs introduced by the
transpose.

Ticket: docs/tickets/05-optimize-nr-color-chroma-blur.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Measure the post-optimization `nr_color` timing and lock it into the final commit

**Files:**
- No source changes. This task is pure measurement + a single commit that records the new baseline.

**Why this matters:** Ticket 05's acceptance criteria are pinned against concrete numbers from the `MAPLE_PROFILE` instrumentation (`nr_color` at 19.32 s before). Without a post-change measurement in git history, future work that "fixes" `nr_color` again has no reference point to compare against, and the Estimated impact section of ticket 05 stays theoretical. This task runs the same `maple-cli batch` profile run the ticket measured against, extracts the new `nr_color` line, and amends it into the commit trail via an empty-scoped perf-measurement commit.

- [ ] **Step 1: Confirm the reference fixture is present.**

Run: `ls -lh src/raw-pipeline/test-fixtures/raws/dji-mavic3pro-100mp.dng 2>&1`
Expected: a ~200 MB file exists. If not, substitute any locally available DNG (prefer one matching the ticket's original measurement — `test_0002.dng` is the fallback the ticket references). Note the substitution in the commit body in Step 5.

- [ ] **Step 2: Release-build `maple-cli` so the numbers are comparable to the ticket's release-build baseline.**

Run: `cd src/raw-pipeline && cargo build --release --bin maple-cli 2>&1 | tail -3`
Expected: `Finished` with `release` profile.

- [ ] **Step 3: Run `maple-cli batch` with `MAPLE_PROFILE=1` and capture the stage-timing output.**

Run:

```bash
cd src/raw-pipeline && \
  MAPLE_PROFILE=1 cargo run --release --bin maple-cli -- \
  batch <(echo '{"entries":[{"raw":"../../test-fixtures/raws/dji-mavic3pro-100mp.dng","xmp":null,"out":"/tmp/nr-color-after.png"}]}') \
  --out-dir /tmp/nr-color-after/ 2>&1 | grep '\[raw-core\]' | tee /tmp/nr-color-after.log
```

Expected: 18-19 lines (one per stage), with `[raw-core] nr_color` expected around ~1–2 s (down from 19.32 s). The other stage timings should be largely unchanged except for modest speedups in stages that also go through blur (sharpen, clarity, texture, dehaze) — those will benefit from Task 3's parallel box blur.

Save the full output: `/tmp/nr-color-after.log` will be read in Step 5.

- [ ] **Step 4: Confirm the gate works when `MAPLE_PROFILE` is unset — no stage-timing spam in normal runs.**

Run:

```bash
cd src/raw-pipeline && \
  cargo run --release --bin maple-cli -- \
  batch <(echo '{"entries":[{"raw":"../../test-fixtures/raws/dji-mavic3pro-100mp.dng","xmp":null,"out":"/tmp/nr-color-clean.png"}]}') \
  --out-dir /tmp/nr-color-clean/ 2>&1 | grep '\[raw-core\]' | head
```

Expected: empty output.

- [ ] **Step 5: Commit an empty-change "perf measurement" commit that embeds the new baseline.**

The previous three commits implement the fix; this final commit captures the measurement so the ticket's acceptance criteria have a paper trail.

Read `/tmp/nr-color-after.log` and paste its full contents into the commit body where the placeholder lives. Example flow:

```bash
# Verify tree is clean (previous tasks already committed).
git status
# Expected: "nothing to commit, working tree clean"

# Create an empty commit whose body carries the baseline.
git commit --allow-empty -m "$(cat <<'EOF'
perf(raw-core): record nr_color post-hoist/parallelize baseline

After Task 1 (OnceLock matrix-inverse hoist), Task 2 (rayon per-pixel
loops in noise_reduction), and Task 3 (rayon horizontal+vertical sweeps
in box_blur_channel), re-ran `MAPLE_PROFILE=1 maple-cli batch` on
test-fixtures/raws/dji-mavic3pro-100mp.dng (release build, M-series).

Before (ticket 05 baseline):
[raw-core] nr_color                         19.32s

After (this commit):
<paste the full `[raw-core]` block from /tmp/nr-color-after.log here,
including every stage line so the relative ranking is visible>

nr_color is no longer the dominant stage. Further work toward the
ticket's 50 ms target (Y'CbCr chroma decorrelation, SIMD, NLM) lives
in a separate plan.

Ticket: docs/tickets/05-optimize-nr-color-chroma-blur.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

If the ticket's own "before" number needs updating in-file (it currently shows `2.46 s` from `test_0002.dng`, not `19.32 s`), leave that to a separate plan — editing the ticket is outside this plan's scope and the commit body above makes the post-change number locatable from git log alone.

---

## Self-Review Checklist

**Spec coverage:**
- Hoist three `Matrix3::inverse()` calls in `oklab_to_rec2020` to `OnceLock` — Task 1.
- Verify `rec2020_to_oklab` has no equivalent issue — Task 1 Step 1 and finding #2 confirm it uses only forward const matrices; no-op recorded in Task 1 Step 4's doc comment and finding #2.
- Parallelize three per-pixel loops in `apply_color` — Task 2 (also covers `apply_luminance` for the same mechanical reason).
- Parallelize horizontal and vertical sweeps in `box_blur_channel` — Task 3, with the vertical-sweep transpose detour documented.
- Link ticket 05 at the top of the plan — "Related ticket" callout at line 5.
- Include `BUDGET=15 src/scripts/test_color_pipeline.sh` as a parity gate — runs in Task 1 Step 8, Task 2 Step 6, Task 3 Step 8 (every math-touching task).
- Re-run `MAPLE_PROFILE=1 maple-cli batch` on the reference fixture and record new `nr_color` timing in a final commit body — Task 4.

**Out-of-scope adherence (hard constraints):**
- Y'CbCr fallback: excluded — called out in "Out of scope."
- Slice-5 shim → NLM replacement: excluded — called out in "Out of scope."
- Changes outside the three listed files: none — every file-path reference in task bodies is to `src/raw-pipeline/raw-core/src/color/oklab.rs`, `.../stages/noise_reduction.rs`, or `.../stages/blur.rs`. The ticket cross-reference and `test_color_pipeline.sh` invocations read other paths but don't edit them.

**Placeholder scan:** none — every step has concrete file:line references, concrete commands, and concrete code blocks where changes are made. Task 4 Step 5's "paste the full `[raw-core]` block" refers to the output of Step 3 captured in `/tmp/nr-color-after.log`; the paste location is explicit.

**Type consistency:**
- `oklab_inverse_matrices` returns `&'static (Matrix3, Matrix3, Matrix3)` in Task 1 Step 4, and the destructuring `let (m2_inv, m1_inv, m_srgb_to_rec2020) = oklab_inverse_matrices();` in `oklab_to_rec2020` matches (tuple of three references via auto-deref through pattern matching, per Rust rules — `&(A, B, C)` pattern-matches as `(&A, &B, &C)` which is what `Matrix3.mul_vec(&self, ...)` takes).
- The `cached_inverses_match_matrix3_inverse_bit_exact` test dereferences them explicitly via `*m2_inv` for `assert_eq!` comparison with `Matrix3::inverse()`'s `Matrix3` return. Consistent.
- Rayon imports use `rayon::prelude::*` in both `noise_reduction.rs` (Task 2) and `blur.rs` (Task 3), matching the pattern already established in `view/encode.rs` and `demosaic/half_res.rs`.
- `par_chunks_mut(w)` in Task 3's horizontal sweep yields `&mut [f32]` chunks of exactly length `w` — the inner indexing `out_row[x]` for `x in 0..w` is safe. Same for `par_chunks_mut(h)` in the vertical sweep with `out_col[y]` for `y in 0..h`.

**Highest-risk task:** Task 3 (box_blur_channel parallelization). The vertical-sweep transpose is a structural rewrite — an off-by-one in `tmp_col[x * h + y]` indexing or a stride confusion during transpose would silently produce wrong-but-plausible pixels. Mitigated by the new `blur_asymmetric_horizontal_stripe_preserves_axis` test written *before* the refactor, plus the full raw-core lib suite (which includes downstream users: sharpen, clarity, texture, dehaze all call gaussian_blur_rgb), plus the color parity harness. If Task 3 regresses ΔE, Tasks 1 and 2 still stand on their own and can ship independently.

**Known follow-up not in this plan:**
- If post-Task-4 `nr_color` is still above the 50 ms ticket target, the Y'CbCr decorrelation + plane-only blur direction is the next plan (already flagged on ticket 05).
- SIMD of the per-pixel Oklab math via `std::simd` or `wide` — ticket 05 has it.
- Replacing the slice-5 shim with a proper NLM pass — ticket 05 has it.
