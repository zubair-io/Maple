//! `sample_white_balance_from_bytes` — the neutral white-balance sampler
//! (#2434) for the Web render worker. Same transport as
//! `compute_auto_adjustments_from_bytes`: RAW bytes, extension, optional XMP;
//! the click point is normalised image-relative. A rejected sample is a
//! `JsError` whose message starts with a stable kind — `outside_image:`,
//! `clipped:`, `too_dark:`, `out_of_domain:` or `develop:` — followed by the
//! user-facing text, so the UI can phrase it without parsing prose.

use raw_core::stages::white_balance_sample::{sample_white_balance, WbSampleError};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct WbSample {
    pub temperature: f32,
    pub tint: f32,
    pub algorithm_version: u32,
}

fn kind_of(err: &WbSampleError) -> &'static str {
    match err {
        WbSampleError::OutsideImage => "outside_image",
        WbSampleError::Clipped => "clipped",
        WbSampleError::TooDark => "too_dark",
        WbSampleError::OutOfDomain => "out_of_domain",
        WbSampleError::Develop(_) => "develop",
    }
}

#[wasm_bindgen]
pub fn sample_white_balance_from_bytes(
    raw: &[u8],
    ext: &str,
    xmp: Option<String>,
    nx: f32,
    ny: f32,
) -> Result<WbSample, JsError> {
    let raw_img =
        raw_core::decode::decode_bytes(raw, ext).map_err(|e| JsError::new(&e.to_string()))?;
    let model = match xmp {
        Some(x) => raw_core::xmp::parse(&x).map_err(|e| JsError::new(&e.to_string()))?,
        None => raw_core::xmp::AdjustmentModel::default(),
    };
    sample_white_balance(&raw_img, &model, nx, ny)
        .map(|s| WbSample {
            temperature: s.temperature,
            tint: s.tint,
            algorithm_version: s.algorithm_version,
        })
        .map_err(|e| JsError::new(&format!("{}: {}", kind_of(&e), e)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_kinds_are_stable() {
        assert_eq!(kind_of(&WbSampleError::OutsideImage), "outside_image");
        assert_eq!(kind_of(&WbSampleError::Clipped), "clipped");
        assert_eq!(kind_of(&WbSampleError::TooDark), "too_dark");
        assert_eq!(kind_of(&WbSampleError::OutOfDomain), "out_of_domain");
        assert_eq!(kind_of(&WbSampleError::Develop("x".into())), "develop");
    }
}
