//! Shared integer display tail for the live sensor-framed upload (#3982).
use raw_core::{
    image::ExifOrientation,
    stages::{crop::CropPresentation, perspective},
    xmp::AdjustmentModel,
};
use raw_gpu::{PresentGeometry, QuantizedDisplayTail};

fn oriented_dims(orientation: ExifOrientation, source: (u32, u32)) -> (u32, u32) {
    if orientation.swaps_wh() {
        (source.1, source.0)
    } else {
        source
    }
}

pub(crate) fn display_geometry(
    orientation: ExifOrientation,
    source: (u32, u32),
    model: &AdjustmentModel,
) -> PresentGeometry {
    let (w, h) = oriented_dims(orientation, source);
    let perspective = perspective::Perspective::from_model(model);
    let geometry = if perspective.is_identity() {
        PresentGeometry::IDENTITY
    } else {
        PresentGeometry::from_inverse(
            perspective
                .inverse_matrix(perspective::aspect_ratio(w, h))
                .0,
        )
    };
    geometry.with_quantized_tail(display_tail(orientation, source, model))
}

fn display_tail(
    orientation: ExifOrientation,
    source: (u32, u32),
    model: &AdjustmentModel,
) -> QuantizedDisplayTail {
    let (w, h) = oriented_dims(orientation, source);
    let crop = CropPresentation::new(&model.crop, w, h);
    let inverse = crop.inverse.0;
    let (out_w, out_h) = (crop.dims.0.max(1) as f32, crop.dims.1.max(1) as f32);
    let sx = [
        inverse[0] * w as f32 / out_w,
        inverse[1] * w as f32 / out_h,
        ((inverse[0] / out_w + inverse[1] / out_h - inverse[0] - inverse[1] + inverse[2] + 1.0)
            * w as f32
            * 0.5)
            - 0.5,
    ];
    let sy = [
        inverse[3] * h as f32 / out_w,
        inverse[4] * h as f32 / out_h,
        ((inverse[3] / out_w + inverse[4] / out_h - inverse[3] - inverse[4] + inverse[5] + 1.0)
            * h as f32
            * 0.5)
            - 0.5,
    ];
    let theta = -model.crop.angle.to_radians();
    let (sin, cos) = (theta.sin(), theta.cos());
    let crop_rotation = if crop.resamples {
        let fx = w as f32 * 0.5;
        let fy = h as f32 * 0.5;
        let translated_x = sx[2] - (0.5 - fx) * cos + (0.5 - fy) * sin - (fx - 0.5);
        let translated_y = sy[2] - (0.5 - fx) * sin - (0.5 - fy) * cos - (fy - 0.5);
        let origin_x = cos * translated_x + sin * translated_y;
        let origin_y = -sin * translated_x + cos * translated_y;
        [origin_x, origin_y, cos, sin]
    } else {
        [0.0, 0.0, 1.0, 0.0]
    };
    QuantizedDisplayTail {
        orientation_rows: orientation.display_pixel_rows(source.0, source.1),
        crop_rows: [[sx[0], sx[1], sx[2], 0.0], [sy[0], sy[1], sy[2], 0.0]],
        crop_rotation,
        dimensions: [w, h, 1, u32::from(crop.resamples)],
        output_size: [crop.dims.0, crop.dims.1],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use raw_core::types::Crop;

    fn source_point(tail: QuantizedDisplayTail, x: f32, y: f32) -> (f32, f32) {
        if tail.dimensions[3] == 1 {
            let [dx, dy, cos, sin] = tail.crop_rotation;
            let cx = tail.dimensions[0] as f32 * 0.5;
            let cy = tail.dimensions[1] as f32 * 0.5;
            let px = dx + x + 0.5 - cx;
            let py = dy + y + 0.5 - cy;
            (
                px * cos - py * sin + cx - 0.5,
                px * sin + py * cos + cy - 0.5,
            )
        } else {
            let [a, b, c, _] = tail.crop_rows[0];
            let [d, e, f, _] = tail.crop_rows[1];
            (a * x + b * y + c, d * x + e * y + f)
        }
    }

    fn expected_source(crop: &Crop, width: u32, height: u32, x: f32, y: f32) -> (f32, f32) {
        let mapping = CropPresentation::new(crop, width, height);
        let nx = (x + 0.5) * 2.0 / mapping.dims.0 as f32 - 1.0;
        let ny = (y + 0.5) * 2.0 / mapping.dims.1 as f32 - 1.0;
        let matrix = mapping.inverse.0;
        (
            (matrix[0] * nx + matrix[1] * ny + matrix[2] + 1.0) * width as f32 * 0.5 - 0.5,
            (matrix[3] * nx + matrix[4] * ny + matrix[5] + 1.0) * height as f32 * 0.5 - 0.5,
        )
    }

    #[test]
    fn quantized_crop_tail_matches_core_inverse_for_axis_and_rotated_crops() {
        for angle in [0.0, 3.5, 90.0] {
            let crop = Crop {
                left: 0.13,
                top: 0.17,
                right: 0.87,
                bottom: 0.91,
                angle,
            };
            let model = AdjustmentModel {
                crop: crop.clone(),
                ..AdjustmentModel::default()
            };
            let tail = display_tail(ExifOrientation::Normal, (101, 79), &model);
            let (width, height) = (tail.output_size[0], tail.output_size[1]);
            for (x, y) in [
                (0.0, 0.0),
                (width as f32 * 0.5, height as f32 * 0.5),
                (
                    width.saturating_sub(1) as f32,
                    height.saturating_sub(1) as f32,
                ),
            ] {
                let actual = source_point(tail, x, y);
                let expected = expected_source(&crop, 101, 79, x, y);
                assert!(
                    (actual.0 - expected.0).abs() < 0.02,
                    "x at {angle}°: {actual:?} != {expected:?}"
                );
                assert!(
                    (actual.1 - expected.1).abs() < 0.02,
                    "y at {angle}°: {actual:?} != {expected:?}"
                );
            }
        }
    }
}
