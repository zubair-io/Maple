//! Verified scene-linear handoff for retained host GPU grading (#3955).
//! Companion I/O and preparation occur at the cold host boundary.
use crate::{
    image::RawImage,
    pipeline::{finite_or_zero, RenderQuality, ResolvedCalibrationRemovals},
    types::accepted_removal::ContentDigest,
    xmp::AdjustmentModel,
    CancelToken, Result,
};

impl ResolvedCalibrationRemovals {
    /// No display transform, crop or quantization. The host strips stages it
    /// replays live, exactly as on ordinary scene-linear decode. Source/stack
    /// validation precedes shared calibrated development, and the original
    /// full-frame Whites anchor travels with the oriented f32 RGBA buffer.
    pub fn render_scene_linear_f32_with_anchors(
        &self,
        raw: &RawImage,
        original: &ContentDigest,
        model: &AdjustmentModel,
        quality: RenderQuality,
        max_long_edge: Option<u32>,
        cancel: CancelToken<'_>,
    ) -> Result<(u32, u32, Vec<f32>, f32, f32, f32)> {
        let (scene, gain) =
            self.develop_with_gain(raw, original, model, quality, max_long_edge, cancel)?;
        let rgba: Vec<f32> = scene
            .pixels
            .iter()
            .flat_map(|pixel| {
                [
                    finite_or_zero(pixel[0]),
                    finite_or_zero(pixel[1]),
                    finite_or_zero(pixel[2]),
                    1.0,
                ]
            })
            .collect();
        let (width, height, rgba) = crate::pipeline::orient::apply_orientation_f32_rgba(
            &rgba,
            scene.width,
            scene.height,
            raw.orientation,
        );
        Ok((
            width,
            height,
            rgba,
            gain,
            scene
                .whites_anchor_ev
                .expect("develop captures full-frame Whites anchor"),
            scene.nr_sampling_scale,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image::ExifOrientation;
    const RAW: &[u8] =
        include_bytes!("../../../../../../test-fixtures/removal/calibration/source.dng");

    #[test]
    fn empty_verified_handoff_preserves_ordinary_pixels_and_anchors_for_every_orientation() {
        let original = ContentDigest::for_bytes(RAW);
        let mut raw = crate::decode_raw(RAW, "dng").unwrap();
        let model = crate::pipeline::removal_context::anchor_model();
        for orientation in [
            ExifOrientation::Normal,
            ExifOrientation::HorizontalFlip,
            ExifOrientation::Rotate180,
            ExifOrientation::VerticalFlip,
            ExifOrientation::Transpose,
            ExifOrientation::Rotate90,
            ExifOrientation::Transverse,
            ExifOrientation::Rotate270,
        ] {
            raw.orientation = orientation;
            let saved =
                ResolvedCalibrationRemovals::prepare(&raw, &original, &[], &Default::default())
                    .unwrap();
            for quality in [
                RenderQuality::Preview,
                RenderQuality::Full,
                RenderQuality::Auto,
            ] {
                for cap in [None, Some(4)] {
                    let expected = match cap {
                        None => crate::pipeline::render_scene_linear_from_raw_with_quality_f32_cancellable_with_anchors(&raw, &model, quality, CancelToken::never()),
                        Some(cap) => crate::pipeline::render_scene_linear_sized_from_raw_with_quality_f32_cancellable_with_anchors(&raw, &model, quality, cap, CancelToken::never()),
                    }.unwrap();
                    assert_eq!(
                        saved
                            .render_scene_linear_f32_with_anchors(
                                &raw,
                                &original,
                                &model,
                                quality,
                                cap,
                                CancelToken::never()
                            )
                            .unwrap(),
                        expected
                    );
                }
            }
            assert!(saved
                .render_scene_linear_f32_with_anchors(
                    &raw,
                    &ContentDigest::for_bytes(b"changed"),
                    &model,
                    RenderQuality::Auto,
                    None,
                    CancelToken::never()
                )
                .is_err());
            let flag = std::sync::atomic::AtomicBool::new(true);
            assert!(matches!(
                saved.render_scene_linear_f32_with_anchors(
                    &raw,
                    &original,
                    &model,
                    RenderQuality::Auto,
                    Some(4),
                    CancelToken::new(&flag)
                ),
                Err(crate::Error::Cancelled)
            ));
        }
    }
}
