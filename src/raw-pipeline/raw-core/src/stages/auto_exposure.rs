//! Histogram-shape per-image auto-exposure.
//!
//! Ported from the sibling reference repo's `raw-core::auto_exposure`
//! (`/Users/riabuz/Projects/Maple/src/raw-pipeline/crates/raw-core/src/auto_exposure.rs`,
//! itself derived from RawTherapee's `getAutoExp` / `getAutoExpHistogram`).
//!
//! # Why this exists
//! The Maple AgX retune (commit a730f2d) lowered mid-gray ~0.65 EV vs
//! canonical Blender 4.x AgX. We previously compensated with a global
//! `MAPLE_AGX_BASELINE_COMPENSATION_EV = 0.65` constant in `decode.rs`,
//! which fixed the average bias but not the per-image variance: the
//! `calibrate_color_pipeline.sh` harness showed test_0001 slightly too
//! bright while test_0010 / test_0013 stayed dark because their per-camera
//! DCP gap dominates.
//!
//! This module replaces that constant with a histogram-shape auto-exposure:
//! sample the actual scene-linear distribution post-DCP, fit a per-image
//! gain that lands the mean / median / top of the histogram near canonical
//! mid-gray and clipping points, return EV. Per-image, deterministic,
//! pure math.
//!
//! # Adaptations from the reference port
//! * Reference operates on a `DemosaicedImage { pixels: Vec<f32> }` (interleaved
//!   camera-RGB, [0,1]). We operate on `crate::image::Image` in
//!   `ColorSpace::SceneLinearRec2020` (`pixels: Vec<[f32; 3]>`, unbounded f32),
//!   which is the post-DCP / pre-tone-controls surface in the `_Maple`
//!   pipeline. Scene-linear Rec.2020 is already chromatically adapted so the
//!   luminance histogram is meaningful for "this scene" rather than
//!   sensor-native + WB-multiplier intermediate space.
//! * Luma weights: Rec.2020 (0.2627, 0.6780, 0.0593), not Rec.709, to match
//!   the working color space.
//! * Histogram bin scaling: scene-linear values can exceed 1.0 (specular
//!   highlights post-DCP). We clamp the bin index, which is how the
//!   reference behaves anyway via the `clamp(0, BINS - 1)` step.
//! * The raw-CFA path (`build_luma_histogram_from_raw`) is included for
//!   completeness. It derives WB multipliers from `RawImage::as_shot_neutral`
//!   (which `_Maple` stores as the camera reading per DNG spec) by
//!   inverting and G-normalizing. The pipeline does NOT use this path
//!   today — it uses the post-DCP `auto_exposure_from_image` path — but
//!   the raw path is reference-faithful and unit-tested.

use crate::image::{ColorSpace, Image, RawImage};

/// Outputs of `compute_auto_exposure`. Names mirror the engine.
///
/// Today the pipeline consumes only `expcomp`. The other fields (black,
/// bright, contr, hlcompr, hlcomprthresh) are populated for reference
/// fidelity and will become live when the tone-curve / black-point stages
/// land — they're cheap to compute alongside `expcomp`.
#[derive(Clone, Copy, Debug, Default)]
pub struct AutoExposure {
    /// Exposure compensation in EV. Clamped to [-5, 12] by the engine.
    pub expcomp: f32,
    /// Black-point in the 16-bit scale the engine uses. Divide by 65535
    /// for normalized [0, 1] linear.
    pub black: i32,
    /// Brightness slider, [-100, 100].
    pub bright: i32,
    /// Contrast slider, [0, 100].
    pub contr: i32,
    /// Highlight-compression amount [0, 100].
    pub hlcompr: i32,
    /// Threshold below which `hlcompr` has no effect [0, 100].
    pub hlcomprthresh: i32,
}

// Engine constants — held in the reference verbatim.
const SCALE: f32 = 65536.0;
/// Linear-gamma middle grey (Adobe convention).
const MIDGRAY: f32 = 0.1842;
/// Histogram compression: 65536 >> 3 = 8192 bins.
const HISTCOMPR: u32 = 3;

/// Rec.2020 luma weights — match the working color space of the post-DCP
/// `Image` we sample (see `crate::stages::scene_tone_controls::LUMA_REC2020`).
const LUMA_REC2020: [f32; 3] = [0.2627, 0.6780, 0.0593];

/// Build an 8192-bin luminance histogram from a scene-linear Rec.2020
/// image. Bin index ≈ `linear_value * 8192`, clamped to [0, 8191].
///
/// Scene-linear values can legitimately exceed 1.0 (specular highlights);
/// those land in the top bin, which the percentile / mean math treats as
/// "bright clip" — exactly the behaviour the reference's
/// `compute_auto_exposure` expects.
pub fn build_luma_histogram(image: &Image) -> Vec<u32> {
    const BINS: usize = 1 << (16 - HISTCOMPR); // 8192
    let mut hist = vec![0_u32; BINS];
    for px in &image.pixels {
        let y = LUMA_REC2020[0] * px[0] + LUMA_REC2020[1] * px[1] + LUMA_REC2020[2] * px[2];
        let bin = (y * BINS as f32).clamp(0.0, BINS as f32 - 1.0) as usize;
        hist[bin] += 1;
    }
    hist
}

/// Auto-exposure from an 8192-bin histogram. `clip` is the percent of
/// pixels allowed to clip at black/white (the engine default = 0.02).
///
/// 1:1 port of the reference's `compute_auto_exposure`. Two-pass octile
/// accumulator → log-spread weighting → per-image expcomp / brightness /
/// contrast. See doc comment on the reference for the algorithm origin
/// (RawTherapee `rtengine::Color::auto_exposure`).
pub fn compute_auto_exposure(histogram: &[u32], clip: f32) -> AutoExposure {
    let histcompr = HISTCOMPR as i32;
    let imax = 65536 >> histcompr; // 8192
    debug_assert!(
        histogram.len() >= imax as usize,
        "histogram must be ≥ {imax} bins, got {}",
        histogram.len()
    );

    // Sum and weighted average.
    let mut sum: u64 = 0;
    let mut weighted: f64 = 0.0;
    for (i, &h) in histogram.iter().take(imax as usize).enumerate() {
        sum += h as u64;
        weighted += h as f64 * i as f64;
    }
    let sum_f = sum as f32;
    if sum == 0 {
        return AutoExposure::default();
    }
    let ave = (weighted / sum as f64) as f32;

    // Median.
    let mut cum: u64 = histogram[0] as u64;
    let half = sum / 2;
    let mut median: i32 = 0;
    while cum < half {
        median += 1;
        if median as usize >= histogram.len() {
            break;
        }
        cum += histogram[median as usize] as u64;
    }

    if median == 0 || ave < 1.0 {
        // Black-frame detection.
        return AutoExposure::default();
    }

    // Compute octiles (log2 positions of the 1/8, 2/8, ... cumulative
    // thresholds). Two-pass accumulator.
    let mut octile = [0.0_f32; 8];
    let mut count: usize = 0;
    let mut losum = 0.0_f32;
    let mut hisum = 0.0_f32;

    let mut j = 0_i32;
    let ave_i = (ave as i32).min(imax);
    while j < ave_i {
        if count < 8 {
            octile[count] += histogram[j as usize] as f32;
            if octile[count] > sum_f / 8.0 || (count == 7 && octile[count] > sum_f / 16.0) {
                octile[count] = (1.0 + j as f32).ln() / 2.0_f32.ln();
                count += 1;
            }
        }
        losum += histogram[j as usize] as f32;
        j += 1;
    }
    while j < imax {
        if count < 8 {
            octile[count] += histogram[j as usize] as f32;
            if octile[count] > sum_f / 8.0 || (count == 7 && octile[count] > sum_f / 16.0) {
                octile[count] = (1.0 + j as f32).ln() / 2.0_f32.ln();
                count += 1;
            }
        }
        hisum += histogram[j as usize] as f32;
        j += 1;
    }

    if losum == 0.0 || hisum == 0.0 {
        return AutoExposure::default();
    }

    let log1p_imax = ((imax as f32) + 1.0).ln() / 2.0_f32.ln();
    let mut overex = 0;
    if octile[6] > log1p_imax {
        octile[6] = 1.5 * octile[5] - 0.5 * octile[4];
        overex = 2;
    }
    if octile[7] > log1p_imax {
        octile[7] = 1.5 * octile[6] - 0.5 * octile[5];
        overex = 1;
    }
    let oct6 = octile[6];
    let oct7 = octile[7];

    // Fill any remaining unfilled octile by propagating the previous one.
    for i in 1..8 {
        if octile[i] == 0.0 {
            octile[i] = octile[i - 1];
        }
    }

    // Weighted octile spread → contrast setting.
    let mut ospread = 0.0_f32;
    for i in 1..6 {
        let denom = if i > 2 {
            octile[i + 1] - octile[3]
        } else {
            octile[3] - octile[i]
        };
        ospread += (octile[i + 1] - octile[i]) / denom.max(0.5);
    }
    ospread /= 5.0;

    if ospread <= 0.0 {
        return AutoExposure::default();
    }

    // Find rawmax: the last bin with content (walking down from the top).
    let mut rawmax = imax - 1;
    let mut clipped: u64 = 0;
    while rawmax > 1 && histogram[rawmax as usize] as u64 + clipped == 0 {
        clipped += histogram[rawmax as usize] as u64;
        rawmax -= 1;
    }

    // White clip: walk down until cumulative clipped-away bins exceeds
    // `clippable`.
    let clippable = (sum_f as f64 * clip as f64 / 100.0) as u64;
    let mut whiteclip = imax - 1;
    let mut clipped: u64 = 0;
    while whiteclip > 1 && (histogram[whiteclip as usize] as u64 + clipped) <= clippable {
        clipped += histogram[whiteclip as usize] as u64;
        whiteclip -= 1;
    }

    // Black clip: walk up from bin 0 until `clippable` pixels covered.
    let mut shc: i32 = 0;
    let mut clipped: u64 = 0;
    while shc < whiteclip - 1 && histogram[shc as usize] as u64 + clipped <= clippable {
        clipped += histogram[shc as usize] as u64;
        shc += 1;
    }

    // Rescale to the 65535 domain.
    let rawmax = (rawmax << histcompr) as f32;
    let whiteclip_u = (whiteclip << histcompr) as f32;
    let ave_u = ave * (1 << histcompr) as f32;
    let median_u = (median << histcompr) as f32;
    let shc_u = (shc << histcompr) as f32;

    // expcomp1: gain that sets mean to midgrey.
    let expcomp1 = (MIDGRAY * SCALE / (ave_u - shc_u + MIDGRAY * shc_u)).ln() / 2.0_f32.ln();
    // expcomp2: gain that puts the top of the histogram near clipping.
    let expcomp2 = if overex == 0 {
        0.5 * ((15.5 - histcompr as f32 - (2.0 * oct7 - oct6))
            + (SCALE / rawmax).ln() / 2.0_f32.ln())
    } else {
        0.5 * ((15.5 - histcompr as f32 - (2.0 * octile[7] - octile[6]))
            + (SCALE / rawmax).ln() / 2.0_f32.ln())
    };

    let expcomp = if (expcomp1.abs() - expcomp2.abs()).abs() > 1.0
        && expcomp1.abs() + expcomp2.abs() > 0.0
    {
        (expcomp1 * expcomp2.abs() + expcomp2 * expcomp1.abs())
            / (expcomp1.abs() + expcomp2.abs())
    } else {
        0.5 * expcomp1 + 0.5 * expcomp2
    };

    let gain = (expcomp * 2.0_f32.ln()).exp();
    let corr = (gain * SCALE / rawmax).sqrt();
    let black_linear = shc_u * corr;

    // Highlight compression.
    let comp = (gain * whiteclip_u / SCALE - 1.0) * 2.3;
    let hlcompr_raw = 100.0 * comp as f64 / (expcomp.max(0.0) as f64 + 1.0);
    let hlcompr = hlcompr_raw.round().clamp(0.0, 100.0) as i32;

    // Brightness.
    let midtmp = gain * (median_u * ave_u).sqrt() / SCALE;
    let bright_f = if midtmp < 0.1 {
        (MIDGRAY - midtmp) * 15.0 / midtmp
    } else {
        (MIDGRAY - midtmp) * 15.0 / (0.10833 - 0.0833 * midtmp)
    };
    let bright = (0.25 * bright_f.max(0.0)).round().clamp(-100.0, 100.0) as i32;

    // Contrast.
    let contr = (50.0 * (1.1 - ospread)).round().clamp(0.0, 100.0) as i32;

    // Final expcomp clamp matches the engine.
    let expcomp = expcomp.clamp(-5.0, 12.0);

    AutoExposure {
        expcomp,
        black: black_linear.round() as i32,
        bright,
        contr,
        hlcompr,
        hlcomprthresh: 0,
    }
}

/// Convenience: histogram + compute in one call. Sampling input must be
/// in `ColorSpace::SceneLinearRec2020` (panics in debug otherwise).
pub fn auto_exposure_from_image(image: &Image, clip: f32) -> AutoExposure {
    image.assert_space(ColorSpace::SceneLinearRec2020);
    let hist = build_luma_histogram(image);
    compute_auto_exposure(&hist, clip)
}

/// Apply the auto-exposure gain to a scene-linear image in place. This is
/// the wired-into-pipeline entry: per-pixel `* exp2(expcomp)` on a
/// `SceneLinearRec2020` `Image`. Composes additively in EV with downstream
/// `scene_tone_controls::apply` (the user's exposure slider).
///
/// `clip` is the percent of pixels allowed to clip at black/white. We use
/// the engine default (0.02) at the pipeline call site.
pub fn apply(image: &mut Image, clip: f32) -> AutoExposure {
    image.assert_space(ColorSpace::SceneLinearRec2020);
    let ae = auto_exposure_from_image(image, clip);
    if ae.expcomp.abs() > 1e-6 {
        let gain = ae.expcomp.exp2();
        for p in &mut image.pixels {
            p[0] *= gain;
            p[1] *= gain;
            p[2] *= gain;
        }
    }
    ae
}

/// 1:1 port of `rawimagesource.cc::RawImageSource::getAutoExpHistogram`
/// (Bayer branch). Builds the 8192-bin AE histogram from the **raw CFA
/// mosaic** with `refwb` pre-multipliers — the way the engine feeds
/// `getAutoExp`. Each Bayer cell counts as 4 to compensate for the 2×2
/// mosaic block representing one RGB pixel (matches the engine's `+= 4`).
///
/// `_Maple`'s `RawImage::as_shot_neutral` carries the DNG-spec **reading**
/// (G-normalized to 1) per `decode::decode_bytes` line 247-259. Multipliers
/// (the engine's `wb_coeffs` convention) are the reciprocal: `1 / reading`.
/// We invert here so the engine math is identical bin-for-bin to the
/// reference.
///
/// NOTE: this path is NOT wired into the pipeline today. The post-DCP
/// path (`auto_exposure_from_image`) is more representative for `_Maple`
/// because (a) the post-DCP image is already chromatically adapted to the
/// scene illuminant, and (b) `_Maple` stores `black_level: [u32; 4]` per
/// CFA position rather than a single u16 like the reference, which would
/// require additional adaptation here. Kept for completeness and for
/// future use if a "render auto-exposure before DCP" path becomes
/// desirable.
///
/// Returns: a `Vec<u32>` of length 8192. Feed into `compute_auto_exposure`.
pub fn build_luma_histogram_from_raw(raw: &RawImage) -> Vec<u32> {
    use crate::image::CfaPattern;
    const HISTCOMPR: u32 = 3;
    const BINS: usize = 1 << (16 - HISTCOMPR); // 8192
    let bin_scale = 1u32 << HISTCOMPR; // 8 — divides incoming 16-bit raw down to 8192 bins
    let mut hist = vec![0_u32; BINS];

    let w = raw.width as usize;
    let h = raw.height as usize;

    // `_Maple` stores AsShotNeutral as the camera *reading* (G-normalized).
    // The engine's `refwb` convention is multipliers (= 1 / reading,
    // G-normalized). Invert here, then pre-scale by `1 << histcompr` so the
    // bin index falls in range without an extra multiply per pixel.
    let nr = raw.as_shot_neutral;
    // Guard against zero. as_shot_neutral is sanitized at decode time so
    // this should never trigger, but a 1.0 fallback is the WB-neutral path.
    let mults = if nr[0] > 0.0 && nr[2] > 0.0 {
        [1.0 / nr[0], 1.0 / nr[1], 1.0 / nr[2]]
    } else {
        [1.0, 1.0, 1.0]
    };
    let refwb = [
        mults[0] / bin_scale as f32,
        mults[1] / bin_scale as f32,
        mults[2] / bin_scale as f32,
    ];

    // Use the smallest per-CFA-position black level as the floor. `_Maple`
    // stores per-position black levels; the reference uses a single u16.
    // Min is conservative (we never under-subtract; minor over-subtraction
    // on positions with a slightly higher floor lands inside the black
    // clip the engine's `shc` pass already absorbs).
    let black = (raw.black_level[0]
        .min(raw.black_level[1])
        .min(raw.black_level[2])
        .min(raw.black_level[3])) as u16;

    let cfa_color = |x: usize, y: usize| -> usize {
        let xy = (y & 1) * 2 + (x & 1);
        match raw.cfa {
            CfaPattern::Rggb => [0, 1, 1, 2][xy],
            CfaPattern::Bggr => [2, 1, 1, 0][xy],
            CfaPattern::Grbg => [1, 0, 2, 1][xy],
            CfaPattern::Gbrg => [1, 2, 0, 1][xy],
            CfaPattern::LinearRgb => 1, // shouldn't be called; default to G
        }
    };

    // LinearRgb DNGs carry interleaved RGB, not a Bayer mosaic — the raw
    // path doesn't make sense. Fall back to an empty histogram; callers
    // should use the post-DCP path for those fixtures.
    if matches!(raw.cfa, CfaPattern::LinearRgb) {
        return hist;
    }

    for y in 0..h {
        // Pre-load refwb pattern for the row so the inner loop skips per-
        // pixel CFA dispatch. The colour pattern repeats every 2 columns.
        let refwb_a = refwb[cfa_color(0, y)];
        let refwb_b = refwb[cfa_color(1, y)];
        let row_off = y * w;
        let mut x = 0;
        while x + 1 < w {
            let v0 = raw.raw_data[row_off + x].saturating_sub(black) as f32 * refwb_a;
            let v1 = raw.raw_data[row_off + x + 1].saturating_sub(black) as f32 * refwb_b;
            let bin0 = (v0 as i32).clamp(0, BINS as i32 - 1) as usize;
            let bin1 = (v1 as i32).clamp(0, BINS as i32 - 1) as usize;
            hist[bin0] += 4;
            hist[bin1] += 4;
            x += 2;
        }
        if x < w {
            let v = raw.raw_data[row_off + x].saturating_sub(black) as f32 * refwb_a;
            let bin = (v as i32).clamp(0, BINS as i32 - 1) as usize;
            hist[bin] += 4;
        }
    }

    hist
}

/// Convenience: raw-CFA histogram + AE compute in one call. Reference-
/// faithful path. Not used by the pipeline today — see
/// `build_luma_histogram_from_raw` for context.
pub fn auto_exposure_from_raw(raw: &RawImage, clip: f32) -> AutoExposure {
    let hist = build_luma_histogram_from_raw(raw);
    compute_auto_exposure(&hist, clip)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build_image(w: u32, h: u32, f: impl Fn(u32, u32) -> [f32; 3]) -> Image {
        let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
        for y in 0..h {
            for x in 0..w {
                img.pixels[(y * w + x) as usize] = f(x, y);
            }
        }
        img
    }

    #[test]
    fn black_frame_returns_zero_exposure() {
        let img = build_image(32, 32, |_, _| [0.0, 0.0, 0.0]);
        let ae = auto_exposure_from_image(&img, 0.02);
        assert_eq!(ae.expcomp, 0.0);
        assert_eq!(ae.black, 0);
    }

    #[test]
    fn mid_grey_needs_no_exposure() {
        // 18% grey frame — should already land near midgrey.
        let img = build_image(64, 64, |_, _| [0.18, 0.18, 0.18]);
        let ae = auto_exposure_from_image(&img, 0.02);
        assert!(
            ae.expcomp.abs() < 1.0,
            "mid-grey got expcomp = {}",
            ae.expcomp
        );
    }

    #[test]
    fn dark_image_gets_positive_exposure() {
        // Underexposed scene with realistic variance: ramp from 0 to 5%.
        // Uniform images hit the ospread≤0 blackframe bail-out.
        let img = build_image(128, 128, |x, _| {
            let v = (x as f32 / 127.0) * 0.05;
            [v, v, v]
        });
        let ae = auto_exposure_from_image(&img, 0.02);
        assert!(
            ae.expcomp > 0.5,
            "dark image got expcomp = {}",
            ae.expcomp
        );
    }

    #[test]
    fn bright_image_gets_negative_exposure() {
        // Overexposed scene: 50%..95% ramp.
        let img = build_image(128, 128, |x, _| {
            let v = 0.5 + (x as f32 / 127.0) * 0.45;
            [v, v, v]
        });
        let ae = auto_exposure_from_image(&img, 0.02);
        assert!(
            ae.expcomp < 0.0,
            "bright image got expcomp = {}",
            ae.expcomp
        );
    }

    #[test]
    fn expcomp_clamped() {
        // Near-black frame: expcomp must be in [-5, 12].
        let img = build_image(64, 64, |_, _| [0.001, 0.001, 0.001]);
        let ae = auto_exposure_from_image(&img, 0.02);
        assert!((-5.0..=12.0).contains(&ae.expcomp));
    }

    #[test]
    fn apply_is_deterministic() {
        // Same input → same output, byte for byte.
        let make = || build_image(96, 96, |x, y| {
            let v = ((x + y) as f32 / 191.0) * 0.4;
            [v, v * 0.9, v * 1.1]
        });
        let mut a = make();
        let mut b = make();
        let ae_a = apply(&mut a, 0.02);
        let ae_b = apply(&mut b, 0.02);
        assert_eq!(ae_a.expcomp.to_bits(), ae_b.expcomp.to_bits());
        for (pa, pb) in a.pixels.iter().zip(b.pixels.iter()) {
            for c in 0..3 {
                assert_eq!(pa[c].to_bits(), pb[c].to_bits(),
                    "non-deterministic at channel {c}: {} vs {}", pa[c], pb[c]);
            }
        }
    }

    #[test]
    fn apply_zero_expcomp_is_identity() {
        // A near-mid-grey frame should yield expcomp ≈ 0, leaving pixels
        // bit-identical (or off by at most 1 ULP). Verifies the early-exit
        // path skips the multiply when |expcomp| < 1e-6.
        let mut img = build_image(64, 64, |x, _| {
            // Distribution centred on midgrey with mild variance to avoid
            // the blackframe / ospread guards.
            let v = 0.18 + (x as f32 / 63.0 - 0.5) * 0.04;
            [v, v, v]
        });
        let original = img.pixels.clone();
        let ae = apply(&mut img, 0.02);
        if ae.expcomp.abs() < 1e-6 {
            for (pa, pb) in img.pixels.iter().zip(original.iter()) {
                assert_eq!(pa, pb, "expected exact identity when expcomp ~= 0");
            }
        }
    }
}
