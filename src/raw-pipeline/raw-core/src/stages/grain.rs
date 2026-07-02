//! Film grain — display-linear deterministic value noise (#1110, tone/zoom
//! design § 10.2).
//!
//! Runs POST-AgX, before the target-gamut conversion (`rec2020_to_srgb`):
//! grain is a display-domain aesthetic — injected scene-linear its
//! amplitude would swing with exposure, which is not how silver halide
//! behaves. Luminance-modulated and MONOCHROMATIC (the same noise value on
//! all three channels — luma-dominant like film), fading out in deep
//! blacks and near white:
//!
//! ```text
//! pitch  = (1 + 5·size/100) · longEdge/2000              // resolution-stable
//! n(x,y) = value-noise(x/pitch, y/pitch; SEED)           // quintic-smoothed
//!          mixed with a second octave at 2× frequency by roughness
//! w(Yd)  = clamp(4·Yd·(1−Yd), 0, 1)
//! RGB'   = RGB + K · amount/100 · w(Yd) · n(x, y)
//! ```
//!
//! ## Determinism (the cross-platform contract)
//!
//! The lattice hash is an integer PCG mix with IDENTICAL constants in this
//! file and `raw-gpu/src/grain.wgsl`, seeded by the fixed [`GRAIN_SEED`] —
//! no RNG anywhere. Renders are bit-reproducible per (x, y, params), and
//! the WGSL port is parity-gated against this stage.
//!
//! ## Preview/export parity is STATISTICAL, not pointwise
//!
//! `pitch` scales with the rendered long edge, so the grain's apparent
//! size is stable across render resolutions — but the noise field
//! re-samples per resolution (a half-res preview is NOT a downsample of
//! the full-res grain). The contract for preview-vs-export agreement is
//! therefore statistical (same mean, same amplitude, same apparent pitch),
//! not pixel-pointwise. Same-resolution renders ARE bit-identical.
//!
//! ## Tile safety
//!
//! Coordinates are ABSOLUTE image pixels (`origin` + buffer x/y), so a
//! tile render reproduces the full-frame field exactly and panning is
//! stable (no swimming grain).

use crate::image::{ColorSpace, Image};

/// Fixed lattice seed ("MAPL"). Identical in `grain.wgsl`.
pub const GRAIN_SEED: u32 = 0x4D41_504C;
/// Second-octave seed offset — decorrelates the 2× lattice from the base
/// one (golden-ratio constant; identical in `grain.wgsl`).
pub const GRAIN_SEED2: u32 = GRAIN_SEED ^ 0x9E37_79B9;
/// Display-linear amplitude at `amount = 100`, full luminance weight
/// (spec § 10.2 initial calibrated value).
pub const GRAIN_K: f32 = 0.2;
/// Grain pitch in pixels at `size = 0` / `size = 100` for a 2000-px long
/// edge (spec: `lerp(1, 6, size/100) · longEdge/2000`).
pub const GRAIN_PITCH_MIN: f32 = 1.0;
pub const GRAIN_PITCH_MAX: f32 = 6.0;
/// Rec.2020 luma weights (the pipeline-wide constant).
const LUMA_REC2020: [f32; 3] = [0.2627, 0.6780, 0.0593];

/// One round of the PCG-style integer mix (Jarzynski–Olano `pcg_hash`).
/// Constants are load-bearing — identical in `grain.wgsl`.
#[inline]
fn pcg(v: u32) -> u32 {
    let state = v.wrapping_mul(747_796_405).wrapping_add(2_891_336_453);
    let word = ((state >> ((state >> 28) + 4)) ^ state).wrapping_mul(277_803_737);
    (word >> 22) ^ word
}

/// Hash a 2-D lattice point + seed to a uniform value in [-1, 1].
#[inline]
fn lattice(ix: u32, iy: u32, seed: u32) -> f32 {
    let h = pcg(ix.wrapping_add(pcg(iy.wrapping_add(seed))));
    (h as f32) * (2.0 / 4_294_967_295.0) - 1.0
}

/// Quintic smoothstep weight `t³(t(6t − 15) + 10)` (Perlin's fade — C²).
#[inline]
fn quintic(t: f32) -> f32 {
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

/// Quintic-smoothed 2-D value noise at lattice-space coords `(u, v) ≥ 0`,
/// zero-mean over the lattice distribution, range ⊂ [-1, 1].
#[inline]
fn value_noise(u: f32, v: f32, seed: u32) -> f32 {
    let i = u.floor();
    let j = v.floor();
    let fu = u - i;
    let fv = v - j;
    let iu = i as u32;
    let jv = j as u32;
    let n00 = lattice(iu, jv, seed);
    let n10 = lattice(iu.wrapping_add(1), jv, seed);
    let n01 = lattice(iu, jv.wrapping_add(1), seed);
    let n11 = lattice(iu.wrapping_add(1), jv.wrapping_add(1), seed);
    let sx = quintic(fu);
    let sy = quintic(fv);
    let nx0 = n00 + (n10 - n00) * sx;
    let nx1 = n01 + (n11 - n01) * sx;
    nx0 + (nx1 - nx0) * sy
}

/// Hoisted per-render parameters — shared derivation for the stage, the
/// predictor, and (transcribed) the WGSL host code: `(k, inv_pitch, rho)`.
#[inline]
pub fn grain_params(amount: f32, size: f32, roughness: f32, long_edge: u32) -> (f32, f32, f32) {
    let pitch = (GRAIN_PITCH_MIN + (size / 100.0) * (GRAIN_PITCH_MAX - GRAIN_PITCH_MIN))
        * (long_edge as f32)
        / 2000.0;
    let k = GRAIN_K * amount / 100.0;
    let rho = roughness / 100.0;
    (k, 1.0 / pitch, rho)
}

/// The deterministic, zero-mean grain field at absolute image pixel
/// `(px, py)`: base octave + `rho`-weighted second octave at 2× frequency,
/// normalized by `1 + rho` so the amplitude stays ⊂ [-1, 1]. Exposed for
/// the closed-form predictor; the stage inlines the same math.
#[inline]
pub fn grain_noise(px: u32, py: u32, inv_pitch: f32, rho: f32) -> f32 {
    let u = px as f32 * inv_pitch;
    let v = py as f32 * inv_pitch;
    let n1 = value_noise(u, v, GRAIN_SEED);
    let n2 = value_noise(u * 2.0, v * 2.0, GRAIN_SEED2);
    (n1 + rho * n2) / (1.0 + rho)
}

/// Apply grain to a buffer that is a WINDOW of the full image: `origin` is
/// the buffer's top-left in full-image pixels; `full` the full image dims
/// (which set the resolution-stable pitch). The whole-image entry
/// [`apply`] is `origin = (0, 0)`, `full =` the buffer extent.
pub fn apply_windowed(
    img: &mut Image,
    amount: f32,
    size: f32,
    roughness: f32,
    origin: (u32, u32),
    full: (u32, u32),
) {
    img.assert_space(ColorSpace::DisplayLinearRec2020);
    if amount.abs() < 1e-3 {
        return; // identity short-circuit — bit-identical baseline
    }
    let long_edge = full.0.max(full.1);
    let (k, inv_pitch, rho) = grain_params(amount, size, roughness, long_edge);

    let w = img.width as usize;
    for (row_idx, row) in img.pixels.chunks_exact_mut(w).enumerate() {
        let py = origin.1 + row_idx as u32;
        for (col_idx, p) in row.iter_mut().enumerate() {
            let px = origin.0 + col_idx as u32;
            let n = grain_noise(px, py, inv_pitch, rho);
            let yd = (LUMA_REC2020[0] * p[0] + LUMA_REC2020[1] * p[1] + LUMA_REC2020[2] * p[2])
                .clamp(0.0, 1.0);
            let wl = (4.0 * yd * (1.0 - yd)).clamp(0.0, 1.0);
            let delta = k * wl * n;
            p[0] += delta;
            p[1] += delta;
            p[2] += delta;
        }
    }
}

/// Apply grain anchored to the buffer's own extent — the render-tail
/// entry, where the buffer IS the full render.
pub fn apply(img: &mut Image, amount: f32, size: f32, roughness: f32) {
    let full = (img.width, img.height);
    apply_windowed(img, amount, size, roughness, (0, 0), full);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image::{ColorSpace, Image};

    fn grey_display(w: u32, h: u32, v: f32) -> Image {
        let mut img = Image::new(w, h, ColorSpace::DisplayLinearRec2020);
        for p in &mut img.pixels {
            *p = [v, v, v];
        }
        img
    }

    /// amount = 0 is a bit-identical no-op (the baseline guarantee).
    #[test]
    fn zero_amount_is_bit_identical() {
        let mut img = grey_display(32, 24, 0.5);
        let before = img.pixels.clone();
        apply(&mut img, 0.0, 60.0, 80.0);
        assert_eq!(img.pixels, before);
    }

    /// Fully deterministic: two runs over the same input are bit-identical
    /// (fixed SEED, no RNG anywhere).
    #[test]
    fn deterministic_across_runs() {
        let mut a = grey_display(64, 48, 0.5);
        let mut b = grey_display(64, 48, 0.5);
        apply(&mut a, 70.0, 30.0, 50.0);
        apply(&mut b, 70.0, 30.0, 50.0);
        assert_eq!(a.pixels, b.pixels);
    }

    /// Per-pixel closed form: the output equals input + K·amount/100·w(Yd)·n
    /// with `n` from [`grain_noise`] — the noise field is a pure function,
    /// so the "predicted" value is exact, not statistical.
    #[test]
    fn per_pixel_matches_formula() {
        let (w, h) = (40u32, 30u32);
        let v = 0.5f32; // Yd = 0.5 ⇒ w(Yd) = 1.0 exactly
        let mut img = grey_display(w, h, v);
        apply(&mut img, 100.0, 25.0, 50.0);
        let (k, inv_pitch, rho) = grain_params(100.0, 25.0, 50.0, w.max(h));
        for &(x, y) in &[(0u32, 0u32), (20, 15), (39, 29), (7, 22)] {
            let n = grain_noise(x, y, inv_pitch, rho);
            let wl = (4.0 * v * (1.0 - v)).clamp(0.0, 1.0);
            let expected = v + k * wl * n;
            let got = img.pixels[(y * w + x) as usize];
            for c in 0..3 {
                assert!(
                    (got[c] - expected).abs() < 1e-6,
                    "grain at ({x},{y}) chan {c}: got {}, formula {expected}",
                    got[c]
                );
            }
        }
    }

    /// Monochromatic: the same noise value lands on all three channels, so
    /// a neutral input stays exactly neutral (R = G = B per pixel).
    #[test]
    fn monochromatic_preserves_neutrality() {
        let mut img = grey_display(64, 64, 0.4);
        apply(&mut img, 100.0, 40.0, 100.0);
        for (i, p) in img.pixels.iter().enumerate() {
            assert_eq!(p[0], p[1], "R != G at {i}");
            assert_eq!(p[1], p[2], "G != B at {i}");
        }
    }

    /// Mean preservation (zero-mean noise): the spatial mean of a grey
    /// card moves by less than 3σ of the sample-mean estimate. With
    /// |n| ≤ 1, per-pixel σ ≤ ~0.35·K — over 128² pixels the sample mean
    /// sits within ~1.7e-4 at 3σ; assert a slightly looser 1e-3 (lattice
    /// values are spatially correlated below the pitch, shrinking the
    /// effective sample count).
    #[test]
    fn mean_preserved_on_grey() {
        let (w, h) = (128u32, 128u32);
        let v = 0.5f32;
        let mut img = grey_display(w, h, v);
        apply(&mut img, 100.0, 25.0, 50.0);
        let mean: f64 = img.pixels.iter().map(|p| p[1] as f64).sum::<f64>() / (w as f64 * h as f64);
        assert!(
            (mean - v as f64).abs() < 1e-3,
            "grain must be mean-preserving: mean {mean} vs {v}"
        );
    }

    /// Predicted standard deviation: the measured per-pixel deviation
    /// equals the deviation of the deterministic noise field itself,
    /// scaled by K·w(Yd) — exact because the field is a pure function.
    #[test]
    fn std_dev_matches_field() {
        let (w, h) = (96u32, 96u32);
        let v = 0.5f32;
        let mut img = grey_display(w, h, v);
        apply(&mut img, 80.0, 30.0, 60.0);
        let (k, inv_pitch, rho) = grain_params(80.0, 30.0, 60.0, w.max(h));
        let wl = (4.0 * v * (1.0 - v)).clamp(0.0, 1.0);

        let mut var_out = 0.0f64;
        let mut var_field = 0.0f64;
        for y in 0..h {
            for x in 0..w {
                let d_out = (img.pixels[(y * w + x) as usize][1] - v) as f64;
                let d_field = (k * wl * grain_noise(x, y, inv_pitch, rho)) as f64;
                var_out += d_out * d_out;
                var_field += d_field * d_field;
            }
        }
        let n = (w * h) as f64;
        let (std_out, std_field) = ((var_out / n).sqrt(), (var_field / n).sqrt());
        assert!(
            (std_out - std_field).abs() < 1e-6,
            "measured std {std_out} != field std {std_field}"
        );
        assert!(
            std_out > 1e-3,
            "grain at amount 80 must produce visible deviation"
        );
    }

    /// Luminance weighting fades grain in deep blacks and near white:
    /// the deviation at Yd = 0.02 / 0.98 is far below the Yd = 0.5 one,
    /// and exactly zero at Yd = 0 / 1.
    #[test]
    fn luminance_weight_fades_at_extremes() {
        let std_at = |v: f32| {
            let (w, h) = (64u32, 64u32);
            let mut img = grey_display(w, h, v);
            apply(&mut img, 100.0, 25.0, 50.0);
            let mut var = 0.0f64;
            for p in &img.pixels {
                var += ((p[1] - v) as f64).powi(2);
            }
            (var / (w * h) as f64).sqrt()
        };
        let mid = std_at(0.5);
        assert!(std_at(0.02) < mid * 0.2, "deep blacks must fade grain");
        assert!(std_at(0.98) < mid * 0.2, "near-white must fade grain");
        assert_eq!(std_at(0.0), 0.0, "Yd = 0 must see exactly zero grain");
        // At v = 1.0 the f32 Rec.2020 luma dot lands within one ulp of 1
        // (the three weights don't sum to exactly 1.0 in f32), so w(Yd) is
        // ~2e-7 rather than a hard 0 — assert the residual is negligible.
        assert!(
            std_at(1.0) < 1e-6,
            "Yd = 1 must see (numerically) zero grain"
        );
    }

    /// Tile safety: a windowed render reproduces the full-frame field
    /// exactly (absolute coordinates + full-dims pitch).
    #[test]
    fn windowed_matches_full_render() {
        let (w, h) = (48u32, 36u32);
        let mut full = grey_display(w, h, 0.5);
        apply(&mut full, 70.0, 40.0, 30.0);

        let (tx, ty, tw, th) = (24u32, 12u32, 16u32, 12u32);
        let mut tile = grey_display(tw, th, 0.5);
        apply_windowed(&mut tile, 70.0, 40.0, 30.0, (tx, ty), (w, h));
        for y in 0..th {
            for x in 0..tw {
                let t = tile.pixels[(y * tw + x) as usize];
                let f = full.pixels[((ty + y) * w + (tx + x)) as usize];
                assert_eq!(t, f, "tile pixel ({x},{y}) diverges from full render");
            }
        }
    }

    /// The statistical resolution contract: a half-size render is NOT a
    /// pointwise downsample of the full-size grain, but its amplitude
    /// (std-dev) agrees within a loose statistical band — pitch scales
    /// with the long edge, so apparent grain size is stable.
    #[test]
    fn resolution_parity_is_statistical() {
        let std_for = |edge: u32| {
            let mut img = grey_display(edge, edge, 0.5);
            apply(&mut img, 100.0, 50.0, 50.0);
            let mut var = 0.0f64;
            for p in &img.pixels {
                var += ((p[1] - 0.5) as f64).powi(2);
            }
            (var / (edge as f64 * edge as f64)).sqrt()
        };
        let full = std_for(256);
        let half = std_for(128);
        assert!(
            (full - half).abs() / full < 0.15,
            "amplitude must be resolution-stable (statistical): {full} vs {half}"
        );
    }

    /// Larger size = coarser grain: with the same amount, the noise field
    /// at size 100 has more spatial correlation (fewer sign changes per
    /// row) than at size 0. The buffer's long edge sits at the 2000-px
    /// pitch reference so the size sweep spans ~1 px → ~6 px (a small test
    /// buffer would alias both ends to sub-pixel white noise — the pitch
    /// is deliberately resolution-relative).
    #[test]
    fn size_controls_pitch() {
        let sign_changes = |size: f32| {
            let (w, h) = (2000u32, 4u32);
            let mut img = grey_display(w, h, 0.5);
            apply(&mut img, 100.0, size, 0.0);
            let mut changes = 0u32;
            for y in 0..h {
                for x in 1..w {
                    let a = img.pixels[(y * w + x - 1) as usize][1] - 0.5;
                    let b = img.pixels[(y * w + x) as usize][1] - 0.5;
                    if (a > 0.0) != (b > 0.0) {
                        changes += 1;
                    }
                }
            }
            changes
        };
        let fine = sign_changes(0.0);
        let coarse = sign_changes(100.0);
        assert!(
            coarse * 2 < fine,
            "size 100 must be markedly coarser: {coarse} sign changes vs {fine}"
        );
    }
}
