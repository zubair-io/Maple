use super::*;

#[test]
fn exif_wire_tags_round_trip_without_using_enum_discriminants() {
    for tag in 1..=8 {
        assert_eq!(ExifOrientation::from_u16(tag).to_u16(), tag);
    }
    assert_eq!(ExifOrientation::from_u16(0).to_u16(), 1);
    assert_eq!(ExifOrientation::from_u16(9).to_u16(), 1);
}

/// 2×3 RGB fixture: each pixel's R channel encodes a unique tag letter
/// (ASCII); G = 0, B = 0. After orientation, we can read out the tag
/// sequence to verify the pixel mapping. The image looks like:
///
///   A B
///   C D
///   E F
fn tag_fixture_2x3() -> (u32, u32, Vec<u8>) {
    let tags = [b'A', b'B', b'C', b'D', b'E', b'F'];
    let mut v = Vec::with_capacity(18);
    for t in tags {
        v.extend_from_slice(&[t, 0, 0]);
    }
    (2, 3, v)
}

fn read_tags(rgb: &[u8]) -> Vec<char> {
    rgb.chunks_exact(3).map(|c| c[0] as char).collect()
}

#[test]
fn apply_orientation_normal_is_identity() {
    let (w, h, rgb) = tag_fixture_2x3();
    let (nw, nh, out) = apply_orientation(&rgb, w, h, ExifOrientation::Normal);
    assert_eq!((nw, nh), (w, h));
    assert_eq!(read_tags(&out), vec!['A', 'B', 'C', 'D', 'E', 'F']);
}

#[test]
fn apply_orientation_rotate90_cw_2x3_to_3x2() {
    // 2×3 source →[90° CW]→ 3×2 result:
    //   A B             E C A
    //   C D       ⇒     F D B
    //   E F
    let (w, h, rgb) = tag_fixture_2x3();
    let (nw, nh, out) = apply_orientation(&rgb, w, h, ExifOrientation::Rotate90);
    assert_eq!((nw, nh), (3, 2));
    assert_eq!(read_tags(&out), vec!['E', 'C', 'A', 'F', 'D', 'B']);
}

#[test]
fn apply_orientation_rotate180_flips_both() {
    let (w, h, rgb) = tag_fixture_2x3();
    let (nw, nh, out) = apply_orientation(&rgb, w, h, ExifOrientation::Rotate180);
    assert_eq!((nw, nh), (w, h));
    // Reverse of A B C D E F → F E D C B A
    assert_eq!(read_tags(&out), vec!['F', 'E', 'D', 'C', 'B', 'A']);
}

#[test]
fn apply_orientation_horizontal_flip() {
    let (w, h, rgb) = tag_fixture_2x3();
    let (nw, nh, out) = apply_orientation(&rgb, w, h, ExifOrientation::HorizontalFlip);
    assert_eq!((nw, nh), (w, h));
    //   A B → B A
    //   C D → D C
    //   E F → F E
    assert_eq!(read_tags(&out), vec!['B', 'A', 'D', 'C', 'F', 'E']);
}

#[test]
fn apply_orientation_rotate270_ccw_2x3_to_3x2() {
    // 2×3 source →[270° CW = 90° CCW]→ 3×2 result:
    //   A B             B D F
    //   C D       ⇒     A C E
    //   E F
    let (w, h, rgb) = tag_fixture_2x3();
    let (nw, nh, out) = apply_orientation(&rgb, w, h, ExifOrientation::Rotate270);
    assert_eq!((nw, nh), (3, 2));
    assert_eq!(read_tags(&out), vec!['B', 'D', 'F', 'A', 'C', 'E']);
}

#[test]
fn apply_orientation_rotate90_then_rotate270_round_trips() {
    let (w, h, rgb) = tag_fixture_2x3();
    let (w1, h1, rgb1) = apply_orientation(&rgb, w, h, ExifOrientation::Rotate90);
    let (w2, h2, rgb2) = apply_orientation(&rgb1, w1, h1, ExifOrientation::Rotate270);
    assert_eq!((w2, h2), (w, h));
    assert_eq!(rgb2, rgb);
}

#[test]
fn new_image_zero_initialized() {
    let img = Image::new(4, 2, ColorSpace::SceneLinearRec2020);
    assert_eq!(img.pixel_count(), 8);
    assert!(img.pixels.iter().all(|p| *p == [0.0, 0.0, 0.0]));
}

#[test]
fn rggb_pattern_positions() {
    let p = CfaPattern::Rggb;
    assert_eq!(p.color_at(0, 0), 0); // R
    assert_eq!(p.color_at(1, 0), 1); // G
    assert_eq!(p.color_at(0, 1), 1); // G
    assert_eq!(p.color_at(1, 1), 2); // B
}

#[test]
fn bggr_pattern_positions() {
    let p = CfaPattern::Bggr;
    assert_eq!(p.color_at(0, 0), 2);
    assert_eq!(p.color_at(1, 1), 0);
}

#[test]
#[should_panic(expected = "expected colorspace")]
fn assert_space_panics_on_mismatch() {
    let img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
    img.assert_space(ColorSpace::DisplayLinearSrgb);
}

// ── has_lens_corrections / lens_correction_ca_inert (#2231) ──────────

fn fake_raw_with_opcodes(
    opcode_list3: Option<(
        crate::pipeline::pano::opcodes::OpcodeList3,
        crate::pipeline::pano::opcodes::ActiveAreaRect,
    )>,
) -> RawImage {
    RawImage {
        width: 4,
        height: 4,
        cfa: CfaPattern::Rggb,
        black_level: [0, 0, 0, 0],
        white_level: 1023,
        raw_data: vec![0u16; 16],
        as_shot_neutral: [1.0, 1.0, 1.0],
        as_shot_cct: None,
        camera_make: "Test".into(),
        camera_model: "Test".into(),
        unique_camera_model: None,
        color_matrices: HashMap::new(),
        forward_matrices: HashMap::new(),
        orientation: ExifOrientation::Normal,
        baseline_exposure: 0.0,
        hsm_data: HashMap::new(),
        plt: None,
        profile_tone_curve: None,
        profile_gain_table_map: None,
        crop_rect: None,
        iso: 100,
        noise_profile: None,
        opcode_list3,
        aperture: None,
        focal_length: None,
        lens_metadata: Default::default(),
    }
}

fn active_area() -> crate::pipeline::pano::opcodes::ActiveAreaRect {
    crate::pipeline::pano::opcodes::ActiveAreaRect {
        top: 0,
        left: 0,
        width: 4,
        height: 4,
    }
}

fn warp(planes: usize) -> crate::pipeline::pano::opcodes::PanoOpcode {
    use crate::pipeline::pano::opcodes::{PanoOpcode, WarpPlaneParams, WarpRectilinearOpcode};
    PanoOpcode::WarpRectilinear(WarpRectilinearOpcode {
        planes: (0..planes)
            .map(|_| WarpPlaneParams {
                kr: [1.0, 0.0, 0.0, 0.0],
                kt: [0.0, 0.0],
            })
            .collect(),
        center_x: 0.5,
        center_y: 0.5,
    })
}

fn vignette_only() -> crate::pipeline::pano::opcodes::PanoOpcode {
    use crate::pipeline::pano::opcodes::{FixVignetteRadialOpcode, PanoOpcode};
    PanoOpcode::FixVignetteRadial(FixVignetteRadialOpcode {
        k: [0.0, 0.0, 0.0, 0.0, 0.0],
        center_x: 0.5,
        center_y: 0.5,
    })
}

#[test]
fn no_opcode_list3_has_no_corrections_and_ca_is_inert() {
    let raw = fake_raw_with_opcodes(None);
    assert!(!raw.has_lens_corrections());
    assert!(raw.lens_correction_ca_inert());
    assert!(raw.lens_correction_distortion_inert());
}

#[test]
fn single_coefficient_warp_has_corrections_but_ca_is_inert() {
    use crate::pipeline::pano::opcodes::OpcodeList3;
    let raw = fake_raw_with_opcodes(Some((
        OpcodeList3 {
            opcodes: vec![warp(1)],
            skipped_unknown: 0,
        },
        active_area(),
    )));
    assert!(raw.has_lens_corrections());
    assert!(
        raw.lens_correction_ca_inert(),
        "a single coefficient set has no per-plane divergence"
    );
    assert!(
        !raw.lens_correction_distortion_inert(),
        "a single coefficient set is still a real geometric correction"
    );
}

#[test]
fn multi_plane_warp_has_corrections_and_ca_is_live() {
    use crate::pipeline::pano::opcodes::OpcodeList3;
    let raw = fake_raw_with_opcodes(Some((
        OpcodeList3 {
            opcodes: vec![warp(3)],
            skipped_unknown: 0,
        },
        active_area(),
    )));
    assert!(raw.has_lens_corrections());
    assert!(
        !raw.lens_correction_ca_inert(),
        "3 coefficient sets diverge per plane — CA is live"
    );
    assert!(!raw.lens_correction_distortion_inert());
}

#[test]
fn vignette_only_has_corrections_and_ca_is_inert() {
    use crate::pipeline::pano::opcodes::OpcodeList3;
    let raw = fake_raw_with_opcodes(Some((
        OpcodeList3 {
            opcodes: vec![vignette_only()],
            skipped_unknown: 0,
        },
        active_area(),
    )));
    assert!(
        raw.has_lens_corrections(),
        "vignette alone still counts as a lens correction"
    );
    assert!(
        raw.lens_correction_ca_inert(),
        "no WarpRectilinear opcode at all — CA has nothing to do"
    );
    assert!(
        raw.lens_correction_distortion_inert(),
        "#3189: no WarpRectilinear opcode at all — distortion has nothing to do"
    );
}

#[test]
fn warp_and_vignette_together_distortion_is_live() {
    // The distortion signal must key off WarpRectilinear's PRESENCE among
    // possibly-multiple opcodes, not assume it's the only one in the list.
    use crate::pipeline::pano::opcodes::OpcodeList3;
    let raw = fake_raw_with_opcodes(Some((
        OpcodeList3 {
            opcodes: vec![vignette_only(), warp(1)],
            skipped_unknown: 0,
        },
        active_area(),
    )));
    assert!(
        !raw.lens_correction_distortion_inert(),
        "a WarpRectilinear opcode alongside FixVignetteRadial still makes distortion live"
    );
}
