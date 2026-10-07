//! Inverse display mapping for resident presentation (#4317).
//! Uses the same rect rounding and angle snapping as the CPU crop stage.
use super::{needs_apply, rect_in_pixels, snap_orthogonal, OrthogonalSnap};
use crate::{image::ExifOrientation, stages::perspective::Homography, types::Crop};

#[derive(Clone, Copy, Debug)]
pub struct CropPresentation {
    pub dims: (u32, u32),
    /// Normalized cropped-output coordinates to the full display frame.
    pub inverse: Homography,
    /// An off-axis crop samples an already-warped image when manual geometry
    /// is active. Hosts must preserve that second sampling operation.
    pub resamples: bool,
}

impl CropPresentation {
    pub fn new(crop: &Crop, width: u32, height: u32) -> Self {
        if width == 0 || height == 0 || !needs_apply(crop) {
            return Self {
                dims: (width, height),
                inverse: Homography::IDENTITY,
                resamples: false,
            };
        }
        let (x, y, w, h) = rect_in_pixels(crop, width, height);
        let (fw, fh) = (width as f32, height as f32);
        let rect = Homography([
            w as f32 / fw,
            0.0,
            (2 * x + w) as f32 / fw - 1.0,
            0.0,
            h as f32 / fh,
            (2 * y + h) as f32 / fh - 1.0,
            0.0,
            0.0,
            1.0,
        ]);
        let snap = snap_orthogonal(crop.angle);
        let orientation = match snap {
            OrthogonalSnap::Zero => ExifOrientation::Normal,
            OrthogonalSnap::Cw90 => ExifOrientation::Rotate90,
            OrthogonalSnap::Cw180 => ExifOrientation::Rotate180,
            OrthogonalSnap::Cw270 => ExifOrientation::Rotate270,
            OrthogonalSnap::Off => {
                // Off-axis CPU rotation is around the full frame centre,
                // whereas orthogonal rotation is around the sliced rect.
                let theta = -crop.angle.to_radians();
                let rotation = Homography([
                    theta.cos(),
                    -theta.sin() * fh / fw,
                    0.0,
                    theta.sin() * fw / fh,
                    theta.cos(),
                    0.0,
                    0.0,
                    0.0,
                    1.0,
                ]);
                return Self {
                    dims: (w, h),
                    inverse: rotation.mul(&rect),
                    resamples: true,
                };
            }
        };
        Self {
            dims: if orientation.swaps_wh() {
                (h, w)
            } else {
                (w, h)
            },
            inverse: rect.mul(&Homography(orientation.display_to_sensor_matrix())),
            resamples: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn presentation_matches_cpu_crop_pixels_and_dimensions() {
        let (w, h) = (31, 19);
        let rgb: Vec<u8> = (0..w * h)
            .flat_map(|i| [(i % 251) as u8, (i / w * 11) as u8, (i % w * 7) as u8])
            .collect();
        for angle in [
            0.0, 0.009, 90.0, 180.0, 270.0, -90.0, 360.0, 3.5, -12.0, 88.0,
        ] {
            for crop in [
                Crop {
                    left: 0.13,
                    top: 0.17,
                    right: 0.87,
                    bottom: 0.91,
                    angle,
                },
                Crop {
                    angle,
                    ..Crop::IDENTITY
                },
                Crop {
                    left: 0.9,
                    right: 0.1,
                    angle,
                    ..Crop::IDENTITY
                },
            ] {
                let mapping = CropPresentation::new(&crop, w, h);
                let (dw, dh, expected) = super::super::apply_u8_rgb(&rgb, w, h, &crop);
                assert_eq!(mapping.dims, (dw, dh));
                for y in 0..dh {
                    for x in 0..dw {
                        let nx = (x as f32 + 0.5) * 2.0 / dw as f32 - 1.0;
                        let ny = (y as f32 + 0.5) * 2.0 / dh as f32 - 1.0;
                        let m = mapping.inverse.0;
                        let sx = (m[0] * nx + m[1] * ny + m[2] + 1.0) * w as f32 * 0.5 - 0.5;
                        let sy = (m[3] * nx + m[4] * ny + m[5] + 1.0) * h as f32 * 0.5 - 0.5;
                        let actual = super::super::bilinear::sample_rgb(&rgb, w, h, sx, sy);
                        for (c, value) in actual.iter().enumerate() {
                            assert!(
                                value.abs_diff(expected[((y * dw + x) * 3) as usize + c]) <= 1,
                                "angle {angle}, {x},{y}, channel {c}"
                            );
                        }
                    }
                }
            }
        }
    }
}
