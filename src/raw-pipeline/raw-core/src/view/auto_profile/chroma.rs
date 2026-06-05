//! Per-image JPEG chroma-match transform (Auto Profile chroma). Operates on
//! OKLAB a/b only — keeps L (AgX owns tone). Phase 1 of
//! docs/superpowers/specs/2026-06-04-jpeg-chroma-match-auto-profile-design.md.
//!
//! The transform is solved per image so the POST-AgX render matches the
//! embedded JPEG's chroma (the solver fits *through* AgX — see Task 4 of the
//! Phase-1 plan), and it is injected at decode (post-DCP, pre-AgX) so it rides
//! the shared scene-linear buffer to every platform like the DCP/HSM.

use crate::color::oklab::{oklab_to_rec2020, rec2020_to_oklab};
use crate::image::Image;
use rayon::prelude::*;

pub const N_HUE_BINS: usize = 12;

/// Per-hue chroma gain transform. `hue_gains[i]` scales C*=sqrt(a²+b²) for
/// hues near bin i (centre = i·2π/12, spacing 30°). Smoothly interpolated
/// around the hue circle. Identity = all gains 1.0. Structurally cannot
/// rotate hues or shift neutrals: map_ab(0,0)=(0,0) always.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ChromaTransform {
    pub hue_gains: [f32; N_HUE_BINS],
    pub taper_lo: f32,
    pub taper_hi: f32,
}

impl ChromaTransform {
    pub fn identity() -> Self {
        Self { hue_gains: [1.0; N_HUE_BINS], taper_lo: 2.0, taper_hi: 3.0 }
    }

    fn gain_at(&self, a: f32, b: f32) -> f32 {
        let c = a.hypot(b);
        if c < 1e-6 { return 1.0; } // undefined hue → identity
        let hue = b.atan2(a).rem_euclid(std::f32::consts::TAU);
        let bin_w = std::f32::consts::TAU / N_HUE_BINS as f32;
        let pos = hue / bin_w;
        let lo = pos.floor() as usize % N_HUE_BINS;
        let hi = (lo + 1) % N_HUE_BINS;
        let t = pos.fract();
        self.hue_gains[lo] * (1.0 - t) + self.hue_gains[hi] * t
    }

    pub fn map_ab(&self, a: f32, b: f32) -> (f32, f32) {
        let g = self.gain_at(a, b);
        (a * g, b * g)
    }

    /// Apply in-place to a scene-linear Rec.2020 image. Keeps OKLAB L; tapers
    /// toward identity in highlights using scene-linear V (max channel), which
    /// tracks the AgX path-to-white more accurately than OKLAB L. Negative-
    /// component pixels are passed through unchanged (matching the HSM
    /// out-of-gamut bypass).
    pub fn apply_to_scene(&self, img: &mut Image) {
        img.pixels.par_iter_mut().for_each(|p| {
            if p[0] < 0.0 || p[1] < 0.0 || p[2] < 0.0 {
                return;
            }
            let v = p[0].max(p[1]).max(p[2]); // scene-linear V — tracks AgX path-to-white
            let lab = rec2020_to_oklab(*p);
            let (ta, tb) = self.map_ab(lab[1], lab[2]);
            let t = ((v - self.taper_lo) / (self.taper_hi - self.taper_lo)).clamp(0.0, 1.0);
            let att = t * t * (3.0 - 2.0 * t);
            let na = lab[1] + (ta - lab[1]) * (1.0 - att);
            let nb = lab[2] + (tb - lab[2]) * (1.0 - att);
            *p = oklab_to_rec2020([lab[0], na, nb]);
        });
    }
}

/// Apply `t` to scene-linear samples, run AgX (the fixed forward tone model),
/// and return the **post-AgX** OKLAB `(a, b)` per sample. This is the primitive
/// the through-AgX solver minimizes its objective in: the solver matches
/// `forward_post_agx_ab(scene, T)` to the linearized JPEG's a/b, with AgX as
/// a fixed term in the loss, so the chroma cannot reproduce the HSM's
/// post-tone-curve highlight over-saturation. Output is display-linear Rec.2020
/// OKLAB — the same space the linearized JPEG lands in (decode → Rec.2020 →
/// `rec2020_to_oklab`), so the two are directly comparable.
///
/// `contrast` matches the render path's `model.contrast` AgX slope so the
/// forward model is the exact tone curve the final render uses.
pub(crate) fn forward_post_agx_ab(
    scene: &[[f32; 3]],
    t: &ChromaTransform,
    contrast: f32,
) -> Vec<(f32, f32)> {
    use crate::image::ColorSpace;
    let mut img = Image {
        width: scene.len() as u32,
        height: 1,
        pixels: scene.to_vec(),
        space: ColorSpace::SceneLinearRec2020,
    };
    t.apply_to_scene(&mut img);
    crate::view::agx::apply(&mut img, contrast);
    img.pixels
        .iter()
        .map(|p| {
            let lab = rec2020_to_oklab(*p);
            (lab[1], lab[2])
        })
        .collect()
}

// ── JPEG sampling + filtering (Task 3) ───────────────────────────────────────

use crate::color::matrices::{M_REC2020_TO_SRGB, M_XYZ_D65_TO_REC2020};
use crate::math::Matrix3;
use crate::view::auto_profile::preview::JpegColorSpace;

/// Adobe RGB (1998) → XYZ (D65). Sourced from the Adobe RGB (1998) Color Image
/// Encoding spec (ASTM E308 D65 white). Composed with [`M_XYZ_D65_TO_REC2020`]
/// at runtime to land Adobe-RGB-linear pixels in linear Rec.2020 D65 — both
/// already D65, so no chromatic adaptation. test_0003 (Canon 5DS R) ships an
/// Adobe RGB embedded JPEG (`Canon:ColorSpace = Adobe RGB`); reading it as sRGB
/// understates saturation 30–50% and would corrupt the chroma target.
const M_ADOBE_RGB_TO_XYZ_D65: Matrix3 = Matrix3([
    [0.5767309, 0.1855540, 0.1881852],
    [0.2973769, 0.6273491, 0.0752741],
    [0.0270343, 0.0706872, 0.9911085],
]);

/// Adobe RGB (1998) decoding gamma — the spec's 2+51/256 = 563/256 power.
/// No linear toe segment (unlike sRGB), per the Adobe RGB (1998) spec.
const ADOBE_RGB_GAMMA: f32 = 563.0 / 256.0;

/// Cached JPEG-decode matrices into linear Rec.2020 D65, one per
/// [`JpegColorSpace`]. Tuple order: (sRGB-linear→Rec.2020, AdobeRGB-linear→
/// Rec.2020). sRGB uses `inverse(M_REC2020_TO_SRGB)`; AdobeRGB composes the
/// sourced primaries matrix with `M_XYZ_D65_TO_REC2020`. Computed once.
fn jpeg_decode_matrices() -> &'static (Matrix3, Matrix3) {
    static CELL: std::sync::OnceLock<(Matrix3, Matrix3)> = std::sync::OnceLock::new();
    CELL.get_or_init(|| {
        let srgb_to_rec2020 =
            M_REC2020_TO_SRGB.inverse().expect("M_REC2020_TO_SRGB is invertible");
        let adobe_to_rec2020 = M_XYZ_D65_TO_REC2020.mul_mat(&M_ADOBE_RGB_TO_XYZ_D65);
        (srgb_to_rec2020, adobe_to_rec2020)
    })
}

/// sRGB (IEC 61966-2-1) inverse OETF on one channel — display-encoded → linear.
#[inline]
fn srgb_to_linear_one(v: f32) -> f32 {
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

/// Decode one display-encoded JPEG pixel (channels in `[0, 1]`) to **linear
/// Rec.2020 D65**, honoring its color space. This is the colorimetrically-
/// correct path the spec's Component-1 step 2 calls for: the JPEG's a/b only
/// match the RAW's a/b once both are in the same absolute Rec.2020 OKLAB.
#[inline]
fn decode_jpeg_to_rec2020(rgb01: [f32; 3], cs: JpegColorSpace) -> [f32; 3] {
    let (srgb_m, adobe_m) = jpeg_decode_matrices();
    match cs {
        JpegColorSpace::SRgb => {
            let lin = [
                srgb_to_linear_one(rgb01[0]),
                srgb_to_linear_one(rgb01[1]),
                srgb_to_linear_one(rgb01[2]),
            ];
            srgb_m.mul_vec(lin)
        }
        JpegColorSpace::AdobeRgb => {
            // Adobe RGB power-law decode (no linear segment).
            let lin = [
                rgb01[0].max(0.0).powf(ADOBE_RGB_GAMMA),
                rgb01[1].max(0.0).powf(ADOBE_RGB_GAMMA),
                rgb01[2].max(0.0).powf(ADOBE_RGB_GAMMA),
            ];
            adobe_m.mul_vec(lin)
        }
    }
}

/// One sampled grid point. Carries the RAW's box-averaged **scene-linear
/// Rec.2020** pixel (the solver runs AgX through it — AgX needs full RGB, not
/// just a/b, because it keeps the RAW's L), its pre-AgX OKLAB `a/b` (the LSQ
/// feature), the linearized-JPEG OKLAB `a/b` target (both absolute Rec.2020
/// OKLAB), the JPEG pixel position, a center-weight, and the clip flag.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Pair {
    /// RAW box-averaged scene-linear Rec.2020 pixel at this grid point.
    pub raw_scene: [f32; 3],
    /// RAW scene-linear (pre-AgX) OKLAB `(a, b)` — `rec2020_to_oklab(raw_scene)`.
    pub raw_ab: (f32, f32),
    /// Linearized-JPEG OKLAB `(a, b)` target at this grid point.
    pub jpeg_ab: (f32, f32),
    pub x: usize,
    pub y: usize,
    /// Radial center-weight (lens falloff guard) — 1.0 at center, →0 at edges.
    pub weight: f32,
    /// True if any JPEG channel byte is railed (`> 245` or `< 10` of 255).
    pub clipped: bool,
}

/// JPEG clip thresholds in `[0, 1]` (byte `> 245` / `< 10`).
const CLIP_HI: f32 = 245.0 / 255.0;
const CLIP_LO: f32 = 10.0 / 255.0;

/// 3×3 JPEG-luma variance ceiling. Above this a grid point is dropped as a
/// block/CA/edge artifact (the spec's filter). Tuned loose enough that one
/// railed outlier in an otherwise-flat field doesn't poison a clean pixel
/// (clipped neighbors are excluded from the statistic below), tight enough to
/// reject genuine high-contrast texture where demosaic/JPEG disagree on color.
const VARIANCE_CEIL: f32 = 0.02;

#[inline]
fn luma01(p: [f32; 3]) -> f32 {
    0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]
}

#[inline]
fn is_clipped(p: [f32; 3]) -> bool {
    p.iter().any(|&c| c > CLIP_HI || c < CLIP_LO)
}

/// Box-average the RAW scene-linear buffer into the JPEG grid cell `(ox, oy)`,
/// using the SAME integer-span mapping as the #550 fit's `footprint_sizes`
/// (`(o·dim)/out .. ((o+1)·dim)/out`, each span ≥ 1px). Returns the mean
/// scene-linear Rec.2020 triple over the cell's source footprint.
fn box_average(raw: &[[f32; 3]], rw: usize, rh: usize, ox: usize, oy: usize, jw: usize, jh: usize) -> [f32; 3] {
    let x0 = (ox * rw) / jw;
    let mut x1 = ((ox + 1) * rw) / jw;
    if x1 <= x0 {
        x1 = (x0 + 1).min(rw);
    }
    let y0 = (oy * rh) / jh;
    let mut y1 = ((oy + 1) * rh) / jh;
    if y1 <= y0 {
        y1 = (y0 + 1).min(rh);
    }
    let mut acc = [0.0f64; 3];
    let mut n = 0u32;
    for y in y0..y1 {
        for x in x0..x1 {
            let p = raw[y * rw + x];
            acc[0] += p[0] as f64;
            acc[1] += p[1] as f64;
            acc[2] += p[2] as f64;
            n += 1;
        }
    }
    let n = n.max(1) as f64;
    [(acc[0] / n) as f32, (acc[1] / n) as f32, (acc[2] / n) as f32]
}

/// Sample paired RAW/JPEG grid points for the chroma solve.
///
/// - `raw_scene` is the **scene-linear Rec.2020** buffer (pre-AgX, the AgX
///   input) at dims `rw×rh`; box-downscaled to the JPEG grid.
/// - `jpeg01` is the display-encoded JPEG at dims `jw×jh`, channels in `[0, 1]`
///   (`byte / 255`); decoded to linear Rec.2020 per `cs`.
///
/// Filters per the spec: drops JPEG-clipped pairs, drops high-3×3-luma-variance
/// pairs (clipped neighbors excluded from the variance), and center-weights the
/// grid (the JPEG is lens-corrected, the RAW is not). Returns the surviving
/// clean, center-weighted pairs.
pub(crate) fn sample_pairs(
    raw_scene: &[[f32; 3]],
    rw: usize,
    rh: usize,
    jpeg01: &[[f32; 3]],
    jw: usize,
    jh: usize,
    cs: JpegColorSpace,
) -> Vec<Pair> {
    let mut out = Vec::new();
    if jw == 0 || jh == 0 || rw == 0 || rh == 0 {
        return out;
    }
    let cx = (jw as f32 - 1.0) * 0.5;
    let cy = (jh as f32 - 1.0) * 0.5;
    // Max radius for the cosine falloff (corner distance), guard div-by-zero.
    let r_max = (cx * cx + cy * cy).sqrt().max(1e-6);
    for oy in 0..jh {
        for ox in 0..jw {
            let jp = jpeg01[oy * jw + ox];
            let clipped = is_clipped(jp);
            if clipped {
                continue; // never a target
            }
            // 3×3 JPEG-luma variance over non-clipped neighbors.
            let mut sum = 0.0f32;
            let mut sumsq = 0.0f32;
            let mut cnt = 0u32;
            for dy in -1i32..=1 {
                for dx in -1i32..=1 {
                    let nx = ox as i32 + dx;
                    let ny = oy as i32 + dy;
                    if nx < 0 || ny < 0 || nx >= jw as i32 || ny >= jh as i32 {
                        continue;
                    }
                    let np = jpeg01[ny as usize * jw + nx as usize];
                    if is_clipped(np) {
                        continue; // don't let a railed neighbor poison the stat
                    }
                    let l = luma01(np);
                    sum += l;
                    sumsq += l * l;
                    cnt += 1;
                }
            }
            if cnt > 0 {
                let mean = sum / cnt as f32;
                let var = (sumsq / cnt as f32) - mean * mean;
                if var > VARIANCE_CEIL {
                    continue; // edge / block / CA — skip
                }
            }
            // Radial cosine center-weight: 1 at center, 0 at the corners.
            let dx = ox as f32 - cx;
            let dy = oy as f32 - cy;
            let r = (dx * dx + dy * dy).sqrt() / r_max;
            let weight = (0.5 * (1.0 + (std::f32::consts::PI * r.clamp(0.0, 1.0)).cos())).max(0.0);

            let raw_avg = box_average(raw_scene, rw, rh, ox, oy, jw, jh);
            let raw_lab = rec2020_to_oklab(raw_avg);
            let jpeg_lin = decode_jpeg_to_rec2020(jp, cs);
            let jpeg_lab = rec2020_to_oklab(jpeg_lin);
            out.push(Pair {
                raw_scene: raw_avg,
                raw_ab: (raw_lab[1], raw_lab[2]),
                jpeg_ab: (jpeg_lab[1], jpeg_lab[2]),
                x: ox,
                y: oy,
                weight,
                clipped,
            });
        }
    }
    out
}

// ── The per-hue gain solver ───────────────────────────────────────────────────

/// Global strength of the JPEG→scene chroma correction. The embedded JPEG
/// overshoots ACR's chroma magnitude, so the solved transform is damped
/// toward identity by `k`. The JPEG gives the direction; `k` sets how far
/// we follow it. Validated offline against ACR references:
/// k=0.3–0.7 all achieve similar mid-tones fidelity; 0.5 sits at the
/// diminishing-returns knee and errs conservative.
const CHROMA_STRENGTH: f32 = 0.5;

/// Scene-linear V (max channel) at which the chroma correction begins to
/// taper off. Below this value the full corrected chroma applies; above
/// `CHROMA_TAPER_HI` the transform is identity. Protects AgX's path-to-white
/// in highlights from the per-image solver.
///
/// Window [0.10, 0.30] was chosen by Task 5 sweep against ACR references:
/// it minimizes chroma's own contribution to highlight overshoot while
/// keeping mid-tone correction near-optimal.
const CHROMA_TAPER_LO: f32 = 0.10;
const CHROMA_TAPER_HI: f32 = 0.30;

/// Solve a [`ChromaTransform`] via per-hue gaussian ratio accumulation.
///
/// Algorithm:
/// 1. Run all scene pixels through AgX with identity chroma to get baseline
///    post-AgX `(a, b)` per pair.
/// 2. For each of 12 hue bins (30° each), accumulate weighted `jpeg_C / agx_C`
///    ratios from pairs whose scene hue falls near that bin (gaussian weight
///    σ=40°).
/// 3. Regularize sparse bins toward gain=1.0 by effective sample weight.
/// 4. 3-tap circular smooth.
/// 5. Apply global damping k (from `MAPLE_CHROMA_STRENGTH_OVERRIDE` or
///    `CHROMA_STRENGTH`); clamp to [0.5, 3.0].
pub(crate) fn solve_per_hue_gains(pairs: &[Pair], contrast: f32) -> ChromaTransform {
    if pairs.is_empty() { return ChromaTransform::identity(); }

    let scene: Vec<[f32; 3]> = pairs.iter().map(|p| p.raw_scene).collect();
    let baseline = forward_post_agx_ab(&scene, &ChromaTransform::identity(), contrast);

    const SIGMA_DEG: f32 = 40.0;
    let sigma_rad = SIGMA_DEG * std::f32::consts::PI / 180.0;
    let bin_w = std::f32::consts::TAU / N_HUE_BINS as f32;

    let mut gain_sum = [0.0f64; N_HUE_BINS];
    let mut weight_sum = [0.0f64; N_HUE_BINS];

    for (i, pair) in pairs.iter().enumerate() {
        let (sa, sb) = pair.raw_ab;
        let scene_hue = sb.atan2(sa).rem_euclid(std::f32::consts::TAU);
        let (ba, bb) = baseline[i];
        let agx_c = ba.hypot(bb);
        let (ja, jb) = pair.jpeg_ab;
        let jpeg_c = ja.hypot(jb);
        if agx_c < 1e-5 || jpeg_c < 1e-5 { continue; }
        let ratio = (jpeg_c / agx_c).clamp(0.5, 3.0) as f64;
        let pw = pair.weight as f64;

        for bin in 0..N_HUE_BINS {
            let centre = bin as f32 * bin_w + bin_w * 0.5;
            let mut d = (scene_hue - centre).abs();
            if d > std::f32::consts::PI { d = std::f32::consts::TAU - d; }
            let w = (-0.5 * (d / sigma_rad).powi(2)).exp() as f64 * pw;
            gain_sum[bin] += w * ratio;
            weight_sum[bin] += w;
        }
    }

    const MIN_WEIGHT: f64 = 10.0;
    let mut raw = [1.0f32; N_HUE_BINS];
    for bin in 0..N_HUE_BINS {
        let w = weight_sum[bin];
        if w < 1e-9 { continue; }
        let g = (gain_sum[bin] / w) as f32;
        let reg = (w / (w + MIN_WEIGHT)) as f32;
        raw[bin] = 1.0 + (g - 1.0) * reg;
    }

    // 3-tap circular smooth
    let mut smoothed = [1.0f32; N_HUE_BINS];
    for i in 0..N_HUE_BINS {
        let prev = (i + N_HUE_BINS - 1) % N_HUE_BINS;
        let next = (i + 1) % N_HUE_BINS;
        smoothed[i] = 0.25 * raw[prev] + 0.50 * raw[i] + 0.25 * raw[next];
    }

    let k = std::env::var("MAPLE_CHROMA_STRENGTH_OVERRIDE")
        .ok().and_then(|s| s.parse::<f32>().ok())
        .unwrap_or(CHROMA_STRENGTH);

    let mut hue_gains = [1.0f32; N_HUE_BINS];
    for i in 0..N_HUE_BINS {
        hue_gains[i] = (1.0 + k * (smoothed[i] - 1.0)).clamp(0.5, 3.0);
    }

    ChromaTransform { hue_gains, taper_lo: 2.0, taper_hi: 3.0 }
}

// ── Render-path entry: solve from a RAW's embedded JPEG (Task 5) ──────────────

/// Minimum surviving clean sample pairs to trust a solve. Below this the
/// embedded JPEG is too small/clipped/degenerate to fit a chroma transform, so
/// the caller keeps the deterministic CM/FM+2D-HSM baseline (identity chroma).
const MIN_SOLVE_PAIRS: usize = 256;

/// Solve the per-image chroma transform from the embedded JPEG of the RAW at
/// `path`, against the pre-AgX `scene`. Returns `None` (→ deterministic
/// baseline) when there's no JPEG or too few clean pairs survive filtering.
pub(crate) fn solve_chroma_for_path(
    scene: &Image,
    path: &std::path::Path,
    _orientation: crate::image::ExifOrientation,
    contrast: f32,
) -> Option<ChromaTransform> {
    use crate::view::auto_profile::preview;
    // The pre-AgX `scene` is SENSOR-oriented (the render applies EXIF
    // orientation last), so pair against the SENSOR-oriented preview — do NOT
    // orient it to display, or rotated fixtures (test_0003 = Rotate 270 CW)
    // transpose the sample grid and the solve fits garbage (desaturates).
    let prev = preview::extract_preview(path)?;
    let cs = preview::detect_jpeg_color_space(path);
    solve_chroma_from_preview(scene, prev, cs, contrast)
}

/// Bytes-FFI variant of [`solve_chroma_for_path`].
pub(crate) fn solve_chroma_for_bytes(
    scene: &Image,
    bytes: &[u8],
    ext: &str,
    _orientation: crate::image::ExifOrientation,
    contrast: f32,
) -> Option<ChromaTransform> {
    use crate::view::auto_profile::preview;
    // Sensor-oriented preview to match the sensor-oriented pre-AgX scene (see
    // solve_chroma_for_path).
    let prev = preview::extract_preview_from_bytes(bytes, ext)?;
    let cs = preview::detect_jpeg_color_space_from_bytes(bytes, ext);
    solve_chroma_from_preview(scene, prev, cs, contrast)
}

/// Shared tail: a display-oriented preview + its color space → sampled pairs →
/// per-hue gain solve.
fn solve_chroma_from_preview(
    scene: &Image,
    prev: image::DynamicImage,
    cs: JpegColorSpace,
    contrast: f32,
) -> Option<ChromaTransform> {
    let rgb = prev.to_rgb8();
    let (jw, jh) = (rgb.width() as usize, rgb.height() as usize);
    let jpeg01: Vec<[f32; 3]> = rgb
        .pixels()
        .map(|p| [p[0] as f32 / 255.0, p[1] as f32 / 255.0, p[2] as f32 / 255.0])
        .collect();
    let pairs = sample_pairs(
        &scene.pixels,
        scene.width as usize,
        scene.height as usize,
        &jpeg01,
        jw,
        jh,
        cs,
    );
    if pairs.len() < MIN_SOLVE_PAIRS {
        return None;
    }
    // solve_per_hue_gains reads MAPLE_CHROMA_STRENGTH_OVERRIDE and applies k
    // internally. Taper is engaged from the real-image L distribution here.
    let mut t = solve_per_hue_gains(&pairs, contrast);
    // Dev-only taper overrides for offline window exploration (Task 5).
    let taper_lo = std::env::var("MAPLE_CHROMA_TAPER_LO")
        .ok()
        .and_then(|s| s.parse::<f32>().ok())
        .unwrap_or(CHROMA_TAPER_LO);
    let taper_hi = std::env::var("MAPLE_CHROMA_TAPER_HI")
        .ok()
        .and_then(|s| s.parse::<f32>().ok())
        .unwrap_or(CHROMA_TAPER_HI);
    t.taper_lo = taper_lo;
    t.taper_hi = taper_hi;
    Some(t)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::oklab::rec2020_to_oklab;
    use crate::image::{ColorSpace, Image};
    use crate::view::auto_profile::preview::JpegColorSpace;

    fn one_px(rgb: [f32; 3]) -> Image {
        Image { width: 1, height: 1, pixels: vec![rgb], space: ColorSpace::SceneLinearRec2020 }
    }

    #[test]
    fn identity_transform_is_noop() {
        let t = ChromaTransform::identity();
        let mut img = one_px([0.4, 0.2, 0.1]);
        let before = img.pixels[0];
        t.apply_to_scene(&mut img);
        for c in 0..3 {
            assert!(
                (img.pixels[0][c] - before[c]).abs() < 1e-4,
                "channel {c} moved: {} -> {}",
                before[c],
                img.pixels[0][c]
            );
        }
    }

    #[test]
    fn apply_preserves_oklab_l() {
        // hue_gains=[1.5;12] scales C* by 1.5; OKLAB L must survive within float noise.
        let t = ChromaTransform { hue_gains: [1.5; N_HUE_BINS], ..ChromaTransform::identity() };
        let mut img = one_px([0.5, 0.25, 0.15]);
        let l_before = rec2020_to_oklab(img.pixels[0])[0];
        let ab_before = {
            let lab = rec2020_to_oklab(img.pixels[0]);
            (lab[1], lab[2])
        };
        t.apply_to_scene(&mut img);
        let lab_after = rec2020_to_oklab(img.pixels[0]);
        assert!(
            (lab_after[0] - l_before).abs() < 1e-4,
            "L moved: {l_before} -> {}",
            lab_after[0]
        );
        // Sanity: a/b actually changed (transform is non-trivial).
        assert!(
            (lab_after[1] - ab_before.0).abs() > 1e-3 || (lab_after[2] - ab_before.1).abs() > 1e-3,
            "a/b did not change under gain=1.5"
        );
    }

    // ── Task 2: post-AgX forward model ───────────────────────────────────────

    #[test]
    fn forward_identity_matches_plain_agx() {
        // forward_post_agx_ab with the identity transform must equal running
        // plain AgX on the same pixels and reading the post-AgX OKLAB a/b.
        let scene: Vec<[f32; 3]> =
            vec![[0.3, 0.18, 0.12], [0.6, 0.5, 0.45], [0.05, 0.04, 0.04]];
        let id = ChromaTransform::identity();
        let got = forward_post_agx_ab(&scene, &id, 0.0);
        let mut img = Image {
            width: 3,
            height: 1,
            pixels: scene.clone(),
            space: ColorSpace::SceneLinearRec2020,
        };
        crate::view::agx::apply(&mut img, 0.0);
        for (i, p) in img.pixels.iter().enumerate() {
            let lab = rec2020_to_oklab(*p);
            assert!(
                (got[i].0 - lab[1]).abs() < 1e-4 && (got[i].1 - lab[2]).abs() < 1e-4,
                "pixel {i}: forward {:?} != plain-AgX a/b ({}, {})",
                got[i],
                lab[1],
                lab[2]
            );
        }
    }

    // ── Task 3: JPEG sampling + filtering ────────────────────────────────────

    #[test]
    fn sampling_excludes_clipped_and_weights_center() {
        // 4x4 RAW scene-linear + 4x4 JPEG bytes-as-[0,1]. One JPEG pixel is
        // clipped (R railed high, G crushed low); it must be dropped, and
        // center pixels must outweigh corner pixels (radial center-weight).
        let raw = vec![[0.2_f32, 0.18, 0.15]; 16];
        let mut jpeg = vec![[0.4_f32, 0.35, 0.30]; 16];
        jpeg[5] = [1.0, 0.02, 0.30]; // clipped R (>245/255) and crushed G (<10/255)
        let pairs = sample_pairs(&raw, 4, 4, &jpeg, 4, 4, JpegColorSpace::SRgb);
        assert!(pairs.iter().all(|p| !p.clipped), "clipped pair retained");
        // The clipped pixel at flat index 5 = (x=1, y=1) must be gone.
        assert!(
            !pairs.iter().any(|p| p.x == 1 && p.y == 1),
            "clipped (1,1) survived sampling"
        );
        let w_center = pairs
            .iter()
            .find(|p| p.x == 2 && p.y == 2)
            .expect("center pixel present")
            .weight;
        let w_corner = pairs
            .iter()
            .find(|p| p.x == 0 && p.y == 0)
            .expect("corner pixel present")
            .weight;
        assert!(w_center > w_corner, "center {w_center} !> corner {w_corner}");
    }

    #[test]
    fn adobe_rgb_decode_differs_from_srgb_and_is_more_saturated() {
        // A saturated reddish JPEG pixel. Decoding it as Adobe RGB must land
        // a DIFFERENT (and more-saturated, larger |a|) Rec.2020 chroma than
        // decoding the same bytes as sRGB — the load-bearing color-management
        // fact (Adobe RGB packs saturated color into smaller RGB excursions,
        // so reading it as sRGB understates saturation). One flat pixel so
        // there is no spatial filtering to confound the comparison.
        let raw = vec![[0.2_f32, 0.1, 0.1]];
        let jpeg = vec![[0.82_f32, 0.20, 0.18]];
        let srgb = sample_pairs(&raw, 1, 1, &jpeg, 1, 1, JpegColorSpace::SRgb);
        let adobe = sample_pairs(&raw, 1, 1, &jpeg, 1, 1, JpegColorSpace::AdobeRgb);
        assert_eq!(srgb.len(), 1);
        assert_eq!(adobe.len(), 1);
        // jpeg_ab is the linearized-JPEG OKLAB (a, b) target.
        let (sa, sb) = srgb[0].jpeg_ab;
        let (aa, ab) = adobe[0].jpeg_ab;
        let s_chroma = (sa * sa + sb * sb).sqrt();
        let a_chroma = (aa * aa + ab * ab).sqrt();
        assert!(
            (sa - aa).abs() > 1e-3 || (sb - ab).abs() > 1e-3,
            "Adobe-RGB decode identical to sRGB: srgb=({sa},{sb}) adobe=({aa},{ab})"
        );
        assert!(
            a_chroma > s_chroma,
            "Adobe-RGB chroma {a_chroma} not > sRGB chroma {s_chroma} for the same red bytes"
        );
    }

    // ── Task 4: through-AgX solver ───────────────────────────────────────────

    /// Mean Euclidean (a, b) distance between two post-AgX sample sets.
    fn mean_ab_err(got: &[(f32, f32)], want: &[(f32, f32)]) -> f32 {
        assert_eq!(got.len(), want.len());
        let s: f32 = got
            .iter()
            .zip(want)
            .map(|(g, w)| {
                let da = g.0 - w.0;
                let db = g.1 - w.1;
                (da * da + db * db).sqrt()
            })
            .sum();
        s / got.len().max(1) as f32
    }

    /// Deterministic pseudo-random-ish scene of `n` scene-linear pixels with a
    /// spread of hues and lightnesses, all well below the taper L range.
    fn synth_scene(n: usize) -> Vec<[f32; 3]> {
        (0..n)
            .map(|i| {
                let f = i as f32;
                [
                    0.05 + 0.5 * (f * 0.013).sin().abs(),
                    0.04 + 0.4 * (f * 0.07).cos().abs(),
                    0.03 + 0.4 * (f * 0.11).sin().abs(),
                ]
            })
            .collect()
    }

    /// Build uniform unit weights for a fit set (no center-weighting in the
    /// synthetic recovery tests — the geometry is abstract).
    fn unit_pairs(scene: &[[f32; 3]], target: &[(f32, f32)]) -> Vec<Pair> {
        scene
            .iter()
            .zip(target)
            .map(|(&p, &t)| {
                let lab = rec2020_to_oklab(p);
                Pair {
                    raw_scene: p,
                    raw_ab: (lab[1], lab[2]),
                    jpeg_ab: t,
                    x: 0,
                    y: 0,
                    weight: 1.0,
                    clipped: false,
                }
            })
            .collect()
    }

    #[test]
    fn solver_identity_when_target_is_plain_agx() {
        // Target = forward(identity): the solved transform must be ~identity,
        // i.e. it must not move held-out pixels away from plain AgX.
        let scene = synth_scene(400);
        let id_target = forward_post_agx_ab(&scene, &ChromaTransform::identity(), 0.0);
        let (fit, meas) = (&scene[..300], &scene[300..]);
        let (fit_t, meas_t) = (&id_target[..300], &id_target[300..]);
        let fit_pairs = unit_pairs(fit, fit_t);
        let solved = solve_per_hue_gains(&fit_pairs, 0.0);
        let solved_err = mean_ab_err(&forward_post_agx_ab(meas, &solved, 0.0), meas_t);
        // Already-correct target → residual stays at the noise floor.
        assert!(
            solved_err < 1e-3,
            "solver drifted off an already-correct target: {solved_err}"
        );
    }

    // ── Task 1: per-hue scalar gain (new struct) ─────────────────────────────

    #[test]
    fn linear_map_preserves_neutral_axis() {
        // (0,0) must map to (0,0) — scalar gain never shifts neutrals.
        let t = ChromaTransform { hue_gains: [1.4; N_HUE_BINS], taper_lo: 2.0, taper_hi: 3.0 };
        let (a, b) = t.map_ab(0.0, 0.0);
        assert_eq!((a, b), (0.0, 0.0));
    }

    #[test]
    fn linear_map_near_neutral_stays_bounded() {
        // Tiny near-neutral perturbation must stay bounded (no √ blowup).
        let t = ChromaTransform { hue_gains: [1.4; N_HUE_BINS], taper_lo: 2.0, taper_hi: 3.0 };
        let (a, b) = t.map_ab(1e-4, 0.0);
        assert!(a.hypot(b) < 1e-3, "near-neutral output not bounded — root-poly still present");
    }

    #[test]
    fn scene_v_taper_attenuates_highlights_not_mids() {
        // Taper on scene-V: high-V pixels nearly unchanged, mid-V pixels corrected.
        let t = ChromaTransform { hue_gains: [1.8; N_HUE_BINS], taper_lo: 0.35, taper_hi: 0.70 };
        // Mid pixel: V=0.18, some chroma
        let mut mid = Image {
            width: 1,
            height: 1,
            pixels: vec![[0.18_f32, 0.10, 0.10]],
            space: ColorSpace::SceneLinearRec2020,
        };
        // Highlight pixel: V=0.95
        let mut hi = Image {
            width: 1,
            height: 1,
            pixels: vec![[0.95_f32, 0.80, 0.80]],
            space: ColorSpace::SceneLinearRec2020,
        };
        let mid_before = crate::color::oklab::rec2020_to_oklab(mid.pixels[0]);
        let hi_before = crate::color::oklab::rec2020_to_oklab(hi.pixels[0]);
        t.apply_to_scene(&mut mid);
        t.apply_to_scene(&mut hi);
        let mid_after = crate::color::oklab::rec2020_to_oklab(mid.pixels[0]);
        let hi_after = crate::color::oklab::rec2020_to_oklab(hi.pixels[0]);
        let dc_mid = (mid_after[1] - mid_before[1]).hypot(mid_after[2] - mid_before[2]);
        let dc_hi = (hi_after[1] - hi_before[1]).hypot(hi_after[2] - hi_before[2]);
        assert!(dc_hi < 1e-4, "highlight pixel should be ~untouched by taper");
        assert!(dc_mid > 0.001, "mid pixel should be corrected");
    }

    // ── Task 3: production solve engages taper ───────────────────────────────

    #[test]
    fn production_solve_engages_taper() {
        // The taper returned from the production solve must NOT be the inert 2.0/3.0
        // defaults — they mean "taper above all normal scene values" = never fires.
        // This test uses a trivial identity solve (pairs where jpeg_ab == plain AgX
        // output) and checks the taper fields are set to the production consts.
        let scene = synth_scene(512);
        let pairs: Vec<Pair> = scene.iter().map(|&p| {
            let lab = crate::color::oklab::rec2020_to_oklab(p);
            Pair { raw_scene: p, raw_ab: (lab[1], lab[2]), jpeg_ab: (lab[1], lab[2]), weight: 1.0, x: 0, y: 0, clipped: false }
        }).collect();
        let mut t = solve_per_hue_gains(&pairs, 1.0);
        t.taper_lo = CHROMA_TAPER_LO;
        t.taper_hi = CHROMA_TAPER_HI;
        assert!(t.taper_lo < 1.5, "taper_lo={} is inert (should be ~0.10)", t.taper_lo);
        assert!(t.taper_hi < 1.5, "taper_hi={} is inert (should be ~0.30)", t.taper_hi);
        assert!(t.taper_lo < t.taper_hi, "taper window inverted");
    }

    // ── Task 1: per-hue scalar gain (new struct) ─────────────────────────────

    #[test]
    fn per_hue_gain_preserves_hue_angle() {
        // Scalar gain must not rotate hue.
        let mut t = ChromaTransform::identity();
        t.hue_gains = [1.5; N_HUE_BINS];
        let (a0, b0) = (0.2_f32, 0.1_f32);
        let (a1, b1) = t.map_ab(a0, b0);
        let hue0 = b0.atan2(a0);
        let hue1 = b1.atan2(a1);
        assert!((hue0 - hue1).abs() < 1e-5, "hue rotated: {hue0} → {hue1}");
        let c0 = a0.hypot(b0); let c1 = a1.hypot(b1);
        assert!((c1 / c0 - 1.5).abs() < 1e-4, "gain wrong: {}", c1 / c0);
    }

    #[test]
    fn gain_identity_is_noop() {
        let t = ChromaTransform::identity();
        let (a, b) = (0.15_f32, -0.08_f32);
        let (a2, b2) = t.map_ab(a, b);
        assert!((a - a2).abs() < 1e-6 && (b - b2).abs() < 1e-6);
    }

    #[test]
    fn near_zero_chroma_is_stable() {
        let mut t = ChromaTransform::identity();
        t.hue_gains = [2.5; N_HUE_BINS];
        let (a, b) = t.map_ab(0.0, 0.0);
        assert_eq!((a, b), (0.0, 0.0));
        let (a2, b2) = t.map_ab(1e-8, 0.0);
        assert!(a2.is_finite() && b2.is_finite());
    }

    // ── Task 2: per-hue solver recovery tests ────────────────────────────────

    #[test]
    fn per_hue_solver_recovers_known_gain() {
        use crate::image::ColorSpace;
        // Synthesise pairs where the "JPEG" has 1.4× the chroma of the AgX
        // output in a wide green hemisphere (~60°–180°, a≈neg, b≈pos). The gain
        // region is deliberately wide (±90° around 120°) so the gaussian kernel
        // (σ=40°) doesn't heavily dilute the signal at the bin centres — a ±30°
        // band would be washed out by out-of-band 1.0-gain pairs at σ=40°.
        let n = 3000;
        let scene: Vec<[f32; 3]> = (0..n).map(|i| {
            let hue = (i as f32 / n as f32) * std::f32::consts::TAU;
            let c = 0.08_f32;
            crate::color::oklab::oklab_to_rec2020([0.5, c * hue.cos(), c * hue.sin()])
        }).collect();
        // Get the post-AgX baseline (a, b) per pixel — jpeg_ab is defined as
        // 1.4× the post-AgX chroma in the green hemisphere (the solver's ratio
        // space), so the solver directly recovers the target gain.
        let baseline = forward_post_agx_ab(&scene, &ChromaTransform::identity(), 1.0);
        // Build pairs: jpeg_ab = agx_ab * gain (1.4 in green hemisphere [60°,180°], 1.0 elsewhere)
        let pairs: Vec<Pair> = scene.iter().zip(baseline.iter()).map(|(&p, &(ba, bb))| {
            let lab = crate::color::oklab::rec2020_to_oklab(p);
            let (a, b) = (lab[1], lab[2]);
            let hue = b.atan2(a);
            let green = 2.0 * std::f32::consts::PI / 3.0;
            let target_gain = if (hue - green).abs() < std::f32::consts::PI / 2.0 { 1.4 } else { 1.0 };
            Pair { raw_scene: p, raw_ab: (a, b), jpeg_ab: (ba * target_gain, bb * target_gain), weight: 1.0, x: 0, y: 0, clipped: false }
        }).collect();
        // Solve at k=1.0 (no damping) so we see the raw recovered gain
        let saved = std::env::var("MAPLE_CHROMA_STRENGTH_OVERRIDE").ok();
        // SAFETY: single-threaded test
        unsafe { std::env::set_var("MAPLE_CHROMA_STRENGTH_OVERRIDE", "1.0") };
        let t = solve_per_hue_gains(&pairs, 1.0);
        if let Some(v) = saved { unsafe { std::env::set_var("MAPLE_CHROMA_STRENGTH_OVERRIDE", v) }; }
        else { unsafe { std::env::remove_var("MAPLE_CHROMA_STRENGTH_OVERRIDE") }; }

        // Green bins: bin 3 (centre 105°) and bin 4 (centre 135°) are both deep inside [30°,210°]
        for &green_bin in &[3usize, 4usize] {
            let g = t.hue_gains[green_bin];
            assert!((g - 1.4).abs() < 0.15, "green bin {green_bin} gain={g}, expected ~1.4");
        }
        // Bins far from green: [240°, 360°) are well outside [30°, 210°] + σ tails.
        // Bin 8 centre=255°, bin 9=285°, bin 10=315°, bin 11=345° — all >60° from the boundary.
        for i in [8usize, 9, 10, 11] {
            assert!(t.hue_gains[i] < 1.15,
                "non-green bin {i} drifted to {}", t.hue_gains[i]);
        }
    }

    #[test]
    fn per_hue_solver_sparse_bins_stay_near_identity() {
        // Only red-hue samples — other bins starved. Must regularize to ≈1.0.
        let pairs: Vec<Pair> = (0..20).map(|_|
            Pair { raw_scene: [0.18, 0.08, 0.07],
                   raw_ab: (0.10, 0.01),       // hue ≈ 0° (red)
                   jpeg_ab: (0.14, 0.014),      // 1.4× gain on red
                   weight: 1.0,
                   x: 0,
                   y: 0,
                   clipped: false }
        ).collect();
        let t = solve_per_hue_gains(&pairs, 1.0);
        // Bins far from red (bins 3-9) must be regularized ≈ 1.0
        for i in 3..10 {
            assert!((t.hue_gains[i] - 1.0).abs() < 0.3,
                "sparse bin {i} not regularized: {}", t.hue_gains[i]);
        }
    }
}
