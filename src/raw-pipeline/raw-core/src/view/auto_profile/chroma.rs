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

/// A root-polynomial chroma map on (a,b) plus a value-aware highlight taper.
/// `mat`/`bias`/`gain` express the linear term; `c2` the sqrt-magnitude
/// (root-polynomial) term; `taper_lo`/`taper_hi` attenuate the whole transform
/// toward identity as scene OKLAB L rises (the HSM-validated highlight guard).
/// Identity = `mat=I, bias=0, c2=0, gain=1`, taper above the L range.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ChromaTransform {
    pub mat: [[f32; 2]; 2],
    pub bias: [f32; 2],
    pub c2: [[f32; 2]; 2],
    pub gain: f32,
    pub taper_lo: f32,
    pub taper_hi: f32,
}

impl ChromaTransform {
    pub fn identity() -> Self {
        Self {
            mat: [[1.0, 0.0], [0.0, 1.0]],
            bias: [0.0, 0.0],
            c2: [[0.0; 2]; 2],
            gain: 1.0,
            taper_lo: 2.0,
            taper_hi: 3.0,
        }
    }

    /// Map (a,b) -> (a',b') (pure transform, before the value taper).
    #[inline]
    pub fn map_ab(&self, a: f32, b: f32) -> (f32, f32) {
        let g = self.gain;
        let ra = a.signum() * a.abs().sqrt();
        let rb = b.signum() * b.abs().sqrt();
        let na = g * (self.mat[0][0] * a + self.mat[0][1] * b)
            + self.c2[0][0] * ra
            + self.c2[0][1] * rb
            + self.bias[0];
        let nb = g * (self.mat[1][0] * a + self.mat[1][1] * b)
            + self.c2[1][0] * ra
            + self.c2[1][1] * rb
            + self.bias[1];
        (na, nb)
    }

    /// Apply in-place to a scene-linear Rec.2020 image. Keeps OKLAB L; tapers
    /// toward identity in highlights. Negative-component pixels are passed
    /// through unchanged (matching the HSM out-of-gamut bypass).
    pub fn apply_to_scene(&self, img: &mut Image) {
        img.pixels.par_iter_mut().for_each(|p| {
            if p[0] < 0.0 || p[1] < 0.0 || p[2] < 0.0 {
                return;
            }
            let lab = rec2020_to_oklab(*p);
            let (ta, tb) = self.map_ab(lab[1], lab[2]);
            // Value-aware taper toward identity as L rises (smoothstep).
            let t = ((lab[0] - self.taper_lo) / (self.taper_hi - self.taper_lo)).clamp(0.0, 1.0);
            let att = t * t * (3.0 - 2.0 * t);
            let na = lab[1] + (ta - lab[1]) * (1.0 - att);
            let nb = lab[2] + (tb - lab[2]) * (1.0 - att);
            *p = oklab_to_rec2020([lab[0], na, nb]);
        });
    }
}

/// Apply `t` to scene-linear samples, run AgX (the fixed forward tone model),
/// and return the **post-AgX** OKLAB `(a, b)` per sample. This is the primitive
/// the through-AgX solver (Task 4) minimizes its objective in: the solver
/// matches `forward_post_agx_ab(scene, T)` to the linearized JPEG's a/b, with
/// AgX as a fixed term in the loss, so the chroma cannot reproduce the HSM's
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

/// One sampled grid point: the RAW's pre-AgX scene-linear OKLAB `a/b`, the
/// linearized-JPEG OKLAB `a/b` target (both absolute Rec.2020 OKLAB), the JPEG
/// pixel position, a center-weight, and the clip flag.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Pair {
    /// RAW scene-linear (pre-AgX) OKLAB `(a, b)` at this grid point.
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
        // gain=1.5 scales a,b by 1.5; OKLAB L must survive within float noise.
        let t = ChromaTransform { gain: 1.5, ..ChromaTransform::identity() };
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
}
