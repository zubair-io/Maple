//! Upright canvas framing over the sensor-framed resident WebGPU chain.
use raw_core::image::ExifOrientation;
use raw_core::stages::perspective::{aspect_ratio, Homography, Perspective};
use raw_core::xmp::AdjustmentModel;

pub(crate) fn display_dims(orientation: ExifOrientation, (w, h): (u32, u32)) -> (u32, u32) {
    if orientation.swaps_wh() {
        (h, w)
    } else {
        (w, h)
    }
}

pub(crate) fn present_geometry(
    orientation: ExifOrientation,
    sensor_dims: (u32, u32),
    model: &AdjustmentModel,
) -> raw_gpu::PresentGeometry {
    let composed = inverse(orientation, sensor_dims, model);
    if composed == Homography::IDENTITY {
        raw_gpu::PresentGeometry::IDENTITY
    } else {
        raw_gpu::PresentGeometry::from_inverse(composed.0)
    }
}

fn inverse(
    orientation: ExifOrientation,
    sensor_dims: (u32, u32),
    model: &AdjustmentModel,
) -> Homography {
    let (w, h) = display_dims(orientation, sensor_dims);
    let perspective = Perspective::from_model(model).inverse_matrix(aspect_ratio(w, h));
    Homography(orientation.display_to_sensor_matrix()).mul(&perspective)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_exif_frames_match_cpu_pixel_permutations() {
        let (w, h) = (7, 4);
        let rgb: Vec<u32> = (0..w * h).flat_map(|i| [i; 3]).collect();
        for tag in 1..=8 {
            let orientation = ExifOrientation::from_u16(tag);
            let (dw, dh, upright) = raw_core::image::apply_orientation(&rgb, w, h, orientation);
            assert_eq!(display_dims(orientation, (w, h)), (dw, dh));
            let inverse = inverse(orientation, (w, h), &AdjustmentModel::default());
            for y in 0..dh {
                for x in 0..dw {
                    let (sx, sy) = inverse
                        .project(
                            (x as f32 + 0.5) * 2.0 / dw as f32 - 1.0,
                            (y as f32 + 0.5) * 2.0 / dh as f32 - 1.0,
                        )
                        .unwrap();
                    let sx = ((sx + 1.0) * w as f32 * 0.5 - 0.5).round() as u32;
                    let sy = ((sy + 1.0) * h as f32 * 0.5 - 0.5).round() as u32;
                    assert_eq!(
                        upright[((y * dw + x) * 3) as usize],
                        sy * w + sx,
                        "EXIF {tag}"
                    );
                }
            }
            assert_eq!(
                present_geometry(orientation, (w, h), &AdjustmentModel::default()).is_active(),
                tag != 1
            );
        }
    }
    #[test]
    fn perspective_uses_upright_aspect_before_mapping_back_to_sensor() {
        let model = AdjustmentModel {
            perspective_rotate: 17.0,
            perspective_vertical: 12.0,
            ..Default::default()
        };
        for tag in 1..=8 {
            let orientation = ExifOrientation::from_u16(tag);
            let (w, h) = display_dims(orientation, (1200, 800));
            let upright = Perspective::from_model(&model).inverse_matrix(aspect_ratio(w, h));
            let sensor = Homography(orientation.display_to_sensor_matrix());
            let composed = inverse(orientation, (1200, 800), &model);
            for point in [(-0.8, 0.2), (0.1, -0.6), (0.7, 0.9)] {
                let (x, y) = upright.project(point.0, point.1).unwrap();
                let expected = sensor.project(x, y).unwrap();
                let actual = composed.project(point.0, point.1).unwrap();
                assert!((expected.0 - actual.0).abs() < 1e-6);
                assert!((expected.1 - actual.1).abs() < 1e-6);
            }
        }
    }
}
