use super::*;

/// Condensed from the real PANO0001.DNG packet (Mavic 3 Cine /
/// L2D-20c): `drone-dji` bound to the `www.dji.com` URI, angles as
/// attributes of `rdf:Description`.
const DJI_MAVIC3_XMP: &str = r#"<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="DJI Meta Data"
xmlns:drone-dji="http://www.dji.com/drone-dji/1.0/"
xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   drone-dji:Version="1.2"
   drone-dji:GimbalRollDegree="+0.00"
   drone-dji:GimbalYawDegree="+87.90"
   drone-dji:GimbalPitchDegree="-1.30"
   drone-dji:FlightYawDegree="+87.40"
   crs:Version="7.0">
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>"#;

/// Condensed from the real pano_00/0000.DNG packet (Mavic 4 Pro /
/// L3D-100c): same prefix, *different* namespace URI (`www.uav.com`),
/// nadir pitch.
const DJI_MAVIC4_XMP: &str = r#"<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 7.0-c000">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="Meta Data"
xmlns:drone-dji="http://www.uav.com/drone-dji/1.0/"
   drone-dji:Version="1.6"
   drone-dji:GimbalRollDegree="+0.00"
   drone-dji:GimbalYawDegree="+125.00"
   drone-dji:GimbalPitchDegree="-90.00">
   <dc:description xmlns:dc="http://purl.org/dc/elements/1.1/">
<rdf:Alt><rdf:li xml:lang="x-default">default</rdf:li></rdf:Alt>
   </dc:description>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>"#;

#[test]
fn parses_mavic3_dji_com_namespace() {
    let g = parse_dji_gimbal(DJI_MAVIC3_XMP.as_bytes()).expect("gimbal");
    assert_eq!(g.yaw_deg, 87.90);
    assert_eq!(g.pitch_deg, -1.30);
    assert_eq!(g.roll_deg, 0.0);
}

#[test]
fn parses_mavic4_uav_com_namespace_variant() {
    let g = parse_dji_gimbal(DJI_MAVIC4_XMP.as_bytes()).expect("gimbal");
    assert_eq!(g.yaw_deg, 125.0);
    assert_eq!(g.pitch_deg, -90.0);
    assert_eq!(g.roll_deg, 0.0);
}

#[test]
fn rejects_packet_without_gimbal_attributes() {
    let xmp = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   crs:Version="7.0"/>
 </rdf:RDF>
</x:xmpmeta>"#;
    assert_eq!(parse_dji_gimbal(xmp.as_bytes()), None);
}

#[test]
fn rejects_partial_gimbal_triple() {
    // Yaw only — a packet shape we don't understand must yield no
    // prior at all rather than a half-filled one.
    let xmp = r#"<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description xmlns:drone-dji="http://www.dji.com/drone-dji/1.0/"
   drone-dji:GimbalYawDegree="+10.00"/>
</rdf:RDF>"#;
    assert_eq!(parse_dji_gimbal(xmp.as_bytes()), None);
}

#[test]
fn gimbal_names_under_foreign_namespace_are_ignored() {
    let xmp = r#"<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description xmlns:other="http://example.com/not-a-drone/1.0/"
   other:GimbalYawDegree="+10.00"
   other:GimbalPitchDegree="-1.00"
   other:GimbalRollDegree="+0.00"/>
</rdf:RDF>"#;
    assert_eq!(parse_dji_gimbal(xmp.as_bytes()), None);
}

#[test]
fn garbage_bytes_degrade_to_none() {
    assert_eq!(parse_dji_gimbal(&[0xFF, 0xFE, 0x00, 0x12]), None);
    assert_eq!(parse_dji_gimbal(b"<unclosed"), None);
}

#[test]
fn focal_px_matches_hand_computation_for_l2d_20c() {
    // PANO0001: f₃₅ = 24 mm, post-crop 5272×3948.
    let f = focal_px_from_exif(Some(24.0), 5272, 3948).expect("focal");
    let diag = ((5272.0f64).powi(2) + (3948.0f64).powi(2)).sqrt();
    let expected = 24.0 * diag / FULL_FRAME_DIAG_MM;
    assert!((f - expected).abs() < 1e-9);
    // Sanity anchor: ≈ 3653.6 px ⇒ 84.0° diagonal FOV (DJI's
    // published Mavic 3 wide-camera FOV).
    assert!((f - 3653.6).abs() < 1.0, "got {f}");
    let diag_fov = 2.0 * (diag / (2.0 * f)).atan().to_degrees();
    assert!((diag_fov - 84.0).abs() < 0.2, "diag FOV {diag_fov}");
}

#[test]
fn focal_px_requires_the_35mm_equivalent() {
    assert_eq!(focal_px_from_exif(None, 5272, 3948), None);
    assert_eq!(focal_px_from_exif(Some(0.0), 5272, 3948), None);
    assert_eq!(focal_px_from_exif(Some(-24.0), 5272, 3948), None);
    assert_eq!(focal_px_from_exif(Some(24.0), 0, 3948), None);
}

/// #2700: a Canon 5DS R-shaped full-frame body writes `FocalLength`
/// only. `FocalPlaneXResolution` measured against a 6000x4000 output
/// (3:2, matching the 36x24mm full-frame reference) resolves to a
/// sensor diagonal equal to `FULL_FRAME_DIAG_MM` — crop factor 1.0,
/// so the 35mm equivalent comes out equal to the raw focal length.
#[test]
fn derive_focal_35mm_equiv_full_frame_body_crop_factor_one() {
    let (width_px, height_px) = (6000_u32, 4000_u32);
    let diag_px = ((width_px as f64).powi(2) + (height_px as f64).powi(2)).sqrt();
    // sensor_diag_mm = diag_px * 25.4 / res = FULL_FRAME_DIAG_MM
    let res = (diag_px * 25.4 / FULL_FRAME_DIAG_MM) as f32;
    let f35 = derive_focal_35mm_equiv(Some(24.0), Some(res), Some(2), width_px, height_px)
        .expect("full-frame body should derive a 35mm equivalent");
    assert!((f35 - 24.0).abs() < 0.01, "got {f35}");
}

/// A Canon APS-C-shaped body (26.82 mm sensor diagonal — 22.3x14.9mm
/// — crop ≈ 1.613): the derived 35mm equivalent should scale by the
/// crop factor, not equal the raw focal length.
#[test]
fn derive_focal_35mm_equiv_crop_body_scales_by_crop_factor() {
    let (width_px, height_px) = (6000_u32, 4000_u32);
    let sensor_diag_mm = 26.82_f64;
    let diag_px = ((width_px as f64).powi(2) + (height_px as f64).powi(2)).sqrt();
    let res = (diag_px * 25.4 / sensor_diag_mm) as f32;
    let f35 = derive_focal_35mm_equiv(Some(18.0), Some(res), Some(2), width_px, height_px)
        .expect("crop body should derive a 35mm equivalent");
    let expected = 18.0 * (FULL_FRAME_DIAG_MM / sensor_diag_mm);
    assert!(
        (f35 as f64 - expected).abs() < 0.01,
        "got {f35}, expected {expected}"
    );
}

/// Centimetre resolution unit (`3`) is honoured, not just inches.
#[test]
fn derive_focal_35mm_equiv_accepts_centimetre_unit() {
    let (width_px, height_px) = (6000_u32, 4000_u32);
    let diag_px = ((width_px as f64).powi(2) + (height_px as f64).powi(2)).sqrt();
    // sensor_diag_mm = diag_px * 10.0 / res = FULL_FRAME_DIAG_MM
    let res = (diag_px * 10.0 / FULL_FRAME_DIAG_MM) as f32;
    let f35 = derive_focal_35mm_equiv(Some(24.0), Some(res), Some(3), width_px, height_px)
        .expect("cm-unit body should derive a 35mm equivalent");
    assert!((f35 - 24.0).abs() < 0.01, "got {f35}");
}

/// Non-3:2-aspect sensor (Four Thirds 4:3, 17.3x13mm — diagonal
/// 21.64mm, crop ≈ 1.999): the derivation must match the
/// diagonal-based crop factor and measurably diverge from what a
/// (wrong) width-only crop factor would give — locking in the fix
/// for the review finding that a width-only formula is ~4% off on
/// non-3:2 sensors (#2700 review).
#[test]
fn derive_focal_35mm_equiv_uses_diagonal_not_width_on_4_3_aspect_sensor() {
    let (width_px, height_px) = (5184_u32, 3888_u32); // 4:3 aspect
    let sensor_diag_mm = 21.64_f64;
    let diag_px = ((width_px as f64).powi(2) + (height_px as f64).powi(2)).sqrt();
    let res = (diag_px * 25.4 / sensor_diag_mm) as f32;

    let f35 = derive_focal_35mm_equiv(Some(12.5), Some(res), Some(2), width_px, height_px)
        .expect("should derive");
    let expected_diagonal = 12.5 * (FULL_FRAME_DIAG_MM / sensor_diag_mm);
    assert!(
        (f35 as f64 - expected_diagonal).abs() < 0.01,
        "got {f35}, expected {expected_diagonal}"
    );

    // What a (wrong) width-only crop factor would have given —
    // confirms this test sensor has a measurable diagonal-vs-width
    // divergence, and that `derive_focal_35mm_equiv` does NOT match
    // the width-only answer.
    let sensor_width_mm = width_px as f64 * 25.4 / res as f64;
    let expected_width_based = 12.5 * (36.0 / sensor_width_mm);
    assert!(
        (expected_diagonal - expected_width_based).abs() > 0.1,
        "test sensor should have a measurable diagonal-vs-width divergence"
    );
    assert!(
        (f35 as f64 - expected_width_based).abs() > 0.1,
        "derive_focal_35mm_equiv must not match the width-only formula"
    );
}

/// Portrait-orientation regression (#2700 review): `output_dims`
/// swaps width/height for a portrait EXIF orientation, so the
/// derivation must give an identical result whichever order the two
/// dimensions arrive in — true for the diagonal-based formula (the
/// width-only formula this replaced was NOT: it would silently use
/// the sensor's short edge as if it were the long edge).
#[test]
fn derive_focal_35mm_equiv_is_invariant_to_width_height_swap() {
    let (w, h) = (6000_u32, 4000_u32);
    let sensor_diag_mm = 28.0_f64;
    let diag_px = ((w as f64).powi(2) + (h as f64).powi(2)).sqrt();
    let res = (diag_px * 25.4 / sensor_diag_mm) as f32;

    let landscape = derive_focal_35mm_equiv(Some(20.0), Some(res), Some(2), w, h)
        .expect("landscape should derive");
    let portrait = derive_focal_35mm_equiv(Some(20.0), Some(res), Some(2), h, w)
        .expect("portrait (swapped) should derive");
    assert!(
        (landscape - portrait).abs() < 1e-6,
        "landscape {landscape} vs portrait {portrait} should be identical"
    );
}

#[test]
fn derive_focal_35mm_equiv_none_when_any_input_is_missing() {
    assert_eq!(
        derive_focal_35mm_equiv(None, Some(4233.3), Some(2), 6000, 4000),
        None
    );
    assert_eq!(
        derive_focal_35mm_equiv(Some(24.0), None, Some(2), 6000, 4000),
        None
    );
    // No resolution unit EXIF actually writes (only 2 = inches or
    // 3 = centimetres are real): no safe assumption, so None.
    assert_eq!(
        derive_focal_35mm_equiv(Some(24.0), Some(4233.3), None, 6000, 4000),
        None
    );
    assert_eq!(
        derive_focal_35mm_equiv(Some(24.0), Some(4233.3), Some(1), 6000, 4000),
        None
    );
    assert_eq!(
        derive_focal_35mm_equiv(Some(24.0), Some(4233.3), Some(2), 0, 4000),
        None
    );
    assert_eq!(
        derive_focal_35mm_equiv(Some(24.0), Some(4233.3), Some(2), 6000, 0),
        None
    );
    assert_eq!(
        derive_focal_35mm_equiv(Some(0.0), Some(4233.3), Some(2), 6000, 4000),
        None
    );
    assert_eq!(
        derive_focal_35mm_equiv(Some(24.0), Some(-1.0), Some(2), 6000, 4000),
        None
    );
}

/// #2700 review (Copilot on #3122): inputs that are each individually
/// finite and positive can still combine into a `focal_mm * crop_factor`
/// product that overflows `f32` — this must not leak a non-finite or
/// absurd `focal_35mm_equiv` into the BA solver seed. The final result
/// is guarded, not just the intermediate `sensor_diag_mm`.
#[test]
fn derive_focal_35mm_equiv_none_on_overflow() {
    // sensor_diag_mm = diag_px * 25.4 / res ≈ 1.83e-5 mm (an absurdly
    // tiny "sensor"), so crop_factor ≈ 2.36e6, and focal_mm (already an
    // extreme value) × crop_factor overflows f32::MAX (≈3.4e38).
    let huge_focal_mm = 1.0e35_f32;
    let huge_res = 1.0e10_f32;
    assert_eq!(
        derive_focal_35mm_equiv(Some(huge_focal_mm), Some(huge_res), Some(2), 6000, 4000),
        None
    );
}

/// End-to-end (#2700): a synthetic full-frame frame whose metadata
/// has no `FocalLengthIn35mmFormat` at all (the Canon 5DS R shape)
/// still resolves a usable `focal_px` through
/// `FramePriors::from_metadata`, instead of leaving it `None` (which
/// is what previously forced `StitchError::NoFocal`).
#[test]
fn from_metadata_derives_focal_px_for_synthetic_frame_lacking_35mm_exif() {
    let width_px = 6000_u32;
    let height_px = 4000_u32;
    let diag_px = ((width_px as f64).powi(2) + (height_px as f64).powi(2)).sqrt();
    // sensor diagonal = FULL_FRAME_DIAG_MM (full frame, crop 1.0)
    let res = (diag_px * 25.4 / FULL_FRAME_DIAG_MM) as f32;
    let md = PanoSourceMetadata {
        camera_make: "Canon".to_string(),
        camera_model: "Canon EOS 5DS R".to_string(),
        unique_camera_model: None,
        focal_mm: Some(24.0),
        focal_35mm_equiv: None, // the firmware omits this tag
        focal_plane_x_resolution: Some(res),
        focal_plane_resolution_unit: Some(2),
        orientation: raw_core::ExifOrientation::Normal,
        output_dims: (width_px, height_px),
        xmp_packet: None,
    };
    let priors = FramePriors::from_metadata(&md);
    let f35 = priors
        .focal_35mm_equiv
        .expect("should derive 35mm equivalent from sensor geometry");
    assert!((f35 - 24.0).abs() < 0.01, "got {f35}");
    let focal_px = priors
        .focal_px
        .expect("focal_px should be populated by the derived 35mm equivalent");
    let expected_focal_px = focal_px_from_exif(Some(f35), width_px, height_px).unwrap();
    assert!((focal_px - expected_focal_px).abs() < 1e-6);
}

/// A frame with no focal information at all (neither the direct EXIF
/// tag nor the sensor-geometry fallback) still leaves `focal_px`
/// `None` — the hard error at the call site is unavoidable, exactly
/// as before #2700.
#[test]
fn from_metadata_leaves_focal_px_none_without_any_focal_source() {
    let md = PanoSourceMetadata {
        camera_make: "Unknown".to_string(),
        camera_model: "Unknown".to_string(),
        unique_camera_model: None,
        focal_mm: None,
        focal_35mm_equiv: None,
        focal_plane_x_resolution: None,
        focal_plane_resolution_unit: None,
        orientation: raw_core::ExifOrientation::Normal,
        output_dims: (6000, 4000),
        xmp_packet: None,
    };
    let priors = FramePriors::from_metadata(&md);
    assert_eq!(priors.focal_35mm_equiv, None);
    assert_eq!(priors.focal_px, None);
}
