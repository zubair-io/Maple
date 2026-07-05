//! 8-band HSL hue/saturation/luminance stage (#1112, tone/zoom design § 10.4).
//!
//! Scene-linear stage computed in Oklab, positioned adjacent to the
//! existing vibrance/saturation block. Uses a **raised-cosine partition of
//! unity** over 8 ACR-aligned hue centers (Red, Orange, Yellow, Green,
//! Aqua, Blue, Purple, Magenta) — circular in hue, so bands wrap across
//! the ±180° boundary. The 8 Oklab hue centers are non-uniformly spaced,
//! so a fixed 67.5° half-width (see `BAND_HALF_WIDTH_DEG`) is used and
//! partition-of-unity is achieved via per-pixel weight normalization
//! (each band weight divided by the sum across all 8 bands). Each band
//! weight is chroma-gated: hard early-return for C < C0, then
//! `smoothstep(C0, 2·C0, C)` for a smooth onset. The neutral axis is
//! **exactly stable** — near-neutrals pass through bit-for-bit. The three
//! channels (Hue, Saturation, Luminance) act independently on the armed
//! band's contribution:
//!
//! - **Hue:** rotates the Oklab hue angle by `slider/100 · HSL_HUE_MAX_RAD`
//!   radians.
//! - **Saturation:** scales the Oklab chroma `C` by `1 + slider/100`.
//! - **Luminance:** scales the Oklab `L` component by `1 + slider/100 · w`
//!   (an Oklab-L scale, not a uniform RGB multiply — hue and chroma are
//!   preserved in Oklab space).
//!
//! All-defaults = bit-identical no-op (the whole-stage short-circuit at the
//! top of `apply` guards this). A pure point op — tile-safe with register
//! radius 0.
//!
//! ## Band centers (Oklab hue angle, degrees)
//!
//! ACR's 8 bands mapped to approximate Oklab hue angles. The mapping is
//! deliberately a well-defined constant (not fit against any dataset at
//! this stage — see `HSL_HUE_MAX_DEG` comment for pending calibration):
//!
//! | Band    | ACR center | Oklab center |
//! |---------|-----------|--------------|
//! | Red     |   0° (±30°)| see `HUE_CENTERS_DEG` |
//! | Orange  |  30°       |              |
//! | Yellow  |  60°       |              |
//! | Green   |  120°      |              |
//! | Aqua    |  180°      |              |
//! | Blue    |  240°      |              |
//! | Purple  |  270°      |              |
//! | Magenta |  300°      |              |
//!
//! The 8 centers in Oklab hue space are approximated from CIE Oklab
//! primary hue angles (red ≈ 29°, orange ≈ 55°, yellow ≈ 110°,
//! green ≈ 145°, aqua ≈ 195°, blue ≈ 250°, purple ≈ 285°,
//! magenta ≈ 328°) — see `HUE_CENTERS_DEG`. These produce visually
//! correct band targets for typical camera gamut; ACR-calibrated
//! refinement is tracked as a follow-up.

use crate::color::oklab::{oklab_to_rec2020, rec2020_to_oklab};
use crate::image::{ColorSpace, Image};

// ── Band centers ─────────────────────────────────────────────────────────────

/// Number of HSL bands (ACR: Red, Orange, Yellow, Green, Aqua, Blue,
/// Purple, Magenta — indexed 0..7 in that order).
pub const NUM_BANDS: usize = 8;

/// Oklab hue centers for the 8 ACR-aligned bands, in degrees [0, 360).
/// These are initial approximations from primary hue geometry; a full
/// ACR-calibrated fit (slider-matrix reference renders) is deferred to
/// the post-ACR-render milestone. The constants are `pub` so the WGSL
/// host transcription can use the same values.
///
/// Order: Red(0), Orange(1), Yellow(2), Green(3),
///        Aqua(4), Blue(5), Purple(6), Magenta(7).
pub const HUE_CENTERS_DEG: [f32; NUM_BANDS] = [
    29.0,  // Red
    55.0,  // Orange
    110.0, // Yellow
    145.0, // Green
    195.0, // Aqua
    250.0, // Blue
    285.0, // Purple
    328.0, // Magenta
];

/// Raised-cosine half-width per band (degrees). Because the 8 ACR-aligned
/// Oklab hue centers are **not** uniformly spaced, a fixed half-width alone
/// cannot give exact partition of unity — the band weights are normalized at
/// the per-pixel level (each weight divided by the total across all 8 bands).
/// Half-width = 67.5° (1.5× the uniform spacing of 45°) keeps each band's
/// influence local (typically ≤ 2–3 contributing bands per pixel) while
/// guaranteeing coverage at every hue with the non-uniform centers.
pub const BAND_HALF_WIDTH_DEG: f32 = 67.5;

/// Chroma threshold below which the band weight fades to zero
/// (smoothstep 0→C0). Below this threshold hue is undefined and all
/// band weights return zero — the neutral-axis stability guarantee.
/// In Oklab chroma units (typical in-gamut range 0..0.4).
pub const CHROMA_GATE_C0: f32 = 0.05;

/// Maximum hue rotation at slider ±100 (in degrees). This is the
/// calibrated target value; ACR uses ±30° at ±100. Pending the full
/// slider-matrix ACR-reference fit, this constant is deliberately marked
/// as provisional.
///
/// **Pending ACR calibration** (tracked in #1112 follow-up): the exact
/// rotation-vs-slider mapping against Adobe ACR reference renders has not
/// yet been measured. ±30° is the class-level ACR design target; refine
/// once per-band reference renders are available.
pub const HSL_HUE_MAX_DEG: f32 = 30.0; // pending ACR calibration

/// `HSL_HUE_MAX_DEG` in radians, the constant the Oklab rotation uses.
pub const HSL_HUE_MAX_RAD: f32 = HSL_HUE_MAX_DEG * std::f32::consts::PI / 180.0;

// ── Raised-cosine band weight ─────────────────────────────────────────────────

/// Raised-cosine weight for angular distance `delta_deg` (circular,
/// already in [0, 180]). Returns `(1 + cos(π·delta/halfwidth)) / 2`
/// for `delta ≤ halfwidth`, else 0.
#[inline]
pub fn raised_cosine_weight(delta_deg: f32, half_width_deg: f32) -> f32 {
    if delta_deg >= half_width_deg {
        return 0.0;
    }
    let t = delta_deg / half_width_deg; // [0, 1]
    0.5 * (1.0 + (std::f32::consts::PI * t).cos())
}

/// Circular angular distance (degrees) in [0, 180], wrapped correctly.
#[inline]
pub fn circular_delta_deg(h: f32, center: f32) -> f32 {
    let mut d = (h - center).abs() % 360.0;
    if d > 180.0 {
        d = 360.0 - d;
    }
    d
}

/// Per-pixel Oklab hue angle in degrees, mapped to [0, 360).
///
/// Returns 0° for exactly neutral (a=0, b=0) — callers must early-return
/// on low-chroma inputs before calling this.
#[inline]
fn oklab_hue_deg(a: f32, b: f32) -> f32 {
    let h = b.atan2(a).to_degrees();
    if h < 0.0 {
        h + 360.0
    } else {
        h
    }
}

// ── Params struct (shared with GPU oracle) ────────────────────────────────────

/// Hoisted per-render parameters for the HSL stage. Computing these once
/// per render (rather than per pixel) is important for performance; the
/// GPU WGSL host transcribes the same values to its uniform buffer.
#[derive(Clone, Copy, Debug)]
pub struct HslParams {
    /// Per-band hue-rotation amount in radians (`slider/100 · HSL_HUE_MAX_RAD`).
    pub hue_rad: [f32; NUM_BANDS],
    /// Per-band saturation scale factor (`1 + slider/100`).
    pub sat_scale: [f32; NUM_BANDS],
    /// Per-band luminance shift (`slider/100`; see note in `apply_pixel`).
    pub lum_shift: [f32; NUM_BANDS],
    /// True when ALL sliders are at default (0) — whole-stage short-circuit.
    pub is_identity: bool,
}

/// Hoist per-render HSL params from the 24 raw slider values.
/// Accepts three contiguous slices `[Red..Magenta]` for hue, sat, lum.
pub fn hsl_params(
    hue: &[f32; NUM_BANDS],
    sat: &[f32; NUM_BANDS],
    lum: &[f32; NUM_BANDS],
) -> HslParams {
    let mut hue_rad = [0.0f32; NUM_BANDS];
    let mut sat_scale = [1.0f32; NUM_BANDS];
    let mut lum_shift = [0.0f32; NUM_BANDS];
    let mut is_identity = true;
    for i in 0..NUM_BANDS {
        if hue[i].abs() >= 1e-3 {
            hue_rad[i] = hue[i] / 100.0 * HSL_HUE_MAX_RAD;
            is_identity = false;
        }
        if sat[i].abs() >= 1e-3 {
            sat_scale[i] = 1.0 + sat[i] / 100.0;
            is_identity = false;
        }
        if lum[i].abs() >= 1e-3 {
            lum_shift[i] = lum[i] / 100.0;
            is_identity = false;
        }
    }
    HslParams {
        hue_rad,
        sat_scale,
        lum_shift,
        is_identity,
    }
}

/// Per-pixel HSL transform in Oklab. Returns the modified RGB pixel.
///
/// 1. Early-return exact identity when C < CHROMA_GATE_C0 (near-neutral axis).
/// 2. Compute raw raised-cosine weight `w_shape[b]` for each of the 8 bands.
/// 3. Normalize: `w[b] = w_shape[b] / sum(w_shape)` — this gives exact
///    partition of unity regardless of (non-uniform) band center spacing.
/// 4. Chroma gate: `w[b] *= smoothstep(C0, 2·C0, C)` — smooth onset above C0.
/// 5. For each band, accumulate: hue rotation, saturation delta, luminance delta.
/// 6. Apply luminance (scale L — hue-preserving).
/// 7. Apply saturation (scale chroma C).
/// 8. Apply hue rotation (rotate Oklab (a, b)).
///
/// The hard cutoff at step 1 ensures the neutral-axis stability guarantee:
/// any color with C < CHROMA_GATE_C0 passes through bit-exactly.
#[inline]
pub fn apply_pixel(rgb: [f32; 3], p: &HslParams) -> [f32; 3] {
    if p.is_identity {
        return rgb;
    }
    let lab = rec2020_to_oklab(rgb);
    let (mut l, a, b) = (lab[0], lab[1], lab[2]);

    let c = (a * a + b * b).sqrt();
    // Hard cutoff: below the smoothstep ramp (C < CHROMA_GATE_C0) the pixel
    // is returned exactly unchanged. This covers the neutral axis (C = 0) and
    // any near-neutral color below the transition threshold.
    if c < CHROMA_GATE_C0 {
        return rgb; // exact identity on near-neutral pixels
    }
    // Chroma-gate scalar: smooth ramp from 0 at C0 to 1 at 2·C0.
    let chroma_gate = smoothstep(CHROMA_GATE_C0, 2.0 * CHROMA_GATE_C0, c);

    let hue = oklab_hue_deg(a, b);
    let a_hat = a / c;
    let b_hat = b / c;

    // Compute raw raised-cosine weights for all 8 bands, then normalize
    // so they sum to 1 (partition of unity, regardless of center spacing).
    let mut w_shape = [0.0f32; NUM_BANDS];
    let mut w_sum = 0.0f32;
    for band in 0..NUM_BANDS {
        let delta_deg = circular_delta_deg(hue, HUE_CENTERS_DEG[band]);
        w_shape[band] = raised_cosine_weight(delta_deg, BAND_HALF_WIDTH_DEG);
        w_sum += w_shape[band];
    }
    // If no band contributes (w_sum ≈ 0), this hue is in a coverage gap —
    // return identity. Should not happen with hw=67.5° and any set of centers,
    // but guard defensively.
    if w_sum < 1e-6 {
        return rgb;
    }
    let w_norm_scale = chroma_gate / w_sum; // chroma_gate · (1/w_sum)

    let mut delta_hue_rad = 0.0f32;
    let mut delta_sat_scale = 0.0f32; // additive component of sat_scale − 1
    let mut delta_lum_shift = 0.0f32;

    for band in 0..NUM_BANDS {
        if w_shape[band] < 1e-6 {
            continue;
        }
        let w = w_shape[band] * w_norm_scale;

        delta_hue_rad += p.hue_rad[band] * w;
        delta_sat_scale += (p.sat_scale[band] - 1.0) * w;
        delta_lum_shift += p.lum_shift[band] * w;
    }

    // Apply luminance (scale L — hue-preserving)
    if delta_lum_shift.abs() > 1e-6 {
        l *= 1.0 + delta_lum_shift;
    }

    // Apply saturation (scale chroma). `.max(0.0)` is an Oklab-chroma floor
    // only — it does NOT guarantee the Rec.2020 round-trip stays
    // non-negative. Full gamut protection (chroma-scale AND hue-rotation
    // cases) is applied below (#1733 audit fix, #1748 review fix),
    // mirroring `saturation::apply_pixel` / `vibrance::apply_pixel`'s
    // soft-knee.
    let c_target = (c * (1.0 + delta_sat_scale)).max(0.0);

    // Apply hue rotation (rotate the target (a, b) by delta_hue_rad). Done
    // on the post-saturation chroma so the gamut check below sees the same
    // final hue the pixel will actually land at.
    let (sin_dh, cos_dh) = delta_hue_rad.sin_cos();
    let hue_hat = |ch: f32| {
        (
            ch * (a_hat * cos_dh - b_hat * sin_dh),
            ch * (a_hat * sin_dh + b_hat * cos_dh),
        )
    };

    // NOTE: hue rotation moves the pixel to a different point on the
    // Rec.2020 hull, whose radius at the *new* hue can be smaller than at
    // the input hue — the hull is not hue-invariant. So even when chroma
    // does not increase (`c_target <= c`), rotation alone can still drive
    // a channel negative; there is no shortcut that skips the gamut check
    // (#1748 review fix — an earlier `c_target <= c` fast-return here was
    // wrong for exactly this reason, confirmed via a hue-only-rotation
    // repro on a near-hull primary).
    //
    // Fast path: scaled target stays in gamut — most pixels are far
    // enough from the hull that this branch wins.
    let (a_fast, b_fast) = hue_hat(c_target);
    let rgb_target = oklab_to_rec2020([l, a_fast, b_fast]);
    if rgb_target[0].min(rgb_target[1]).min(rgb_target[2]) >= -HSL_GAMUT_EPS {
        return rgb_target;
    }

    // Bisect for the hull chroma along the POST-ROTATION hue ray (the ray
    // the pixel actually travels along), then Reinhard-soft-compress into
    // it — identical shape to `saturation::soft_compress` /
    // `vibrance::soft_compress`, single source of the curve would be a
    // 3-way dedup better done when a fourth caller appears (YAGNI).
    //
    // No `.max(c_floor)` here: an earlier version floored `c_out` at the
    // pre-HSL input chroma `c`, meant to avoid pulling saturation below
    // what the user started with. But when hue rotation lands the pixel on
    // a narrower part of the hull (`c_hull < c`), that floor forces
    // `c_out > c_hull`, i.e. deliberately re-emits the negative channel the
    // bisection just solved for. Soft-compression must be allowed to land
    // anywhere in `[0, c_hull]`.
    let (rot_a_hat, rot_b_hat) = hue_hat(1.0);
    let c_hull = hsl_bisect_gamut_hull(l, rot_a_hat, rot_b_hat, c_target);
    let c_out = hsl_soft_compress(c_target, c_hull);
    oklab_to_rec2020([l, rot_a_hat * c_out, rot_b_hat * c_out])
}

/// Tolerance used when deciding whether the bisected chroma is "in gamut" —
/// matches `saturation.rs` / `vibrance.rs`'s `GAMUT_EPS` / literal `-1e-5`.
const HSL_GAMUT_EPS: f32 = 1e-5;

/// Fraction of the per-pixel gamut-hull chroma at which the soft-compression
/// knee starts — matches `saturation::GAMUT_KNEE_FRACTION`.
const HSL_GAMUT_KNEE_FRACTION: f32 = 0.8;

/// Bisection iteration count — matches `saturation::GAMUT_BISECT_ITERS`
/// (24; restored with it from the Jul-1 12-iteration lowering; #1769).
const HSL_GAMUT_BISECT_ITERS: usize = 24;

/// Reinhard-style smooth compression, identical shape to
/// `saturation::soft_compress` / `vibrance::soft_compress`.
#[inline]
fn hsl_soft_compress(c_target: f32, c_hull: f32) -> f32 {
    let c_thresh = HSL_GAMUT_KNEE_FRACTION * c_hull;
    if c_target <= c_thresh {
        return c_target;
    }
    let d = c_target - c_thresh;
    let d_max = c_hull - c_thresh;
    if d_max <= 0.0 {
        return c_hull;
    }
    c_thresh + d_max * (d / (d + d_max))
}

/// Bisect along the (L, a_hat, b_hat) ray in Oklab for the largest chroma
/// whose Rec.2020 projection has all channels >= -HSL_GAMUT_EPS. Identical
/// shape to `saturation::bisect_gamut_hull` / `vibrance::bisect_gamut_hull`.
#[inline]
fn hsl_bisect_gamut_hull(l: f32, a_hat: f32, b_hat: f32, c_high: f32) -> f32 {
    let mut lo = 0.0f32;
    let mut hi = c_high;
    for _ in 0..HSL_GAMUT_BISECT_ITERS {
        let mid = 0.5 * (lo + hi);
        let rgb = oklab_to_rec2020([l, a_hat * mid, b_hat * mid]);
        let min_c = rgb[0].min(rgb[1]).min(rgb[2]);
        if min_c >= -HSL_GAMUT_EPS {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    lo
}

#[inline]
fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Apply the HSL stage to `img`. Identity short-circuit when all 24
/// sliders are at default (the baseline guarantee).
pub fn apply(
    img: &mut Image,
    hue: &[f32; NUM_BANDS],
    sat: &[f32; NUM_BANDS],
    lum: &[f32; NUM_BANDS],
) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    let p = hsl_params(hue, sat, lum);
    if p.is_identity {
        return;
    }
    for px in &mut img.pixels {
        *px = apply_pixel(*px, &p);
    }
}

// Tests live in the sibling `hsl_tests.rs` so this file stays under the
// 600-LOC budget (same `#[path]` split pattern as `stages/nlm.rs`).
#[cfg(test)]
#[path = "hsl_tests.rs"]
mod tests;
