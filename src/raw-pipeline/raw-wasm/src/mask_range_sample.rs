//! `sample_mask_range_from_bytes` — the colour-range eyedropper (#362) for
//! the Web render worker. Same transport as `sample_white_balance_from_bytes`:
//! RAW bytes, extension, optional XMP; the click point is normalised
//! image-relative. Returns the four seeded `papp:Range*` coordinates (the
//! host keeps the layer's own band width and feather). A rejected sample is
//! a `JsError` whose message starts with a stable kind — `outside_image:`,
//! `neutral:`, `too_dark:` or `develop:` — followed by the user-facing
//! text, so the UI can phrase it without parsing prose.

use raw_core::stages::mask_range_sample::{sample_mask_range, RangeSampleError, RangeSeed};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct MaskRangeSeed {
    pub hue_deg: f32,
    pub chroma_min: f32,
    pub l_min: f32,
    pub l_max: f32,
}

fn kind_of(err: &RangeSampleError) -> &'static str {
    match err {
        RangeSampleError::OutsideImage => "outside_image",
        RangeSampleError::Neutral => "neutral",
        RangeSampleError::TooDark => "too_dark",
        RangeSampleError::Develop(_) => "develop",
    }
}

#[wasm_bindgen]
pub fn sample_mask_range_from_bytes(
    raw: &[u8],
    ext: &str,
    xmp: Option<String>,
    nx: f32,
    ny: f32,
) -> Result<MaskRangeSeed, JsError> {
    let raw_img =
        raw_core::decode::decode_bytes(raw, ext).map_err(|e| JsError::new(&e.to_string()))?;
    let model = match xmp {
        Some(x) => raw_core::xmp::parse(&x).map_err(|e| JsError::new(&e.to_string()))?,
        None => raw_core::xmp::AdjustmentModel::default(),
    };
    sample_mask_range(&raw_img, &model, nx, ny)
        .map(|s| {
            let seed = RangeSeed::from_sample(&s);
            MaskRangeSeed {
                hue_deg: seed.hue_deg,
                chroma_min: seed.chroma_min,
                l_min: seed.l_min,
                l_max: seed.l_max,
            }
        })
        .map_err(|e| JsError::new(&format!("{}: {}", kind_of(&e), e)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_kinds_are_stable() {
        assert_eq!(kind_of(&RangeSampleError::OutsideImage), "outside_image");
        assert_eq!(kind_of(&RangeSampleError::Neutral), "neutral");
        assert_eq!(kind_of(&RangeSampleError::TooDark), "too_dark");
        assert_eq!(kind_of(&RangeSampleError::Develop("x".into())), "develop");
    }
}
