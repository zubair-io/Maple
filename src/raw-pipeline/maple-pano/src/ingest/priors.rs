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
//! sensor diagonal comes out from that EXIF pair. Only when *neither* the
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
                h,
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
/// diagonal.
///
/// `focal_plane_x_resolution` (EXIF `FocalPlaneXResolution`, pixels per
/// `focal_plane_resolution_unit`) combined with `width_px`/`height_px`
/// gives the sensor's physical diagonal in millimetres (pixels are
/// assumed square — true for essentially every photographic sensor —
/// so the single X-axis resolution applies to both dimensions); the
/// crop factor is `43.2666mm / sensor_diag_mm` ([`FULL_FRAME_DIAG_MM`]),
/// matching [`focal_px_from_exif`]'s diagonal-based convention exactly —
/// deliberately **not** a width-based crop factor, which would both
/// diverge from the diagonal-based convention on non-3:2-aspect sensors
/// and, worse, silently break under a portrait EXIF orientation (a
/// width-only crop factor needs the correct, un-swapped axis; a
/// diagonal is invariant to which of the two dimensions is called
/// "width"). `width_px`/`height_px` should be `output_dims` — the same
/// pair [`focal_px_from_exif`] takes — so the diag-pixel term this
/// function derives `focal_35mm_equiv` from is *identical* to the one
/// `focal_px_from_exif` immediately re-multiplies by, canceling out any
/// crop-margin ambiguity in what "the sensor's pixel dimensions" means.
///
/// `None` when any input is missing or non-positive, or the resolution
/// unit isn't one EXIF actually writes (`2` = inches, `3` =
/// centimetres) — there is no safe assumption to fall back on, and the
/// caller's hard error (`StitchError::NoFocal`) is then unavoidable.
pub fn derive_focal_35mm_equiv(
    focal_mm: Option<f32>,
    focal_plane_x_resolution: Option<f32>,
    focal_plane_resolution_unit: Option<u16>,
    width_px: u32,
    height_px: u32,
) -> Option<f32> {
    let focal_mm = focal_mm.filter(|v| v.is_finite() && *v > 0.0)? as f64;
    let res = focal_plane_x_resolution.filter(|v| v.is_finite() && *v > 0.0)? as f64;
    let unit_mm_per_count = match focal_plane_resolution_unit {
        Some(2) => 25.4, // inches
        Some(3) => 10.0, // centimetres
        _ => return None,
    };
    if width_px == 0 || height_px == 0 {
        return None;
    }
    let diag_px = ((width_px as f64).powi(2) + (height_px as f64).powi(2)).sqrt();
    let sensor_diag_mm = diag_px * unit_mm_per_count / res;
    if !sensor_diag_mm.is_finite() || sensor_diag_mm <= 0.0 {
        return None;
    }
    let crop_factor = FULL_FRAME_DIAG_MM / sensor_diag_mm;
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
mod tests;
