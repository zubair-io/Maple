use super::*;
use raw_core::ExifGps;

fn make_exif() -> Exif {
    Exif {
        camera_make: Some("DJI".into()),
        camera_model: Some("FC3582".into()),
        lens_model: Some("DJI DL 35mm F2.8 LS ASPH".into()),
        iso: Some(200),
        shutter_s: Some(1.0 / 200.0),
        aperture: Some(2.8),
        focal_mm: Some(35.0),
        captured_at: None,
        gps: Some(ExifGps {
            lat_deg: 37.7749,
            lon_deg: -122.4194,
            altitude_m: Some(150.0),
        }),
        ..Default::default()
    }
}

#[test]
fn build_exif_blob_returns_some_for_rich_exif() {
    let blob = build_exif_blob(&make_exif()).expect("should produce a blob");
    // Must start with TIFF little-endian header "II" + magic 42.
    assert_eq!(&blob[0..2], b"II", "TIFF LE header");
    assert_eq!(u16::from_le_bytes([blob[2], blob[3]]), 42, "TIFF magic");
    assert!(blob.len() > 30, "blob too small: {} bytes", blob.len());
}

#[test]
fn build_exif_blob_returns_some_for_empty_exif() {
    // Even with no camera info, Software tag means we always get a blob.
    let blob = build_exif_blob(&Exif::default()).expect("Software tag alone → Some");
    assert_eq!(&blob[0..2], b"II");
}

#[test]
fn tiff_header_offset_points_to_ifd0() {
    let blob = build_exif_blob(&make_exif()).unwrap();
    let ifd0_offset = u32::from_le_bytes([blob[4], blob[5], blob[6], blob[7]]);
    assert_eq!(ifd0_offset, 8, "IFD0 must start at byte 8");
    let count = u16::from_le_bytes([blob[8], blob[9]]);
    assert!(count >= 1, "IFD0 must have at least 1 entry");
}

/// Parse the IFD0 entries and verify ExifIFD pointer is present and points
/// to a valid secondary IFD that itself contains the expected tags.
#[test]
fn exif_ifd_pointer_is_valid_and_contains_expected_tags() {
    let blob = build_exif_blob(&make_exif()).unwrap();

    // IFD0 at offset 8.
    let ifd0_count = u16::from_le_bytes([blob[8], blob[9]]) as usize;
    let mut exif_ifd_offset: Option<u32> = None;
    for i in 0..ifd0_count {
        let slot = 10 + i * 12;
        let tag = u16::from_le_bytes([blob[slot], blob[slot + 1]]);
        let value = u32::from_le_bytes([
            blob[slot + 8],
            blob[slot + 9],
            blob[slot + 10],
            blob[slot + 11],
        ]);
        if tag == TAG_EXIF_IFD {
            exif_ifd_offset = Some(value);
        }
    }

    let exif_off = exif_ifd_offset.expect("ExifIFD pointer must be in IFD0");
    assert!(
        (exif_off as usize) < blob.len(),
        "ExifIFD offset {exif_off} is out of blob (len={})",
        blob.len()
    );

    let exif_count =
        u16::from_le_bytes([blob[exif_off as usize], blob[exif_off as usize + 1]]) as usize;
    let mut found_tags: Vec<u16> = Vec::new();
    for i in 0..exif_count {
        let slot = exif_off as usize + 2 + i * 12;
        let tag = u16::from_le_bytes([blob[slot], blob[slot + 1]]);
        found_tags.push(tag);
    }

    assert!(
        found_tags.contains(&TAG_FNUMBER),
        "FNumber tag missing from EXIF IFD; found: {found_tags:x?}"
    );
    assert!(
        found_tags.contains(&TAG_ISO),
        "ISO tag missing from EXIF IFD; found: {found_tags:x?}"
    );
    assert!(
        found_tags.contains(&TAG_EXPOSURE_TIME),
        "ExposureTime tag missing from EXIF IFD; found: {found_tags:x?}"
    );
    assert!(
        found_tags.contains(&TAG_FOCAL_LENGTH),
        "FocalLength tag missing from EXIF IFD; found: {found_tags:x?}"
    );
}

#[test]
fn gps_dms_conversion_roundtrip() {
    // 37.7749° → d=37, m=46, s≈29640ms → reconstructed ≈ 37.7749
    let (d, m, s_ms) = decimal_to_dms(37.7749);
    assert_eq!(d, 37);
    assert_eq!(m, 46);
    let reconstructed = d as f64 + m as f64 / 60.0 + (s_ms as f64 / 1000.0) / 3600.0;
    assert!(
        (reconstructed - 37.7749).abs() < 1e-4,
        "reconstructed={reconstructed}"
    );
}

#[test]
fn exposure_rational_sub_second() {
    let (n, d) = to_exposure_rational(1.0 / 200.0);
    assert_eq!(n, 1);
    assert_eq!(d, 200);
}

#[test]
fn exposure_rational_long_exposure() {
    let (n, d) = to_exposure_rational(2.5);
    assert_eq!(n, 25);
    assert_eq!(d, 10);
}

#[test]
fn fnumber_rational_roundtrip() {
    let (n, d) = to_rational_100(2.8);
    assert_eq!(d, 100);
    let back = n as f32 / d as f32;
    assert!((back - 2.8).abs() < 0.01, "back={back}");
}

/// 0.6 s is NOT close to any 1/N shutter speed; the fallback high-precision
/// fraction must represent it accurately (within 0.5% of 0.6).
/// The old code returned 1/2 = 0.5, a 17% error.
#[test]
fn exposure_rational_non_reciprocal_sub_second() {
    let v = 0.6_f32;
    let (n, d) = to_exposure_rational(v);
    let reconstructed = n as f32 / d as f32;
    // Must not be 1/2.
    assert!(
        !(n == 1 && d == 2),
        "0.6s should NOT map to 1/2; got {n}/{d}"
    );
    // Must be within 0.5% of 0.6.
    let err = (reconstructed - v).abs() / v;
    assert!(
        err < 0.005,
        "reconstructed {reconstructed} is {:.2}% from {v}",
        err * 100.0
    );
}

/// Confirm that genuine 1/N values (e.g. 1/200, 1/60) still produce
/// exact reciprocal fractions.
#[test]
fn exposure_rational_genuine_reciprocal_stays_1_over_n() {
    let (n, d) = to_exposure_rational(1.0 / 60.0);
    assert_eq!(n, 1, "1/60 s → numerator must be 1, got {n}/{d}");
    assert_eq!(d, 60, "1/60 s → denominator must be 60, got {n}/{d}");

    let (n, d) = to_exposure_rational(1.0 / 1000.0);
    assert_eq!(n, 1);
    assert_eq!(d, 1000);
}
