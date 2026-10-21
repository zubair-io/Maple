//! Presented-frame geometry over the sensor-framed resident WebGPU chain:
//! EXIF orientation, then manual perspective in display framing, then the user
//! crop — the CPU display tail's order, folded into one present homography.
use raw_core::image::ExifOrientation;
use raw_core::stages::crop::CropPresentation;
use raw_core::stages::perspective::{aspect_ratio, Homography, Perspective};
use raw_core::xmp::AdjustmentModel;

pub(crate) fn display_dims(orientation: ExifOrientation, (w, h): (u32, u32)) -> (u32, u32) {
    if orientation.swaps_wh() {
        (h, w)
    } else {
        (w, h)
    }
}

/// What the canvas shows for a model: the surface size and the destination →
/// sensor mapping that fills it.
pub(crate) struct Presentation {
    pub dims: (u32, u32),
    pub geometry: raw_gpu::PresentGeometry,
}

pub(crate) fn presentation(
    orientation: ExifOrientation,
    sensor_dims: (u32, u32),
    model: &AdjustmentModel,
) -> Presentation {
    let (w, h) = display_dims(orientation, sensor_dims);
    let crop = CropPresentation::new(&model.crop, w, h);
    let perspective = Perspective::from_model(model);
    let display_to_sensor = Homography(orientation.display_to_sensor_matrix())
        .mul(&perspective.inverse_matrix(aspect_ratio(w, h)));
    let composed = display_to_sensor.mul(&crop.inverse);
    let geometry = if crop.resamples && !perspective.is_identity() {
        raw_gpu::PresentGeometry::from_stages(display_to_sensor.0, crop.inverse.0, (w, h))
    } else if composed == Homography::IDENTITY {
        raw_gpu::PresentGeometry::IDENTITY
    } else {
        raw_gpu::PresentGeometry::from_inverse(composed.0)
    };
    Presentation {
        dims: crop.dims,
        geometry,
    }
}

fn inverse(
    orientation: ExifOrientation,
    sensor_dims: (u32, u32),
    model: &AdjustmentModel,
) -> ((u32, u32), Homography) {
    let (w, h) = display_dims(orientation, sensor_dims);
    let perspective = Perspective::from_model(model).inverse_matrix(aspect_ratio(w, h));
    let crop = CropPresentation::new(&model.crop, w, h);
    let composed = Homography(orientation.display_to_sensor_matrix())
        .mul(&perspective)
        .mul(&crop.inverse);
    (crop.dims, composed)
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
            let (_, inverse) = inverse(orientation, (w, h), &AdjustmentModel::default());
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
                presentation(orientation, (w, h), &AdjustmentModel::default())
                    .geometry
                    .is_active(),
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
            let (_, composed) = inverse(orientation, (1200, 800), &model);
            for point in [(-0.8, 0.2), (0.1, -0.6), (0.7, 0.9)] {
                let (x, y) = upright.project(point.0, point.1).unwrap();
                let expected = sensor.project(x, y).unwrap();
                let actual = composed.project(point.0, point.1).unwrap();
                assert!((expected.0 - actual.0).abs() < 1e-6);
                assert!((expected.1 - actual.1).abs() < 1e-6);
            }
        }
    }

    #[test]
    fn crop_follows_orientation_and_matches_cpu_pixels_and_dimensions() {
        let (w, h) = (13, 8);
        let sensor: Vec<u8> = (0..w * h)
            .flat_map(|i| [(i % w * 10) as u8, (i / w * 10) as u8, 0])
            .collect();
        for tag in 1..=8 {
            let orientation = ExifOrientation::from_u16(tag);
            let (dw, dh, upright) = raw_core::image::apply_orientation(&sensor, w, h, orientation);
            for angle in [0.0, 90.0, 180.0, 270.0, 3.5, -12.0] {
                let crop = raw_core::types::Crop {
                    left: 0.2,
                    top: 0.1,
                    right: 0.9,
                    bottom: 0.8,
                    angle,
                };
                let model = AdjustmentModel {
                    crop,
                    ..Default::default()
                };
                let presented = presentation(orientation, (w, h), &model);
                let (cw, ch, expected) =
                    raw_core::stages::crop::apply_u8_rgb(&upright, dw, dh, &crop);
                assert_eq!(presented.dims, (cw, ch), "EXIF {tag}, angle {angle}");
                assert!(presented.geometry.is_active());
                if angle % 90.0 != 0.0 {
                    continue;
                }
                let (_, composed) = inverse(orientation, (w, h), &model);
                for y in 0..ch {
                    for x in 0..cw {
                        let (sx, sy) = composed
                            .project(
                                (x as f32 + 0.5) * 2.0 / cw as f32 - 1.0,
                                (y as f32 + 0.5) * 2.0 / ch as f32 - 1.0,
                            )
                            .unwrap();
                        let sx = ((sx + 1.0) * w as f32 * 0.5 - 0.5).round() as u32;
                        let sy = ((sy + 1.0) * h as f32 * 0.5 - 0.5).round() as u32;
                        let at = ((y * cw + x) * 3) as usize;
                        assert_eq!(
                            expected[at..at + 3],
                            [(sx * 10) as u8, (sy * 10) as u8, 0],
                            "EXIF {tag}, angle {angle}, ({x},{y})"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn an_identity_crop_keeps_the_upright_frame() {
        for tag in 1..=8 {
            let orientation = ExifOrientation::from_u16(tag);
            let presented = presentation(orientation, (13, 8), &AdjustmentModel::default());
            assert_eq!(presented.dims, display_dims(orientation, (13, 8)));
        }
    }

    #[test]
    fn crop_is_applied_after_perspective_in_display_framing() {
        let model = AdjustmentModel {
            perspective_rotate: 17.0,
            perspective_vertical: 12.0,
            crop: raw_core::types::Crop {
                left: 0.1,
                top: 0.2,
                right: 0.8,
                bottom: 0.9,
                angle: 4.0,
            },
            ..Default::default()
        };
        for tag in 1..=8 {
            let orientation = ExifOrientation::from_u16(tag);
            let (w, h) = display_dims(orientation, (1200, 800));
            let crop = CropPresentation::new(&model.crop, w, h);
            let perspective = Perspective::from_model(&model).inverse_matrix(aspect_ratio(w, h));
            let sensor = Homography(orientation.display_to_sensor_matrix());
            let (_, composed) = inverse(orientation, (1200, 800), &model);
            for point in [(-0.8, 0.2), (0.1, -0.6), (0.7, 0.9)] {
                let (x, y) = crop.inverse.project(point.0, point.1).unwrap();
                let (x, y) = perspective.project(x, y).unwrap();
                let expected = sensor.project(x, y).unwrap();
                let actual = composed.project(point.0, point.1).unwrap();
                assert!((expected.0 - actual.0).abs() < 1e-5, "EXIF {tag}");
                assert!((expected.1 - actual.1).abs() < 1e-5, "EXIF {tag}");
            }
        }
    }

    #[test]
    fn only_an_off_axis_crop_over_active_perspective_takes_the_two_stage_present() {
        let sensor = (1200, 800);
        let perspective = AdjustmentModel {
            perspective_vertical: 12.0,
            ..Default::default()
        };
        let crop = |angle| raw_core::types::Crop {
            left: 0.1,
            top: 0.2,
            right: 0.8,
            bottom: 0.9,
            angle,
        };
        for tag in 1..=8 {
            let orientation = ExifOrientation::from_u16(tag);
            let (w, h) = display_dims(orientation, sensor);
            for (model, staged) in [
                (
                    AdjustmentModel {
                        crop: crop(4.0),
                        ..perspective.clone()
                    },
                    true,
                ),
                (
                    AdjustmentModel {
                        crop: crop(90.0),
                        ..perspective.clone()
                    },
                    false,
                ),
                (
                    AdjustmentModel {
                        crop: crop(4.0),
                        ..Default::default()
                    },
                    false,
                ),
            ] {
                let presented = presentation(orientation, sensor, &model).geometry;
                let cropped = CropPresentation::new(&model.crop, w, h);
                let first = Homography(orientation.display_to_sensor_matrix())
                    .mul(&Perspective::from_model(&model).inverse_matrix(aspect_ratio(w, h)));
                let expected = if staged {
                    raw_gpu::PresentGeometry::from_stages(first.0, cropped.inverse.0, (w, h))
                } else {
                    raw_gpu::PresentGeometry::from_inverse(first.mul(&cropped.inverse).0)
                };
                assert_eq!(presented, expected, "EXIF {tag}, staged {staged}");
            }
        }
    }
}
