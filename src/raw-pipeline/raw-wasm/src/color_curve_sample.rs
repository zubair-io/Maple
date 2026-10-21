//! `sample_color_curve_from_bytes` — the stage-input eyedropper (#5041) for
//! Oklab secondary color curves on the Web render worker.
//!
//! Develops a fast 512px preview up to the input of Stage 22b (`stages::color_curves`,
//! i.e. after WB, Exposure, Tone Curve, Vibrance, Saturation, and 8-band HSL,
//! but before AgX and Color Grading), averages a 5x5 patch around `(nx, ny)`,
//! and returns normalized `(u_h, u_c, u_l)` in `[0, 1]` plus Oklab `(l, c, hue_deg)`.

use raw_core::stages::color_curve_sample::{sample_color_curve_input, ColorCurveSampleError};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct ColorCurveSampleOut {
    pub u_h: f32,
    pub u_c: f32,
    pub u_l: f32,
    pub l: f32,
    pub c: f32,
    pub hue_deg: f32,
}

fn kind_of(err: &ColorCurveSampleError) -> &'static str {
    match err {
        ColorCurveSampleError::OutsideImage => "outside_image",
        ColorCurveSampleError::Neutral => "neutral",
        ColorCurveSampleError::TooDark => "too_dark",
        ColorCurveSampleError::Develop(_) => "develop",
    }
}

#[wasm_bindgen]
pub fn sample_color_curve_from_bytes(
    raw: &[u8],
    ext: &str,
    xmp: Option<String>,
    nx: f32,
    ny: f32,
) -> Result<ColorCurveSampleOut, JsError> {
    let raw_img =
        raw_core::decode::decode_bytes(raw, ext).map_err(|e| JsError::new(&e.to_string()))?;
    let model = match xmp {
        Some(x) => raw_core::xmp::parse(&x).map_err(|e| JsError::new(&e.to_string()))?,
        None => raw_core::xmp::AdjustmentModel::default(),
    };
    sample_color_curve_input(&raw_img, &model, nx, ny)
        .map(|s| ColorCurveSampleOut {
            u_h: s.u_h,
            u_c: s.u_c,
            u_l: s.u_l,
            l: s.l,
            c: s.chroma,
            hue_deg: s.hue_deg,
        })
        .map_err(|e| JsError::new(&format!("{}: {}", kind_of(&e), e)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_kinds_are_stable() {
        assert_eq!(
            kind_of(&ColorCurveSampleError::OutsideImage),
            "outside_image"
        );
        assert_eq!(kind_of(&ColorCurveSampleError::Neutral), "neutral");
        assert_eq!(kind_of(&ColorCurveSampleError::TooDark), "too_dark");
        assert_eq!(
            kind_of(&ColorCurveSampleError::Develop("x".into())),
            "develop"
        );
    }
}
