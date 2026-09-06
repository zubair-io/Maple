//! Verify picks against the actual pixel-orientation operation, including
//! mirrored cameras and non-square dimensions; independent of WB colour math.
use super::*;
use raw_core::image::apply_orientation;

#[test]
fn oriented_sample_addresses_the_painted_pixel_for_all_exif_orientations() {
    let (w, h) = (7_u32, 5_u32);
    let pixels: Vec<u32> = (0..w * h).flat_map(|id| [id; 3]).collect();
    for tag in 1..=8 {
        let orientation = ExifOrientation::from_u16(tag);
        let (dw, dh, displayed) = apply_orientation(&pixels, w, h, orientation);
        for y in 0..dh {
            for x in 0..dw {
                let (sx, sy) = display_point_to_sensor(
                    orientation,
                    x as f32 / (dw - 1) as f32,
                    y as f32 / (dh - 1) as f32,
                );
                let source_x = (sx * (w - 1) as f32).round() as u32;
                let source_y = (sy * (h - 1) as f32).round() as u32;
                assert_eq!(
                    pixels[((source_y * w + source_x) * 3) as usize],
                    displayed[((y * dw + x) * 3) as usize],
                    "orientation {tag}, pixel ({x}, {y})"
                );
            }
        }
    }
}

#[test]
fn oriented_entry_rejects_null_paths_without_dereferencing_them() {
    let mut out = MapleWbSample {
        temperature: 0.0,
        tint: 0.0,
        algorithm_version: 0,
    };
    assert_eq!(
        unsafe {
            maple_sample_white_balance_oriented(
                std::ptr::null(),
                std::ptr::null(),
                0.5,
                0.5,
                &mut out,
            )
        },
        1
    );
}
