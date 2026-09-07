//! Chroma-fringe suppression at high-contrast edges (#3407).
//!
//! Lightroom's Defringe control removes the purple / green colour fringes
//! that lateral chromatic aberration and sensor blooming leave along
//! high-contrast boundaries. Maple has no global Defringe slider — this
//! stage exists for the PER-MASK control (`PartialAdjustments::defringe`),
//! which is where a photographer actually reaches for it: on the branches
//! against a bright sky, not over the whole frame.
//!
//! # Algorithm
//!
//! A fringe is chroma that only exists because of an edge, so the stage
//! suppresses chroma in proportion to how edge-like the pixel is:
//!
//! 1. Build the scene-linear Rec.2020 luma plane.
//! 2. At each pixel take the RELATIVE gradient — the central-difference
//!    magnitude divided by the local luma. Relative rather than absolute so
//!    the detector is exposure-invariant: a 2:1 edge reads the same at any
//!    exposure, which an absolute threshold would not.
//! 3. Turn that into an edge weight with a smoothstep between
//!    [`EDGE_LO`] and [`EDGE_HI`], so ordinary texture contributes nothing
//!    and only genuinely steep boundaries are treated as fringe candidates.
//! 4. Scale the pixel's Oklab chroma (a, b) by `1 − amount·edge`, leaving
//!    lightness untouched. At `amount = 100` a fully edge-classified pixel
//!    goes achromatic; everywhere else the chroma is reduced smoothly.
//!
//! Oklab is the right space for the suppression because its a/b axes are
//! perceptual chroma with lightness factored out, so scaling them cannot
//! darken or brighten the pixel — exactly the property the
//! `noise_reduction` chroma path already relies on.
//!
//! # Stencil
//!
//! Central differences read one neighbour per axis, so the reach is
//! [`DEFRINGE_REACH_PX`] = 1 px per side. The tile path's overlap
//! calculator adds that when a layer engages the control.

use rayon::prelude::*;

use crate::color::oklab::{oklab_to_rec2020, rec2020_to_oklab};
use crate::image::{ColorSpace, Image};

/// Rec.2020 luminance coefficients — the same weights every other
/// scene-linear stage in this tree uses.
const LUMA_REC2020: [f32; 3] = [0.2627, 0.6780, 0.0593];

/// Relative-gradient value below which a pixel is not an edge at all.
/// 0.35 is a ~1.4:1 luma step across two pixels — well above the local
/// contrast of ordinary texture at the pixel scale.
const EDGE_LO: f32 = 0.35;

/// Relative gradient at which a pixel is fully edge-classified. 1.2 is
/// roughly a 3:1 step across two pixels, the regime where a fringe is
/// visible in the first place.
const EDGE_HI: f32 = 1.2;

/// Luma floor for the relative gradient's divisor. Below this the pixel
/// carries no usable signal and the quotient stops being a ratio — the same
/// guard `clarity` / `texture` apply to their own luma divisions.
const LUMA_FLOOR: f32 = 1e-6;

/// Spatial reach of the stage, in pixels per side, for the tile path's
/// overlap calculator (#1157): one central-difference neighbour per axis.
pub const DEFRINGE_REACH_PX: usize = 1;

/// Hermite smoothstep, matching `scene_tone_controls::smoothstep`.
fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Suppress chroma at high-contrast edges. `amount` is 0 … 100; 0 (and any
/// value below the shared 1e-3 engage threshold) is identity and
/// short-circuits without touching pixels.
pub fn apply(img: &mut Image, amount: f32) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    if amount.abs() < 1e-3 {
        return;
    }
    let strength = (amount / 100.0).clamp(0.0, 1.0);
    let w = img.width as usize;
    let h = img.height as usize;
    if w == 0 || h == 0 {
        return;
    }

    let luma: Vec<f32> = img
        .pixels
        .par_iter()
        .map(|p| LUMA_REC2020[0] * p[0] + LUMA_REC2020[1] * p[1] + LUMA_REC2020[2] * p[2])
        .collect();

    img.pixels
        .par_chunks_mut(w)
        .enumerate()
        .for_each(|(y, row)| {
            let up = y.saturating_sub(1) * w;
            let down = (y + 1).min(h - 1) * w;
            let here = y * w;
            for (x, p) in row.iter_mut().enumerate() {
                let left = x.saturating_sub(1);
                let right = (x + 1).min(w - 1);
                let centre = luma[here + x];
                if centre <= LUMA_FLOOR {
                    continue;
                }
                let dx = luma[here + right] - luma[here + left];
                let dy = luma[down + x] - luma[up + x];
                let relative = (dx.abs() + dy.abs()) / centre;
                let edge = smoothstep(EDGE_LO, EDGE_HI, relative);
                if edge <= 0.0 {
                    continue;
                }
                let scale = 1.0 - strength * edge;
                let lab = rec2020_to_oklab(*p);
                *p = oklab_to_rec2020([lab[0], lab[1] * scale, lab[2] * scale]);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(w: u32, h: u32, fill: impl Fn(usize, usize) -> [f32; 3]) -> Image {
        let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
        for y in 0..h as usize {
            for x in 0..w as usize {
                img.pixels[y * w as usize + x] = fill(x, y);
            }
        }
        img
    }

    fn chroma(p: [f32; 3]) -> f32 {
        let lab = rec2020_to_oklab(p);
        (lab[1] * lab[1] + lab[2] * lab[2]).sqrt()
    }

    #[test]
    fn zero_amount_is_a_bit_identical_no_op() {
        let before = image(8, 8, |x, y| [0.1 * x as f32, 0.05 * y as f32, 0.2]);
        let mut after = before.clone();
        apply(&mut after, 0.0);
        assert_eq!(after.pixels, before.pixels);
    }

    #[test]
    fn a_flat_coloured_field_is_untouched() {
        let before = image(8, 8, |_, _| [0.4, 0.1, 0.5]);
        let mut after = before.clone();
        apply(&mut after, 100.0);
        assert_eq!(
            after.pixels, before.pixels,
            "no gradient means no edge means no suppression"
        );
    }

    #[test]
    fn a_magenta_fringe_on_a_hard_edge_loses_chroma() {
        // Column 3 is the fringe: a magenta pixel sitting on the step
        // between a dark and a bright band.
        let mut img = image(8, 4, |x, _| {
            if x == 3 {
                [0.6, 0.1, 0.6]
            } else if x < 3 {
                [0.02, 0.02, 0.02]
            } else {
                [0.9, 0.9, 0.9]
            }
        });
        let before = chroma(img.pixels[3]);
        apply(&mut img, 100.0);
        let after = chroma(img.pixels[3]);
        assert!(
            after < before * 0.5,
            "fringe chroma should be more than halved: {before} -> {after}"
        );
    }

    #[test]
    fn lightness_survives_the_suppression() {
        let mut img = image(8, 4, |x, _| {
            if x == 3 {
                [0.6, 0.1, 0.6]
            } else if x < 3 {
                [0.02, 0.02, 0.02]
            } else {
                [0.9, 0.9, 0.9]
            }
        });
        let before = rec2020_to_oklab(img.pixels[3])[0];
        apply(&mut img, 100.0);
        let after = rec2020_to_oklab(img.pixels[3])[0];
        assert!(
            (after - before).abs() < 1e-3,
            "Oklab L must be preserved: {before} -> {after}"
        );
    }

    #[test]
    fn strength_scales_monotonically() {
        let seed = image(8, 4, |x, _| {
            if x == 3 {
                [0.6, 0.1, 0.6]
            } else if x < 3 {
                [0.02, 0.02, 0.02]
            } else {
                [0.9, 0.9, 0.9]
            }
        });
        let sample = |amount: f32| {
            let mut img = seed.clone();
            apply(&mut img, amount);
            chroma(img.pixels[3])
        };
        let (full, half, none) = (sample(100.0), sample(50.0), sample(0.0));
        assert!(full < half, "100 must suppress more than 50");
        assert!(half < none, "50 must suppress more than 0");
    }

    #[test]
    fn a_one_pixel_image_is_handled_without_panicking() {
        let mut img = image(1, 1, |_, _| [0.5, 0.2, 0.4]);
        apply(&mut img, 100.0);
        assert_eq!(img.pixels.len(), 1);
    }
}
