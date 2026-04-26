//! Ingest tests for T1.3.
//!
//! Cover the conversion from raw-core's scene-linear `Image` (Vec<[f32; 3]>
//! arrays of arrays) to the pano-core `PanoImage` (interleaved Vec<f32>).

use pano_core::{ingest, ColorSpace, Primaries, Transfer, WhitePoint};
use raw_core::image::{ColorSpace as RcColorSpace, ExifOrientation, Image};

#[test]
fn from_raw_core_image_preserves_pixels() {
    let mut src = Image::new(2, 2, RcColorSpace::SceneLinearRec2020);
    src.pixels[0] = [0.10, 0.20, 0.30];
    src.pixels[1] = [0.40, 0.50, 0.60];
    src.pixels[2] = [0.70, 0.80, 0.90];
    src.pixels[3] = [1.00, 1.10, 1.20];

    let pano = ingest::from_raw_core_image(&src, ExifOrientation::Normal);

    assert_eq!(pano.width, 2);
    assert_eq!(pano.height, 2);
    assert_eq!(pano.color, ColorSpace::rec2020_d65_linear());
    // Interleaved RGB.
    assert_eq!(pano.pixels.len(), 12);
    assert_eq!(pano.pixels[0..3], [0.10, 0.20, 0.30]);
    assert_eq!(pano.pixels[3..6], [0.40, 0.50, 0.60]);
    assert_eq!(pano.pixels[6..9], [0.70, 0.80, 0.90]);
    assert_eq!(pano.pixels[9..12], [1.00, 1.10, 1.20]);
    // All pixels valid by default.
    assert!(pano.validity.iter().all(|b| *b));
}

#[test]
fn from_raw_core_image_applies_orientation_rotate90_cw() {
    // 3 wide × 2 tall sensor:
    //
    //   row0: A B C
    //   row1: D E F
    //
    // EXIF Rotate90 means "displayed image is sensor rotated 90° CW".
    // Result is 2 wide × 3 tall:
    //
    //   row0: D A
    //   row1: E B
    //   row2: F C
    //
    // (left column of sensor becomes top row of result, bottom-to-top.)
    let mut src = Image::new(3, 2, RcColorSpace::SceneLinearRec2020);
    src.pixels[0] = [1.0, 0.0, 0.0]; // A
    src.pixels[1] = [0.0, 1.0, 0.0]; // B
    src.pixels[2] = [0.0, 0.0, 1.0]; // C
    src.pixels[3] = [1.0, 1.0, 0.0]; // D
    src.pixels[4] = [0.0, 1.0, 1.0]; // E
    src.pixels[5] = [1.0, 0.0, 1.0]; // F

    let pano = ingest::from_raw_core_image(&src, ExifOrientation::Rotate90);

    assert_eq!(pano.width, 2);
    assert_eq!(pano.height, 3);
    assert_eq!(pano.pixels[0..3], [1.0, 1.0, 0.0]); // D
    assert_eq!(pano.pixels[3..6], [1.0, 0.0, 0.0]); // A
    assert_eq!(pano.pixels[6..9], [0.0, 1.0, 1.0]); // E
    assert_eq!(pano.pixels[9..12], [0.0, 1.0, 0.0]); // B
    assert_eq!(pano.pixels[12..15], [1.0, 0.0, 1.0]); // F
    assert_eq!(pano.pixels[15..18], [0.0, 0.0, 1.0]); // C
}

#[test]
fn color_space_helpers_identity_check() {
    let cs = ColorSpace::rec2020_d65_linear();
    assert!(matches!(cs.primaries, Primaries::Bt2020));
    assert!(matches!(cs.white_point, WhitePoint::D65));
    assert!(matches!(cs.transfer, Transfer::Linear));
}
