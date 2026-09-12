use super::*;

#[test]
fn the_srgb_labs_round_trip_is_an_exact_identity() {
    // The property Maple's own textbook CIELAB conversion did NOT have, and
    // the whole reason this file exists: a byte that goes in comes back
    // unchanged. Verified here over a stride-sampled sweep of the sRGB
    // cube; the same sweep at stride 1 in all three axes also passes, it is
    // just slow enough to be worth sampling in the unit suite.
    for r in (0..256).step_by(5) {
        for g in (0..256).step_by(11) {
            for b in (0..256).step_by(13) {
                let rgb = [r as u8, g as u8, b as u8];
                assert_eq!(labs_to_srgb(srgb_to_labs(rgb)), rgb, "{rgb:?}");
            }
        }
    }
}

#[test]
fn forward_lab_matches_libvips_own_output() {
    // Measured with sharp 0.34.5's `toColourspace('lab')` read back as
    // float — i.e. libvips' own `vips_XYZ2Lab` output — for these colours.
    // The tolerance is the LabS quantum (one count is 1/327.67 of an `L*`),
    // since these values come back through the 16-bit packing.
    let expected: [([u8; 3], f64); 6] = [
        ([255, 0, 0], 53.232883),
        ([0, 255, 0], 87.737045),
        ([0, 0, 255], 32.302586),
        ([128, 128, 128], 53.585018),
        ([10, 200, 50], 70.596603),
        ([90, 90, 90], 38.241798),
    ];
    for (rgb, l) in expected {
        let got = srgb_to_labs(rgb)[0] as f64 / LABS_PER_L;
        assert!((got - l).abs() < 0.005, "{rgb:?}: libvips {l}, got {got}");
    }
}

#[test]
fn black_and_white_land_on_the_ends_of_the_labs_range() {
    assert_eq!(srgb_to_labs([0, 0, 0])[0], 0);
    assert_eq!(srgb_to_labs([255, 255, 255])[0], 32767);
    assert_eq!(labs_to_srgb([0, 0, 0]), [0, 0, 0]);
    assert_eq!(labs_to_srgb([32767, 0, 0]), [255, 255, 255]);
}
