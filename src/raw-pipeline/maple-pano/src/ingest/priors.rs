//! Initialization priors from source metadata (#1156, spec §5.1/§5.3).
//!
//! Two priors seed the rotation solve:
//!
//! - **Focal length in pixels** — derived from EXIF, used as the camera
//!   intrinsics seed (BA refines it; spec §5.3 "focal from EXIF").
//! - **DJI gimbal yaw/pitch/roll** — parsed from the `drone-dji` XMP
//!   packet when present. Strictly **advisory**: it seeds candidate-pair
//!   selection and BA initialization, never constrains the solution
//!   (spec §5.1).
//!
//! # Focal-in-pixels derivation
//!
//! EXIF gives `FocalLength` (`f_mm`) and the integer-rounded
//! `FocalLengthIn35mmFormat` (`f₃₅`). The 35mm-equivalent convention is
//! **diagonal-based**: `f₃₅ = f_mm · crop`, with
//! `crop = D₃₅ / sensor_diag_mm` and `D₃₅ = √(36² + 24²) ≈ 43.2666 mm`
//! (the full-frame diagonal). The pixel focal we want is
//! `f_px = f_mm / pixel_pitch_mm` with
//! `pixel_pitch_mm = sensor_diag_mm / image_diag_px`. Substituting:
//!
//! ```text
//! f_px = f_mm · image_diag_px / sensor_diag_mm
//!      = f_mm · image_diag_px · crop / D₃₅
//!      = f₃₅ · image_diag_px / D₃₅          (f_mm cancels)
//! ```
//!
//! so the derivation needs only the 35mm-equivalent and the pixel
//! dimensions of the decoded frame. `image_diag_px` uses the
//! post-DefaultCrop output dims (diagonal is orientation-invariant).
//!
//! **Accuracy:** `f₃₅` is integer-rounded by camera firmware (the DJI
//! L2D-20c writes 24 for a true ~24.6), so expect ~2–3 % error — checked
//! against the fixture: derived 3653.6 px ⇒ 84.0° diagonal FOV, matching
//! DJI's published 84° for the Mavic 3 wide camera. Fine for a BA seed,
//! which is this value's only consumer.
//!
//! **Fallbacks:** without `f₃₅` directly in EXIF, [`derive_focal_35mm_equiv`]
//! tries to derive it from `FocalLength` plus sensor geometry (`FocalPlane-
//! XResolution`/`FocalPlaneResolutionUnit`, #2700) — full-frame bodies like
//! the Canon 5DS R, which write only `FocalLength` (crop ≈ 1.0, so the
//! 35mm-equivalent IS the focal length), and crop bodies whose physical
//! sensor width comes out from that EXIF pair. Only when *neither* the
//! direct tag nor the sensor-geometry derivation succeeds does `focal_px`
//! stay `None` and the solver fall back to pairwise-homography focal
//! estimation (spec §5.3 — outside this ticket). `f_mm` alone is *not*
//! used on its own: a mm value without sensor size says nothing about
//! pixels.
//!
//! # DJI gimbal XMP
//!
//! Both known DJI packet flavours write the angles as XML **attributes**
//! on `rdf:Description`, but under *different* namespace URIs with the
//! same `drone-dji` prefix:
//!
//! - Mavic 3 (Hasselblad L2D-20c): `xmlns:drone-dji="http://www.dji.com/drone-dji/1.0/"`
//! - Mavic 4 (Hasselblad L3D-100c): `xmlns:drone-dji="http://www.uav.com/drone-dji/1.0/"`
//!
//! so the parser resolves attribute namespaces (quick-xml `NsReader`) and
//! accepts any URI containing `drone-dji`. Values carry explicit signs
//! (`"+87.90"`, `"-90.00"`) which Rust's `f64` parser accepts directly.
//! Angles are DJI's convention, carried raw: yaw 0 = North, clockwise
//! positive seen from above, ±180°; pitch 0 = level, −90 = nadir; roll
//! normally 0. Mapping into the crate's world frame is the solver's job.

use quick_xml::events::Event;
use quick_xml::name::ResolveResult;
use quick_xml::reader::NsReader;
use raw_core::PanoSourceMetadata;

/// 35mm full-frame diagonal, mm: `√(36² + 24²)`.
const FULL_FRAME_DIAG_MM: f64 = 43.266615305567875;

/// 35mm full-frame sensor width, mm — the reference width
/// [`derive_focal_35mm_equiv`]'s crop factor is taken against (#2700).
const FULL_FRAME_WIDTH_MM: f64 = 36.0;

/// DJI gimbal attitude as written in the XMP packet (degrees, DJI
/// conventions — see module docs). Advisory prior only.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GimbalPrior {
    pub yaw_deg: f64,
    pub pitch_deg: f64,
    pub roll_deg: f64,
}

/// Per-frame initialization priors derived from [`PanoSourceMetadata`].
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FramePriors {
    /// EXIF `FocalLength`, mm (carried for diagnostics/reporting).
    pub focal_mm: Option<f32>,
    /// EXIF `FocalLengthIn35mmFormat`, mm — or, when the source omits
    /// that tag, the value [`derive_focal_35mm_equiv`] derives from
    /// `FocalLength` plus sensor geometry (#2700). Either way this is
    /// what `focal_px` was computed from.
    pub focal_35mm_equiv: Option<f32>,
    /// Focal length in pixels (see module docs for derivation + error
    /// bars). `None` when EXIF lacks the 35mm-equivalent.
    pub focal_px: Option<f64>,
    /// DJI gimbal attitude, when the source carries a `drone-dji` XMP
    /// packet with all three angles.
    pub gimbal: Option<GimbalPrior>,
}

impl FramePriors {
    /// Derive the priors from a decode's metadata (works for both the
    /// full [`raw_core::decode_for_pano`] product and the metadata-only
    /// [`raw_core::read_pano_metadata`] pass — `output_dims` rides along
    /// in both).
    pub fn from_metadata(md: &PanoSourceMetadata) -> Self {
        let (w, h) = md.output_dims;
        let focal_35mm_equiv = md.focal_35mm_equiv.or_else(|| {
            derive_focal_35mm_equiv(
                md.focal_mm,
                md.focal_plane_x_resolution,
                md.focal_plane_resolution_unit,
                w,
            )
        });
        Self {
            focal_mm: md.focal_mm,
            focal_35mm_equiv,
            focal_px: focal_px_from_exif(focal_35mm_equiv, w, h),
            gimbal: md.xmp_packet.as_deref().and_then(parse_dji_gimbal),
        }
    }
}

/// `f_px = f₃₅ · √(w² + h²) / 43.2666` — see the module docs for the
/// derivation, accuracy, and fallback policy.
pub fn focal_px_from_exif(focal_35mm_equiv: Option<f32>, width: u32, height: u32) -> Option<f64> {
    let f35 = focal_35mm_equiv? as f64;
    if f35 <= 0.0 || width == 0 || height == 0 {
        return None;
    }
    let diag_px = ((width as f64).powi(2) + (height as f64).powi(2)).sqrt();
    Some(f35 * diag_px / FULL_FRAME_DIAG_MM)
}

/// Derive a 35mm-equivalent focal length from EXIF `FocalLength` plus
/// sensor geometry, for bodies whose firmware omits
/// `FocalLengthIn35mmFormat` (#2700) — e.g. full-frame Canon 5DS R CR2s,
/// where the 35mm equivalent IS the focal length (crop factor ≈ 1.0),
/// and crop bodies where it is derivable from the sensor's physical
/// width.
///
/// `focal_plane_x_resolution` (EXIF `FocalPlaneXResolution`, pixels per
/// `focal_plane_resolution_unit`) combined with the decoded image width
/// gives the sensor's physical width in millimetres; the crop factor is
/// `36mm / sensor_width_mm` (the reference full-frame sensor width).
/// `None` when any input is missing or non-positive, or the resolution
/// unit isn't one EXIF actually writes (`2` = inches, `3` =
/// centimetres) — there is no safe assumption to fall back on, and the
/// caller's hard error (`StitchError::NoFocal`) is then unavoidable.
pub fn derive_focal_35mm_equiv(
    focal_mm: Option<f32>,
    focal_plane_x_resolution: Option<f32>,
    focal_plane_resolution_unit: Option<u16>,
    image_width_px: u32,
) -> Option<f32> {
    let focal_mm = focal_mm.filter(|v| v.is_finite() && *v > 0.0)? as f64;
    let res = focal_plane_x_resolution.filter(|v| v.is_finite() && *v > 0.0)? as f64;
    let unit_mm_per_count = match focal_plane_resolution_unit {
        Some(2) => 25.4, // inches
        Some(3) => 10.0, // centimetres
        _ => return None,
    };
    if image_width_px == 0 {
        return None;
    }
    let sensor_width_mm = image_width_px as f64 * unit_mm_per_count / res;
    if !sensor_width_mm.is_finite() || sensor_width_mm <= 0.0 {
        return None;
    }
    let crop_factor = FULL_FRAME_WIDTH_MM / sensor_width_mm;
    Some((focal_mm * crop_factor) as f32)
}

/// Parse `drone-dji:Gimbal{Yaw,Pitch,Roll}Degree` out of a raw XMP packet.
///
/// Attribute-form only — both known DJI packet flavours (see module docs)
/// write the angles as attributes of `rdf:Description`. Returns `Some`
/// only when **all three** angles parse (DJI always writes the triple;
/// a partial set means a packet this parser doesn't understand, and a
/// wrong prior is worse than no prior). Malformed XML degrades to `None`,
/// never an error — the prior is advisory.
pub fn parse_dji_gimbal(xmp: &[u8]) -> Option<GimbalPrior> {
    let mut reader = NsReader::from_reader(xmp);
    // The xpacket wrapper and padding around the XML are fine for
    // quick-xml; non-UTF-8 or truncated packets surface as Err → None.
    let (mut yaw, mut pitch, mut roll) = (None, None, None);
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                for attr in e.attributes().with_checks(false).flatten() {
                    let (ns, local) = reader.resolve_attribute(attr.key);
                    let ResolveResult::Bound(ns) = ns else {
                        continue;
                    };
                    if !contains_subslice(ns.as_ref(), b"drone-dji") {
                        continue;
                    }
                    let slot = match local.as_ref() {
                        b"GimbalYawDegree" => &mut yaw,
                        b"GimbalPitchDegree" => &mut pitch,
                        b"GimbalRollDegree" => &mut roll,
                        _ => continue,
                    };
                    if let Ok(v) = attr.unescape_value() {
                        if let Ok(parsed) = v.trim().parse::<f64>() {
                            *slot = Some(parsed);
                        }
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => return None,
            _ => {}
        }
        buf.clear();
    }
    Some(GimbalPrior {
        yaw_deg: yaw?,
        pitch_deg: pitch?,
        roll_deg: roll?,
    })
}

/// `haystack.contains(needle)` for byte slices.
fn contains_subslice(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

#[cfg(test)]
mod tests {
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
    /// only. `FocalPlaneXResolution` measured against a 6000 px wide
    /// output resolves to a 36 mm sensor width — crop factor 1.0, so the
    /// 35mm equivalent comes out equal to the raw focal length.
    #[test]
    fn derive_focal_35mm_equiv_full_frame_body_crop_factor_one() {
        let width_px = 6000_u32;
        // sensor_width_mm = width_px * 25.4 / res = 36.0  =>  res = width_px * 25.4 / 36.0
        let res = width_px as f32 * 25.4 / 36.0;
        let f35 = derive_focal_35mm_equiv(Some(24.0), Some(res), Some(2), width_px)
            .expect("full-frame body should derive a 35mm equivalent");
        assert!((f35 - 24.0).abs() < 0.01, "got {f35}");
    }

    /// A Canon APS-C-shaped body (22.3 mm sensor width, crop ≈ 1.6143):
    /// the derived 35mm equivalent should scale by the crop factor, not
    /// equal the raw focal length.
    #[test]
    fn derive_focal_35mm_equiv_crop_body_scales_by_crop_factor() {
        let width_px = 6000_u32;
        let sensor_width_mm = 22.3_f64;
        let res = (width_px as f64 * 25.4 / sensor_width_mm) as f32;
        let f35 = derive_focal_35mm_equiv(Some(18.0), Some(res), Some(2), width_px)
            .expect("crop body should derive a 35mm equivalent");
        let expected = 18.0 * (36.0 / sensor_width_mm);
        assert!(
            (f35 as f64 - expected).abs() < 0.01,
            "got {f35}, expected {expected}"
        );
    }

    /// Centimetre resolution unit (`3`) is honoured, not just inches.
    #[test]
    fn derive_focal_35mm_equiv_accepts_centimetre_unit() {
        let width_px = 6000_u32;
        // sensor_width_mm = width_px * 10.0 / res = 36.0  =>  res = width_px * 10.0 / 36.0
        let res = width_px as f32 * 10.0 / 36.0;
        let f35 = derive_focal_35mm_equiv(Some(24.0), Some(res), Some(3), width_px)
            .expect("cm-unit body should derive a 35mm equivalent");
        assert!((f35 - 24.0).abs() < 0.01, "got {f35}");
    }

    #[test]
    fn derive_focal_35mm_equiv_none_when_any_input_is_missing() {
        assert_eq!(
            derive_focal_35mm_equiv(None, Some(4233.3), Some(2), 6000),
            None
        );
        assert_eq!(
            derive_focal_35mm_equiv(Some(24.0), None, Some(2), 6000),
            None
        );
        // No resolution unit EXIF actually writes (only 2 = inches or
        // 3 = centimetres are real): no safe assumption, so None.
        assert_eq!(
            derive_focal_35mm_equiv(Some(24.0), Some(4233.3), None, 6000),
            None
        );
        assert_eq!(
            derive_focal_35mm_equiv(Some(24.0), Some(4233.3), Some(1), 6000),
            None
        );
        assert_eq!(
            derive_focal_35mm_equiv(Some(24.0), Some(4233.3), Some(2), 0),
            None
        );
        assert_eq!(
            derive_focal_35mm_equiv(Some(0.0), Some(4233.3), Some(2), 6000),
            None
        );
        assert_eq!(
            derive_focal_35mm_equiv(Some(24.0), Some(-1.0), Some(2), 6000),
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
        let res = width_px as f32 * 25.4 / 36.0; // sensor width = 36mm (full frame)
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
}
