//! Source-framed SDR input for selection models (#3934 / #3942 / #1472).
//! Reconstruction continues to use native signed/HDR calibration context.
use raw_core::{
    image::RawImage,
    pipeline::{RawInput, ResolvedCalibrationRemovals},
    types::accepted_removal::ContentDigest,
};

pub(crate) fn render(
    raw: &RawImage,
    original: &ContentDigest,
    bytes: &[u8],
    ext: &str,
    stack: Option<&ResolvedCalibrationRemovals>,
    xmp: &str,
) -> Result<crate::native_detail::NativeDetailPatch, String> {
    let requested = crate::mask_registry::parse_model(Some(xmp)).map_err(|e| e.to_string())?;
    let (width, height, rgb) = raw_core::pipeline::render_removal_selection_proxy(
        raw,
        original,
        Some(RawInput::Bytes { bytes, ext }),
        stack,
        &requested.inpaint_removals,
    )
    .map_err(|e| e.to_string())?;
    Ok(crate::native_detail::NativeDetailPatch::from_rgb(
        width, height, rgb,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    const RAW: &[u8] = include_bytes!("../../../../test-fixtures/removal/basic/source.dng");
    #[test]
    fn selection_proxy_is_source_framed_and_excludes_user_geometry_and_grade() {
        let mut raw = raw_core::decode_raw(RAW, "dng").unwrap();
        let original = ContentDigest::for_bytes(RAW);
        let baseline = r#"<rdf:Description/>"#;
        let creative = r#"<rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="3" crs:Temperature="9000" crs:HasCrop="True" crs:CropLeft="0.25" crs:CropRight="0.75" crs:CropAngle="7" crs:PerspectiveX="50"/>"#;
        for orientation in 1..=8 {
            raw.orientation = raw_core::image::ExifOrientation::from_u16(orientation);
            let mut reference = render(&raw, &original, RAW, "dng", None, baseline).unwrap();
            let mut changed = render(&raw, &original, RAW, "dng", None, creative).unwrap();
            assert_eq!((reference.width(), reference.height()), (16, 8));
            assert_eq!(reference.take_rgb(), changed.take_rgb());
        }
    }
}
