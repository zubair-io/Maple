//! AgX view transform: scene-linear Rec.2020 → display-linear Rec.2020.
//! Spec § 3.6a.
//!
//! Post-#435: **Sobotka AgX with filmic hue restoration + Oklab gamut
//! compression**. The chain is:
//!
//!   inset matrix
//!     → ratio-preserving sigmoid (sigmoid applied to max(R,G,B), RGB
//!       scaled by sigmoid_norm / norm — hue invariant by construction)
//!     → highlight path-to-white (#1624): chroma rolls off toward the
//!       sigmoided max channel as it approaches display white
//!     → outset matrix
//!     → Oklab hue-preserving gamut compression to [0, 1]^3
//!
//! The ratio-preserving sigmoid keeps a colour's full chroma ratio all the
//! way up the curve, so a saturated colour arrives at the display gamut
//! wall at *maximum* chroma and the #1621 soft compression has to shed all
//! of it at once. Film and the mature tone mappers desaturate toward white
//! instead. [`path_to_white`] does that in AgX-Base space, driven by the
//! sigmoided max channel `sn`: identity below `AGX_P2W_KNEE` (mid-grey and
//! every shadow/midtone colour untouched, so `mid_gray_identity_preserved`
//! and the neutral-axis invariants hold by construction — the lerp target
//! IS the pixel for a neutral), rising as
//! `AGX_P2W_AMOUNT · ((sn − KNEE)/(1 − KNEE))^AGX_P2W_POWER` to full
//! desaturation at display white. The max channel is unchanged by the
//! lerp, so brightness is preserved and the step inverts exactly
//! (`view::agx_inverse`). Constants live in `agx_coeffs.rs` (generated) and
//! mirror into the WGSL kernel through `agx_coeffs.wgsl`.
//!
//! The per-channel sigmoid + hard `clamp(0, 1)` form (pre-#435) drove
//! channels negative on saturated reds/blues/purples, surfaced as
//! magenta. The `luma_coupled_toe` band-aid that addressed the
//! symmetric problem in deep shadows is now retired — the ratio path
//! handles deep shadows naturally without a separate gate.
//!
//! The matrices, sigmoid coefficients, and LUT are derived by
//! `src/scripts/derive_agx_lut.py` and emitted as:
//!
//!   * `agx_lut.bin`    — 512 × f32 little-endian, embedded via
//!                        `include_bytes!` below.
//!   * `agx_coeffs.rs`  — `AGX_MIN_EV`, `AGX_MAX_EV`, `AGX_MID_GRAY`,
//!                        `AGX_X_PIVOT`, `AGX_Y_PIVOT`, `AGX_BASE_SLOPE`,
//!                        `AGX_TOE_POWER`, `AGX_SHOULDER_POWER`,
//!                        `AGX_INSET_MATRIX`, `AGX_OUTSET_MATRIX`,
//!                        `AGX_LUT_SIZE`, `AGX_VERSION`.
//!
//! The Apple side bundles a byte-identical copy of `agx_lut.bin` for
//! parity tests; the Web side compiles the same constants into a GLSL
//! shader. Cross-platform parity at 1e-4 per channel is a CI gate.

use crate::image::{ColorSpace, Image};
use rayon::prelude::*;

#[path = "agx_coeffs.rs"]
mod coeffs;
#[path = "agx_hue_restoration.rs"]
mod hue_restoration;
pub use coeffs::{
    AGX_BASE_SLOPE, AGX_INSET_MATRIX, AGX_LUT_SIZE, AGX_MAX_EV, AGX_MID_DISPLAY, AGX_MID_GRAY,
    AGX_MIN_EV, AGX_OUTSET_MATRIX, AGX_P2W_AMOUNT, AGX_P2W_KNEE, AGX_P2W_POWER, AGX_SHOULDER_POWER,
    AGX_TOE_POWER, AGX_VERSION, AGX_X_PIVOT, AGX_Y_PIVOT,
};
use hue_restoration::{norm_sigmoid_ratio, oklab_gamut_compress};

/// Embedded LUT bytes — 512 × f32 little-endian.
const AGX_LUT_BYTES: &[u8] = include_bytes!("agx_lut.bin");

/// Normalized log-domain position of scene-linear mid-gray. Contrast
/// modulation pivots around this point so the mid-gray anchor is stable.
///
/// `pub(crate)` so `view::agx_inverse` can undo the contrast-slope
/// modulation with the exact same pivot.
pub(crate) const MID_NORM: f32 = -AGX_MIN_EV / (AGX_MAX_EV - AGX_MIN_EV);

/// Parse `AGX_LUT_BYTES` into a `[f32; AGX_LUT_SIZE]` on first access.
///
/// `pub(crate)` so `view::agx_inverse` reverses the exact same monotone
/// sigmoid LUT (single source of truth — no duplicate parse).
pub(crate) fn lut() -> &'static [f32; AGX_LUT_SIZE] {
    static CELL: std::sync::OnceLock<[f32; AGX_LUT_SIZE]> = std::sync::OnceLock::new();
    CELL.get_or_init(|| {
        assert_eq!(
            AGX_LUT_BYTES.len(),
            AGX_LUT_SIZE * 4,
            "agx_lut.bin size mismatch: expected {} bytes, got {}",
            AGX_LUT_SIZE * 4,
            AGX_LUT_BYTES.len()
        );
        let mut out = [0.0f32; AGX_LUT_SIZE];
        for (i, chunk) in AGX_LUT_BYTES.chunks_exact(4).enumerate() {
            out[i] = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        }
        out
    })
}

/// Sample the AgX sigmoid LUT with linear interpolation at normalized-log
/// position `x`. Clamps outside [0, 1].
fn sample_lut(x: f32) -> f32 {
    let lut = lut();
    let x = x.clamp(0.0, 1.0);
    let idx = x * ((AGX_LUT_SIZE - 1) as f32);
    let i0 = idx.floor() as usize;
    let i1 = (i0 + 1).min(AGX_LUT_SIZE - 1);
    let f = idx - (i0 as f32);
    lut[i0] * (1.0 - f) + lut[i1] * f
}

/// Apply a 3×3 matrix to an RGB triple.
#[inline]
fn matrix_mul(m: &[[f32; 3]; 3], v: [f32; 3]) -> [f32; 3] {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

/// Per-channel log2 encode + normalize to [0, 1]. Mirror of Sobotka
/// `open_domain_to_normalized_log2`. Pinned at the toe (`MIN_EV`) for
/// non-positive inputs.
#[inline]
fn log_encode(channel: f32) -> f32 {
    let floor = AGX_MID_GRAY * AGX_MIN_EV.exp2();
    let clamped = channel.max(floor);
    let log_v = (clamped / AGX_MID_GRAY)
        .log2()
        .clamp(AGX_MIN_EV, AGX_MAX_EV);
    (log_v - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV)
}

/// Path-to-white weight for a sigmoided max channel `sn` (#1624): 0 at and
/// below `AGX_P2W_KNEE`, `AGX_P2W_AMOUNT` at display white, a
/// `AGX_P2W_POWER` ramp between. Shared by the forward step and its inverse
/// (`view::agx_inverse`) so the two cannot drift.
///
/// `pub(crate)` for the inverse; the WGSL mirror is `agx_p2w_weight`.
#[inline]
pub(crate) fn path_to_white_weight(sn: f32) -> f32 {
    if sn <= AGX_P2W_KNEE {
        return 0.0;
    }
    let t = ((sn - AGX_P2W_KNEE) / (1.0 - AGX_P2W_KNEE)).clamp(0.0, 1.0);
    AGX_P2W_AMOUNT * t.powf(AGX_P2W_POWER)
}

/// Highlight path-to-white (#1624) on a sigmoided AgX-Base pixel: lerp every
/// channel toward the max channel by [`path_to_white_weight`]. The max
/// channel itself is a fixed point of the lerp, so the pixel's brightness
/// (its `max`) is preserved and only chroma is shed; a neutral is already at
/// its max on every channel and passes through bit-identically.
#[inline]
fn path_to_white(sig: [f32; 3]) -> [f32; 3] {
    let sn = sig[0].max(sig[1]).max(sig[2]);
    let w = path_to_white_weight(sn);
    if w <= 0.0 {
        return sig;
    }
    [
        sig[0] + w * (sn - sig[0]),
        sig[1] + w * (sn - sig[1]),
        sig[2] + w * (sn - sig[2]),
    ]
}

/// Apply AgX to a single pixel:
///
/// `slope` is 1.0 at `contrast=0`; positive contrast steepens, negative
/// softens. Slope pivots around `MID_NORM`. Per the #435 audit the
/// inner `.clamp(0.0, 1.0)` was removed from the contrast modulation —
/// `sample_lut` already clamps its input to `[0, 1]`, and the inner
/// clamp was posterising the toe/shoulder when `|contrast| > 0`.
///
/// The sigmoid is **applied in a ratio-preserving way** (norm = max of
/// inset RGB; sigmoid the norm once, scale RGB by sigmoid_norm / norm),
/// so hue survives the curve. The post-outset clamp is replaced with
/// Oklab hue-preserving gamut compression to keep saturated-primary
/// pixels in `[0, 1]^3` without producing magenta.
fn agx_pixel(scene: [f32; 3], slope: f32) -> [f32; 3] {
    // 1) Inset matrix: Rec.2020 → AgX-Base-Rec.2020 (per-channel desat).
    //    No pre-clamp: the ratio-preserving sigmoid below handles
    //    deep shadow uniformly without a luma gate (the old
    //    `luma_coupled_toe` is retired in #435).
    let inset = matrix_mul(&AGX_INSET_MATRIX, scene);

    // 2) Ratio-preserving sigmoid: sigmoid applied to max(R,G,B), the
    //    other channels ride the same scale. Hue invariant; replaces
    //    the per-channel form that produced magenta on saturated
    //    primaries.
    let sigmoid_curve = |x: f32| -> f32 {
        let norm = log_encode(x);
        let modulated = MID_NORM + (norm - MID_NORM) * slope;
        sample_lut(modulated)
    };
    let sig = norm_sigmoid_ratio(inset, sigmoid_curve);

    // 2b) Highlight path-to-white (#1624): shed chroma toward the sigmoided
    //     max as the pixel approaches display white, so saturated
    //     highlights stop arriving at the gamut wall at full chroma.
    let sig = path_to_white(sig);

    // 3) Outset matrix: AgX-Base-Rec.2020 → Rec.2020 (restores chroma).
    let out = matrix_mul(&AGX_OUTSET_MATRIX, sig);

    // 4) Hue-preserving gamut compression to [0, 1]^3. Most in-gamut
    //    pixels short-circuit; only saturated primaries pay the Oklab
    //    bisection cost.
    oklab_gamut_compress(out)
}

/// The AgX sigmoid evaluated on a NEUTRAL scene-linear value.
///
/// For an achromatic input the inset/outset matrices are identity (their rows
/// sum to 1 and map the D65 neutral axis onto itself) and the ratio-preserving
/// step degenerates to `sigmoid_curve(y)`, so this is exactly what
/// [`agx_pixel`] does to a grey pixel — the same `log_encode` → slope
/// modulation → `sample_lut` chain, single-sourced rather than re-derived.
///
/// `slope = 1 + (contrast / 100) * 0.5`, matching [`apply`]. The result is
/// display-LINEAR Rec.2020 (the view tail's `srgb_gamma` has not been applied).
///
/// Used by `stages::auto_adjustments_tone` (#1376) to map the calibration's
/// display-referred histogram anchors into the scene-linear domain the tone
/// sliders operate in, and back.
pub fn neutral_curve(y_scene: f32, slope: f32) -> f32 {
    let norm = log_encode(y_scene);
    let modulated = MID_NORM + (norm - MID_NORM) * slope;
    sample_lut(modulated)
}

/// Apply AgX across the image. Input must be `SceneLinearRec2020`; output
/// space is `DisplayLinearRec2020`. `contrast` in [-100, +100]; 0 is the
/// reference Sobotka sigmoid.
pub fn apply(img: &mut Image, contrast: f32) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    // Slope = 1 + (contrast/100) * 0.5. At +100 → 1.5×, at −100 → 0.5×.
    let slope = 1.0 + (contrast / 100.0) * 0.5;
    img.pixels.par_iter_mut().for_each(|p| {
        *p = agx_pixel(*p, slope);
    });
    img.space = ColorSpace::DisplayLinearRec2020;
}

#[cfg(test)]
#[path = "agx_tests.rs"]
mod tests;
