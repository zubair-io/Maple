//! Bake a fitted [`ProfileCurve`] into a display-space 3D LUT (#817).
//!
//! The Auto Profile curve is, after #550, a bounded post-AgX sRGB-encoded
//! display-space delta: `agx → rec2020→srgb → srgb_gamma_encode` always run,
//! and the fitted curve applies in f32 sRGB-encoded `[0, 1]` space via
//! [`super::apply::apply_curve`]. That bounded `[0, 1]³` domain is exactly
//! what a plain GPU 3D LUT wants — no log shaper, no out-of-range tail.
//!
//! [`bake_profile_lut`] samples the canonical `apply_curve` over a regular
//! `N×N×N` grid spanning `[0, 1]³`. The LUT is JUST a sampled `apply_curve`
//! (single source of truth), so any later curve / matrix / Oklab fix in the
//! apply path propagates into every baked LUT for free.
//!
//! ## Per-image, not per-tick
//!
//! The fitted curve is fit from a PINNED default-model develop and cached
//! keyed on RAW identity — `(path, mtime)` / bytes-hash, see `super::cache` —
//! so it is stable across slider edits by construction (#1085). A host bakes
//! the LUT ONCE per image when the curve is first fit, uploads it to a GPU
//! sampler, and re-samples it on every slider tick WITHOUT re-baking. Baking
//! is an `O(N³)` cold-path step, never a render-loop operation.

use super::apply::apply_curve;
use super::curve::ProfileCurve;
use super::lut::ColorLut;

/// Default grid resolution for [`bake_profile_lut`]. 33³ is the industry-
/// standard 3D LUT size (`.cube` default) and is plenty here: the #550 curve
/// is per-channel-separable, so trilinear sampling reproduces `apply_curve`
/// to within float noise (the only error is grid points at `i/(N-1)` vs the
/// 32 curve anchors at `j/31` straddling a curve kink — measured well under
/// the per-band bias tolerance; see `tests`). The constant lets the FFI /
/// WASM hosts and the golden test share one canonical size.
pub const DEFAULT_LUT_SIZE: usize = 33;

/// Upper bound on the per-axis LUT resolution accepted by [`bake_profile_lut`]
/// and the FFI / WASM wrappers. GL ES 3.0 and WebGL2 guarantee only
/// `MAX_3D_TEXTURE_SIZE >= 256`, so a LUT wider than 256 per axis is not
/// uploadable as a 3D texture on conformant hardware anyway. The ceiling also
/// bounds the cold-path allocation: `256³ * 3` f32 ≈ 192 MiB worst case, large
/// but finite — past it, the `n³ * 3` sizing arithmetic risks `usize` overflow
/// and the alloc can trap / hang a WASM main thread, so the wrappers reject it.
/// All three hosts (core, FFI, WASM) validate `n` against this one constant so
/// they agree on the accepted range. The default `n = 33` is well within it.
pub const MAX_LUT_SIZE: usize = 256;

/// Sample `apply_curve` over a regular `n × n × n` grid spanning `[0, 1]³`
/// display space and return the result as a flat f32 buffer.
///
/// **Layout:** `n³` RGB triplets, R varying fastest, then G, then B —
/// `out[((b*n + g)*n + r)*3 + c]`. Grid coordinate `k` maps to display value
/// `k as f32 / (n - 1) as f32`, so corners land exactly on 0.0 and 1.0. This
/// is the natural layout for a GPU 3D texture indexed `tex[b][g][r]` (R is
/// the fastest-varying address), which is what the web WebGL2 (#394) and
/// Apple Metal (#812) samplers upload.
///
/// Length is always `n * n * n * 3`. Each output triplet is whatever
/// `apply_curve` produces for that grid point — including any matrix / Oklab
/// branches, which the #550 curve leaves inert but a future fit may not.
///
/// # Panics
/// Panics if `n < 2` (a 1-entry grid cannot span an interval) or if
/// `n > MAX_LUT_SIZE` (the FFI / WASM wrappers reject such `n` with an error
/// *before* calling this, so the panic is an internal last line of defence,
/// not a host-reachable abort).
pub fn bake_profile_lut(curve: &ProfileCurve, n: usize) -> Vec<f32> {
    assert!(n >= 2, "bake_profile_lut: n must be >= 2 (got {n})");
    assert!(
        n <= MAX_LUT_SIZE,
        "bake_profile_lut: n must be <= {MAX_LUT_SIZE} (got {n})"
    );
    // Build the grid as one packed RGB buffer, then run the canonical apply
    // path over it in place — identical code to the render hot loop, so the
    // LUT cannot drift from what the CPU pipeline produces. `n <= MAX_LUT_SIZE`
    // guarantees `n³ * 3` cannot overflow `usize`, so the capacity is exact.
    let capacity = n * n * n * 3;
    let mut grid = Vec::with_capacity(capacity);
    let denom = (n - 1) as f32;
    for bi in 0..n {
        let bv = bi as f32 / denom;
        for gi in 0..n {
            let gv = gi as f32 / denom;
            for ri in 0..n {
                let rv = ri as f32 / denom;
                grid.push(rv);
                grid.push(gv);
                grid.push(bv);
            }
        }
    }
    apply_curve(&mut grid, curve);
    grid
}

/// Bake a fitted [`ProfileCurve`] **and** a per-image residual [`ColorLut`]
/// into ONE composed display-space 3D LUT — the single CIColorCube / GPU
/// texture a host samples to apply the full Auto Profile tail (#924).
///
/// The composition is order-faithful to the render path *by construction*:
/// [`apply_auto_profile`](super::apply_pipeline::apply_auto_profile) runs
/// `apply_curve` then `residual.apply` over the same `DisplayEncodedSrgb`
/// buffer, so baking is literally those two ops over the `[0, 1]³` grid —
///
/// ```text
/// out[node] = residual.sample(apply_curve(node))
/// ```
///
/// i.e. [`bake_profile_lut`] (which fills each node with `apply_curve(node)`)
/// followed by [`ColorLut::apply`] (trilinear `residual.sample` per node). A
/// host that samples the result at a post-AgX display value `v` therefore
/// reads `residual.sample(curve(v))` trilinearly — matching the CPU pixel
/// chain up to the grid's interpolation error, the same error the per-band
/// parity gate already budgets.
///
/// Layout and length match [`bake_profile_lut`] exactly (`n³` RGB triplets, R
/// fastest, `n * n * n * 3` floats); `n` is validated there (panics outside
/// `[2, MAX_LUT_SIZE]`; the FFI / WASM wrappers reject such `n` first).
///
/// When `residual` is identity (`MAPLE_AUTO_LUT_STRENGTH=0` or a degenerate
/// fit), `residual.apply` is identity-within-float-noise, so the result equals
/// [`bake_profile_lut`] to sub-ULP — the #550 accuracy floor. For a BYTE-exact
/// curve-only bake (no residual fit at all), call [`bake_profile_lut`]
/// directly; the FFI does so when the residual stage returns `None`.
pub fn bake_auto_profile_lut(curve: &ProfileCurve, residual: &ColorLut, n: usize) -> Vec<f32> {
    let mut grid = bake_profile_lut(curve, n);
    residual.apply(&mut grid);
    grid
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::view::auto_profile::apply::apply_curve;
    use crate::view::auto_profile::curve::{ChannelCurve, ProfileCurve};

    /// A deliberately non-identity per-channel curve so the golden test
    /// exercises real interpolation, not a trivial pass-through. Each channel
    /// gets a distinct monotone shape (gamma-like / S-curve / lift) so a
    /// channel-swap bug in the LUT layout would surface.
    fn non_identity_curve() -> ProfileCurve {
        let mut c = ProfileCurve::identity();
        let shape = |i: usize, exp: f32, lift: f32| {
            let x = i as f32 / 31.0;
            let y = lift + (1.0 - lift) * x.powf(exp);
            (x, y.clamp(0.0, 1.0))
        };
        let mut r = ChannelCurve::identity();
        let mut g = ChannelCurve::identity();
        let mut b = ChannelCurve::identity();
        for i in 0..32 {
            r.anchors[i] = shape(i, 0.7, 0.05); // shadow lift + brighten
            g.anchors[i] = shape(i, 1.0, 0.0); // identity
            b.anchors[i] = shape(i, 1.4, 0.0); // darken midtones
        }
        c.r = r;
        c.g = g;
        c.b = b;
        c
    }

    /// Trilinear sample of a baked LUT at display point `(r, g, b)` in
    /// `[0, 1]³`. Mirrors what the GPU sampler does — the acceptance criterion
    /// is that THIS reproduces `apply_curve`.
    fn trilinear(lut: &[f32], n: usize, r: f32, g: f32, b: f32) -> [f32; 3] {
        let denom = (n - 1) as f32;
        let coord = |v: f32| {
            let p = v.clamp(0.0, 1.0) * denom;
            let lo = p.floor() as usize;
            let hi = (lo + 1).min(n - 1);
            (lo, hi, p - lo as f32)
        };
        let (r0, r1, rt) = coord(r);
        let (g0, g1, gt) = coord(g);
        let (b0, b1, bt) = coord(b);
        let at = |ri: usize, gi: usize, bi: usize, c: usize| lut[((bi * n + gi) * n + ri) * 3 + c];
        let mut out = [0.0_f32; 3];
        for (c, slot) in out.iter_mut().enumerate() {
            let lerp = |a: f32, b: f32, t: f32| a + (b - a) * t;
            let c00 = lerp(at(r0, g0, b0, c), at(r1, g0, b0, c), rt);
            let c10 = lerp(at(r0, g1, b0, c), at(r1, g1, b0, c), rt);
            let c01 = lerp(at(r0, g0, b1, c), at(r1, g0, b1, c), rt);
            let c11 = lerp(at(r0, g1, b1, c), at(r1, g1, b1, c), rt);
            let c0 = lerp(c00, c10, gt);
            let c1 = lerp(c01, c11, gt);
            *slot = lerp(c0, c1, bt);
        }
        out
    }

    #[test]
    fn lut_has_expected_length_and_layout() {
        let lut = bake_profile_lut(&ProfileCurve::identity(), DEFAULT_LUT_SIZE);
        let n = DEFAULT_LUT_SIZE;
        assert_eq!(lut.len(), n * n * n * 3);
        // Identity curve → each grid point reproduces its own coordinate.
        // Spot-check the layout: index (r=1,g=0,b=0) must carry the R step.
        let step = 1.0 / (n - 1) as f32;
        // (b=0, g=0, r=1) → ((0*n + 0)*n + 1)*3 = 3.
        let idx = 3;
        assert!((lut[idx] - step).abs() < 1e-6, "R fastest-varying axis");
        assert!(lut[idx + 1].abs() < 1e-6, "G unchanged at r=1");
        assert!(lut[idx + 2].abs() < 1e-6, "B unchanged at r=1");
    }

    /// Golden test (acceptance): a trilinearly-sampled baked LUT reproduces
    /// `apply_curve` within a tight per-luma-band per-channel bias tolerance.
    ///
    /// Bins exact-vs-sampled deltas by Rec.709 luma into the 5 gate bands and
    /// asserts each band × channel mean bias is within tolerance. The mean
    /// bias is what the Auto Profile T8 gate measures, so this is the same
    /// objective the rest of the pipeline is held to.
    #[test]
    fn trilinear_sample_reproduces_apply_curve_within_band_bias() {
        let curve = non_identity_curve();
        let n = DEFAULT_LUT_SIZE;
        let lut = bake_profile_lut(&curve, n);

        // Dense off-grid probe set: 40³ points, deliberately NOT aligned to
        // the 33-grid so every sample exercises interpolation.
        const PROBE: usize = 40;
        let mut band_sum = [[0.0_f64; 3]; 5];
        let mut band_cnt = [0_u64; 5];
        let mut max_abs = 0.0_f32;
        for bi in 0..PROBE {
            for gi in 0..PROBE {
                for ri in 0..PROBE {
                    let to_v = |k: usize| (k as f32 + 0.5) / PROBE as f32;
                    let (rv, gv, bv) = (to_v(ri), to_v(gi), to_v(bi));
                    let mut exact = [rv, gv, bv];
                    apply_curve(&mut exact, &curve);
                    let sampled = trilinear(&lut, n, rv, gv, bv);
                    // Bin by the EXACT output's Rec.709 luma (the value a
                    // gate would see).
                    let luma =
                        (0.2126 * exact[0] + 0.7152 * exact[1] + 0.0722 * exact[2]).clamp(0.0, 1.0);
                    let band = ((luma * 5.0) as usize).min(4);
                    for c in 0..3 {
                        let d = sampled[c] - exact[c];
                        band_sum[band][c] += d as f64;
                        max_abs = max_abs.max(d.abs());
                    }
                    band_cnt[band] += 1;
                }
            }
        }

        // Per-band per-channel mean bias tolerance. The separable per-channel
        // curve makes trilinear near-exact; this ceiling is comfortably above
        // the observed bias and well under the 0.05 T8 gate margin.
        // Observed at N=33 (40³ off-grid probe): worst per-band per-channel
        // mean bias ≈ 4.6e-4 (band 4, G), max single-point |error| ≈ 2.2e-3.
        // ~100× under the 0.05 T8 gate margin, so 33³ is the chosen size.
        const BIAS_TOL: f64 = 1e-3;
        for band in 0..5 {
            if band_cnt[band] == 0 {
                continue;
            }
            for (c, &sum) in band_sum[band].iter().enumerate() {
                let mean = sum / band_cnt[band] as f64;
                assert!(
                    mean.abs() < BIAS_TOL,
                    "band {band} channel {c} mean bias {mean:.6} exceeds {BIAS_TOL}"
                );
            }
        }
        // Worst-case point error stays small too (sanity vs a single kink).
        assert!(max_abs < 5e-3, "max abs sample error {max_abs:.6}");
    }

    #[test]
    fn flat_round_trip_is_exact() {
        let curve = non_identity_curve();
        let flat = curve.to_flat();
        let back = ProfileCurve::from_flat(&flat).expect("round trip");
        assert_eq!(curve, back);
    }

    #[test]
    fn from_flat_rejects_wrong_length() {
        assert!(ProfileCurve::from_flat(&[0.0; 4]).is_none());
        assert!(ProfileCurve::from_flat(&[]).is_none());
    }

    #[test]
    #[should_panic(expected = "n must be >= 2")]
    fn bake_rejects_degenerate_n() {
        bake_profile_lut(&ProfileCurve::identity(), 1);
    }

    #[test]
    #[should_panic(expected = "n must be <= 256")]
    fn bake_rejects_oversized_n() {
        bake_profile_lut(&ProfileCurve::identity(), MAX_LUT_SIZE + 1);
    }

    /// `n` below 2 and above `MAX_LUT_SIZE` are rejected; a valid `n` (the
    /// boundary `MAX_LUT_SIZE` and the default) still bakes the full grid.
    #[test]
    fn bake_n_bounds() {
        // Below the floor panics (covered by `bake_rejects_degenerate_n`),
        // above the ceiling panics (covered by `bake_rejects_oversized_n`).
        // Here assert the accepted boundary and default produce full LUTs.
        let curve = ProfileCurve::identity();
        let max = bake_profile_lut(&curve, MAX_LUT_SIZE);
        assert_eq!(max.len(), MAX_LUT_SIZE * MAX_LUT_SIZE * MAX_LUT_SIZE * 3);
        let def = bake_profile_lut(&curve, DEFAULT_LUT_SIZE);
        assert_eq!(
            def.len(),
            DEFAULT_LUT_SIZE * DEFAULT_LUT_SIZE * DEFAULT_LUT_SIZE * 3
        );
    }

    /// Acceptance: composing the curve with an IDENTITY residual reproduces the
    /// pure curve-only bake to within float noise. This is the
    /// `MAPLE_AUTO_LUT_STRENGTH=0 ⇒ #550 floor` guarantee on the composed path:
    /// an identity residual is trilinear over an identity grid, exact-to-sub-ULP,
    /// so layering it changes nothing perceptible.
    #[test]
    fn compose_with_identity_residual_matches_curve_only_within_epsilon() {
        let curve = non_identity_curve();
        let n = DEFAULT_LUT_SIZE;
        let composed = bake_auto_profile_lut(&curve, &ColorLut::identity(n), n);
        let curve_only = bake_profile_lut(&curve, n);
        assert_eq!(composed.len(), curve_only.len());
        let max = composed
            .iter()
            .zip(&curve_only)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0_f32, f32::max);
        assert!(
            max < 1e-6,
            "identity-residual compose drifted from curve-only by {max}"
        );
    }

    /// Faithfulness: the composed cube applies the residual AFTER the curve.
    /// At every node `out == residual.sample(curve(node))` — proving both the
    /// ordering (curve then residual, not the reverse) and that the residual's
    /// cross-channel shift survives the bake. Uses a residual that mixes green
    /// into blue, which a per-channel curve provably cannot express, so a
    /// curve-only bake would fail this.
    #[test]
    fn composed_lut_applies_residual_after_curve() {
        let curve = non_identity_curve();
        let n = DEFAULT_LUT_SIZE;
        let mut residual = ColorLut::identity(n);
        for px in residual.data.chunks_mut(3) {
            px[2] = (0.85 * px[2] + 0.15 * px[1]).clamp(0.0, 1.0); // blue ← mix(blue, green)
        }
        let composed = bake_auto_profile_lut(&curve, &residual, n);
        let curve_only = bake_profile_lut(&curve, n);
        let mut max = 0.0_f32;
        for i in 0..n * n * n {
            let after_curve = [
                curve_only[i * 3],
                curve_only[i * 3 + 1],
                curve_only[i * 3 + 2],
            ];
            let expect = residual.sample(after_curve);
            for c in 0..3 {
                max = max.max((composed[i * 3 + c] - expect[c]).abs());
            }
        }
        assert!(
            max < 1e-6,
            "composed cube != residual∘curve at nodes (max diff {max})"
        );
        // And it must actually DIFFER from curve-only (the residual is live),
        // else the test would pass trivially on a broken no-op compose.
        let moved = composed
            .iter()
            .zip(&curve_only)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0_f32, f32::max);
        assert!(moved > 1e-3, "residual had no effect (max move {moved})");
    }
}
