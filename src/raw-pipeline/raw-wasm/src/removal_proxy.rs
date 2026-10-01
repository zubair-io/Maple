//! Source-framed SDR input for selection models (#3934 / #3942 / #1472).
//! Reconstruction continues to use native signed/HDR calibration context.
use raw_core::{
    image::{apply_orientation, ExifOrientation, RawImage},
    pipeline::{RawInput, RenderQuality, ResolvedCalibrationRemovals},
    types::accepted_removal::ContentDigest,
    xmp::{AdjustmentModel, AutoExposureMode, LensProfileEnable},
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
    // A fixed As-Shot view excludes creative geometry and optical warps so
    // detector boxes and SAM prompts refer to the durable source coordinates.
    // Auto remains the default view, including its shared embedded-JPEG fit.
    let model = AdjustmentModel {
        inpaint_removals: requested.inpaint_removals,
        auto_exposure: AutoExposureMode::Off,
        sharpen_amount: 0.0,
        nr_color: 0.0,
        lens_profile_enable: LensProfileEnable::Off,
        ..Default::default()
    };
    let input = Some(RawInput::Bytes { bytes, ext });
    let (width, height, rgb) = if model.inpaint_removals.is_empty() {
        raw_core::pipeline::render_sized_from_raw_with_quality_and_source(
            raw,
            &model,
            RenderQuality::Auto,
            input,
            1024,
        )
    } else {
        stack
            .ok_or("saved removals have not been prepared for selection")?
            .render_display(
                raw,
                original,
                &model,
                RenderQuality::Auto,
                input,
                Some(1024),
                None,
            )
    }
    .map_err(|e| e.to_string())?;
    let inverse = match raw.orientation {
        ExifOrientation::Rotate90 => ExifOrientation::Rotate270,
        ExifOrientation::Rotate270 => ExifOrientation::Rotate90,
        other => other,
    };
    let (width, height, rgb) = if inverse == ExifOrientation::Normal {
        (width, height, rgb)
    } else {
        apply_orientation(&rgb, width, height, inverse)
    };
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
            raw.orientation = ExifOrientation::from_u16(orientation);
            let mut reference = render(&raw, &original, RAW, "dng", None, baseline).unwrap();
            let mut changed = render(&raw, &original, RAW, "dng", None, creative).unwrap();
            assert_eq!((reference.width(), reference.height()), (16, 8));
            assert_eq!(reference.take_rgb(), changed.take_rgb());
        }
    }
}
