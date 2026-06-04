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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::oklab::rec2020_to_oklab;
    use crate::image::{ColorSpace, Image};

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
}
