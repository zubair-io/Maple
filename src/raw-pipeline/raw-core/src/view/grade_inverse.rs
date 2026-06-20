//! Inverse of the live scene-linear grade stages, for the inpainting
//! synthetic-raw composite (design doc §4).
//!
//! After [`crate::view::agx_inverse`] recovers *graded* scene-linear Rec.2020
//! from a model's display-referred output, these helpers continue the inverse
//! back to the **pre-user-grade** cached-buffer state so the patch can be
//! composited at the seam before `white_balance` and re-graded live like sensor
//! data. The Phase-0 spike exercises the ±EV / ±temp push matrix, so this
//! module inverts the two stages those pushes move:
//!
//!   * exposure — a pure `scene · 2^EV` multiply (`scene_tone_controls.rs:240`)
//!   * white balance — CAT16 matrix or diagonal Rec.2020 gains (`white_balance.rs`)
//!
//! `tone_curves` and the remaining `scene_tone_controls` (highlights/shadows/
//! whites/blacks/brightness) are monotone and inverted in Phase 1; they are not
//! on the ±EV/±temp axes the gate measures.

use crate::image::{ColorSpace, Image};
use crate::stages::white_balance::{wb_cat16_matrix, wb_gains};
use crate::types::WbMethod;

/// Inverse of the exposure multiply (forward: `scene · 2^ev`).
pub fn inverse_exposure(img: &mut Image, ev: f32) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    if ev.abs() < 1e-6 {
        return; // identity short-circuit
    }
    let g = (-ev).exp2();
    for p in &mut img.pixels {
        p[0] *= g;
        p[1] *= g;
        p[2] *= g;
    }
}

/// Inverse of `white_balance::apply(temperature, tint, method)`: map a graded
/// scene-linear pixel back to its pre-WB value. Identity short-circuit at the
/// (6500, 0) default mirrors the forward stage.
pub fn inverse_white_balance(img: &mut Image, temperature: f32, tint: f32, method: WbMethod) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    if (temperature - 6500.0).abs() < 0.5 && tint.abs() < 0.5 {
        return; // identity short-circuit (matches forward)
    }
    match method {
        WbMethod::Cat16 => {
            let m = wb_cat16_matrix(temperature, tint)
                .inverse()
                .expect("CAT16 WB matrix is non-singular for valid (T, tint)");
            for p in &mut img.pixels {
                *p = m.mul_vec(*p);
            }
        }
        WbMethod::DiagonalRec2020 => {
            let g = wb_gains(temperature, tint);
            for p in &mut img.pixels {
                p[0] /= g[0].max(1e-6);
                p[1] /= g[1].max(1e-6);
                p[2] /= g[2].max(1e-6);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stages::white_balance;

    #[test]
    fn exposure_inverse_roundtrips() {
        let pre = [0.2f32, 0.15, 0.1];
        for &ev in &[-2.0f32, -0.8, 0.0, 1.3, 2.0] {
            let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
            let g = ev.exp2();
            img.pixels[0] = [pre[0] * g, pre[1] * g, pre[2] * g];
            inverse_exposure(&mut img, ev);
            for c in 0..3 {
                assert!(
                    (img.pixels[0][c] - pre[c]).abs() < 1e-5,
                    "ev {} ch{} got {}",
                    ev,
                    c,
                    img.pixels[0][c]
                );
            }
        }
    }

    #[test]
    fn white_balance_inverse_roundtrips() {
        let pre = [0.2f32, 0.15, 0.1];
        for method in [WbMethod::Cat16, WbMethod::DiagonalRec2020] {
            for &(t, tint) in &[(4500.0f32, 20.0f32), (7500.0, -30.0), (3000.0, 0.0)] {
                let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
                img.pixels[0] = pre;
                white_balance::apply(&mut img, t, tint, method);
                inverse_white_balance(&mut img, t, tint, method);
                for c in 0..3 {
                    let rel = (img.pixels[0][c] - pre[c]).abs() / pre[c];
                    assert!(rel < 1e-4, "{:?} ({},{}) ch{} rel {}", method, t, tint, c, rel);
                }
            }
        }
    }

    #[test]
    fn full_grade_inverse_roundtrips() {
        // pre -> WB -> exposure  ==>  inverse_exposure -> inverse_white_balance -> pre
        let pre = [0.22f32, 0.14, 0.09];
        let (t, tint, ev, method) = (4800.0f32, 15.0f32, 0.9f32, WbMethod::Cat16);
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = pre;
        white_balance::apply(&mut img, t, tint, method);
        let g = ev.exp2();
        for p in &mut img.pixels {
            p[0] *= g;
            p[1] *= g;
            p[2] *= g;
        }
        inverse_exposure(&mut img, ev);
        inverse_white_balance(&mut img, t, tint, method);
        for c in 0..3 {
            let rel = (img.pixels[0][c] - pre[c]).abs() / pre[c];
            assert!(rel < 1e-4, "ch{} rel {} got {}", c, rel, img.pixels[0][c]);
        }
    }
}
