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
//! **Fallbacks:** without `f₃₅` there is no sensor geometry in EXIF to
//! pin the pitch against, so `focal_px` stays `None` and the solver falls
//! back to pairwise-homography focal estimation (spec §5.3 — outside this
//! ticket). `f_mm` alone is *not* used: a mm value without sensor size
//! says nothing about pixels.
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
    /// EXIF `FocalLengthIn35mmFormat`, mm.
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
        Self {
            focal_mm: md.focal_mm,
            focal_35mm_equiv: md.focal_35mm_equiv,
            focal_px: focal_px_from_exif(md.focal_35mm_equiv, w, h),
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
}
