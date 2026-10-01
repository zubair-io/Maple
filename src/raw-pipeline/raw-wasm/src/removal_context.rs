//! Bounded fixed calibration context shared by CPU and WebGPU RAW sessions (#3955).
use raw_core::{cancel::CancelToken, image::RawImage, types::accepted_removal::NativeWindow};

/// Interleaved native f32 RGB in un-oriented DefaultCrop coordinates. Invoked
/// once per generation context, never by the slider render path. The current
/// fixed upstream policy remains an experiment, separate from saved rendering.
pub(crate) fn prepare(raw: &RawImage, rect: &[u32]) -> Result<Vec<f32>, String> {
    let [x, y, width, height] = rect else {
        return Err("removal context requires x,y,width,height".into());
    };
    let image = raw_core::pipeline::render_removal_calibration_context(
        raw,
        NativeWindow {
            x: *x,
            y: *y,
            width: *width,
            height: *height,
        },
        CancelToken::never(),
    )
    .map_err(|error| error.to_string())?;
    Ok(image.pixels.into_iter().flatten().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retained_context_is_shared_native_rgb_and_geometry_errors_are_explicit() {
        let bytes = include_bytes!("../../../../test-fixtures/removal/basic/source.dng");
        let raw = raw_core::decode_raw(bytes, "dng").unwrap();
        let window = NativeWindow {
            x: 1,
            y: 1,
            width: 7,
            height: 5,
        };
        let expected = raw_core::pipeline::render_removal_calibration_context(
            &raw,
            window,
            CancelToken::never(),
        )
        .unwrap();
        let values = prepare(&raw, &[1, 1, 7, 5]).unwrap();
        assert_eq!(
            values,
            expected.pixels.into_iter().flatten().collect::<Vec<_>>()
        );
        assert_eq!(values.len(), 7 * 5 * 3);
        assert!(prepare(&raw, &[1, 2, 3]).is_err());
        assert!(prepare(&raw, &[u32::MAX, 0, 7, 5]).is_err());
        assert!(prepare(&raw, &[0, 0, 1025, 1]).is_err());
    }
}
