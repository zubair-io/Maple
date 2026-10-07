//! Shared EXIF display-to-sensor mapping for resident presentation (#4317).
use super::ExifOrientation;
impl ExifOrientation {
    /// Row-major inverse orientation in centred half-extent coordinates.
    /// Same pixel permutation as `apply_orientation`, with no image allocation.
    pub fn display_to_sensor_matrix(self) -> [f32; 9] {
        let (a, b, c, d) = match self {
            Self::Normal => (1.0, 0.0, 0.0, 1.0),
            Self::HorizontalFlip => (-1.0, 0.0, 0.0, 1.0),
            Self::Rotate180 => (-1.0, 0.0, 0.0, -1.0),
            Self::VerticalFlip => (1.0, 0.0, 0.0, -1.0),
            Self::Transpose => (0.0, 1.0, 1.0, 0.0),
            Self::Rotate90 => (0.0, 1.0, -1.0, 0.0),
            Self::Transverse => (0.0, -1.0, -1.0, 0.0),
            Self::Rotate270 => (0.0, -1.0, 1.0, 0.0),
        };
        [a, b, 0.0, c, d, 0.0, 0.0, 0.0, 1.0]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn all_eight_matrices_match_the_cpu_pixel_permutation() {
        let (w, h) = (7, 5);
        let rgb: Vec<u32> = (0..w * h).flat_map(|i| [i; 3]).collect();
        for tag in 1..=8 {
            let orientation = ExifOrientation::from_u16(tag);
            let (dw, dh, expected) = crate::image::apply_orientation(&rgb, w, h, orientation);
            let matrix = orientation.display_to_sensor_matrix();
            for y in 0..dh {
                for x in 0..dw {
                    let nx = (x as f32 + 0.5) / (dw as f32 * 0.5) - 1.0;
                    let ny = (y as f32 + 0.5) / (dh as f32 * 0.5) - 1.0;
                    let sx = ((matrix[0] * nx + matrix[1] * ny + 1.0) * w as f32 * 0.5 - 0.5)
                        .round() as u32;
                    let sy = ((matrix[3] * nx + matrix[4] * ny + 1.0) * h as f32 * 0.5 - 0.5)
                        .round() as u32;
                    assert_eq!(
                        sy * w + sx,
                        expected[((y * dw + x) * 3) as usize],
                        "tag {tag} at {x},{y}"
                    );
                }
            }
        }
    }
}
