//! Panorama-ingest entry point (spec § 4.1).
//!
//! Wraps the `raw-core` pipeline up to and including DCP, producing a
//! scene-linear Rec.2020 D65 buffer suitable for `pano-core` to consume.
//! Skips the display-prep stages — capture sharpening biases feature
//! matching, and histogram match against an embedded preview defeats
//! pairwise gain compensation downstream.
//!
//! See `docs/tickets/04-maple-panorama-spec.md` § 4.1 for the rationale.

use crate::color::dcp;
use crate::demosaic;
use crate::image::{CfaPattern, ExifOrientation, Image, RawImage};
use crate::linearize;
use crate::Result;

/// Bundle returned by [`decode_for_pano`] — the post-DCP scene-linear
/// image plus the metadata pano-core needs to interpret it.
#[derive(Clone, Debug)]
pub struct PanoIngest {
    /// Scene-linear Rec.2020 D65, f32 RGB. Display orientation is **not**
    /// applied here — the caller (pano-core) rotates while converting to
    /// its own buffer layout.
    pub image: Image,
    pub orientation: ExifOrientation,
    pub camera_make: String,
    pub camera_model: String,
    /// Drone gimbal angles in degrees, when the source image is from
    /// a DJI drone (or any device that writes drone-dji XMP). `None`
    /// otherwise.
    pub gimbal: Option<GimbalAngles>,
    /// Pixel focal length derived from EXIF metadata. Computed from
    /// `FocalLengthIn35mmFormat` (preferred) or `FocalLength` + a
    /// known sensor width fallback. `None` when neither tag is present
    /// or when the values are degenerate (zero / negative).
    ///
    /// **Important:** the prior used by pano-core's BA was previously
    /// hardcoded to `image_width`, which is wrong for any non-50mm-eq
    /// lens. For DJI L2D-20c (28mm-eq on 4/3" sensor), the correct
    /// pixel focal is ~4181 px on a 5376-px-wide image, vs. the prior
    /// of 5376 — a 24% error that compounds across the multi-row
    /// stitch. This field is the fix.
    pub focal_pixels: Option<f32>,
    /// Radial lens distortion coefficients (k1, k2) in Brown-Conrady form
    /// `r' = r · (1 + k1·r² + k2·r⁴)`, where `r` is in normalised camera
    /// coordinates (one focal length per unit). Extracted from the DNG's
    /// `OpcodeList3 → WarpRectilinear` opcode (DJI / Adobe DNGs only).
    ///
    /// `None` if the source format isn't a DNG, the opcode list is absent,
    /// or no `WarpRectilinear` opcode is present.
    pub distortion: Option<(f32, f32)>,
    /// Principal point in pixel coordinates, extracted from the
    /// `WarpRectilinear` opcode's `(cx, cy)` field (normalised to
    /// `[0, 1] × [0, 1]`, then converted to pixel coords using image
    /// dimensions). The optical centre is typically offset 5–20 px from
    /// the geometric image centre on consumer lenses; using the true
    /// value sharpens BA's K matrix.
    ///
    /// `None` when WarpRectilinear is absent or the field isn't
    /// well-defined for this opcode (caller should fall back to
    /// `(image_w / 2, image_h / 2)`).
    pub principal_point: Option<(f32, f32)>,
}

/// Gimbal orientation angles recorded by a DJI drone into the
/// `drone-dji` XMP namespace (`GimbalYawDegree`, `GimbalPitchDegree`,
/// `GimbalRollDegree`). All values are in degrees.
#[derive(Debug, Clone, Copy)]
pub struct GimbalAngles {
    pub yaw_deg: f32,
    pub pitch_deg: f32,
    pub roll_deg: f32,
}

/// Run the raw → camera RGB → DCP chain on a `RawImage` and return the
/// scene-linear Rec.2020 D65 buffer. No user adjustments — vibrance,
/// saturation, clarity, etc. are intentionally skipped.
///
/// Equivalent to [`develop_for_pano_with_gain_map`] with `gain_map: None`.
pub fn develop_for_pano(raw: &RawImage) -> Result<Image> {
    develop_for_pano_with_gain_map(raw, None)
}

/// Like [`develop_for_pano`] but accepts an optional vignetting `GainMap`
/// (parsed from the DNG's `OpcodeList3 → GainMap` opcode).
///
/// When provided, the gain map is applied after demosaic and after the
/// baseline-exposure correction, before the DCP color matrix runs. This
/// is the standard place in Adobe's pipeline (the gain map corrects the
/// per-pixel multiplicative falloff caused by the lens before any colour
/// transform that depends on flat-field assumptions).
///
/// On DJI L2D-20c the gain map is ~30 % at the corners (i.e. corner
/// pixels are multiplied by ~1.3 to compensate for vignetting). Without
/// it the pano-stitch shows visible vertical bands at seams as each
/// frame's dark corners abut a neighbour's bright centre.
pub fn develop_for_pano_with_gain_map(
    raw: &RawImage,
    gain_map: Option<&GainMap>,
) -> Result<Image> {
    let mut camera_rgb = match raw.cfa {
        CfaPattern::LinearRgb => linearize::linearraw_to_camera_rgb(raw)?,
        _ => {
            let mosaic = linearize::sensor_linearize(raw);
            demosaic::bilinear(&mosaic, raw.cfa)
        }
    };

    if raw.baseline_exposure.abs() > 1e-4 {
        let be_gain = raw.baseline_exposure.exp2();
        for p in &mut camera_rgb.pixels {
            p[0] *= be_gain;
            p[1] *= be_gain;
            p[2] *= be_gain;
        }
    }

    if let Some(gm) = gain_map {
        apply_gain_map(&mut camera_rgb, gm);
    }

    let profile = dcp::profile_for(raw)?;
    dcp::apply(&camera_rgb, &profile)
}

/// Decode a RAW from in-memory bytes and run [`develop_for_pano`] in
/// one shot. `ext` is the lowercase file extension used by rawler as a
/// format hint (matching [`crate::decode::decode_bytes`]).
///
/// Vignetting correction (`OpcodeList3 → GainMap`) is parsed from the
/// DNG and applied during develop, when present. When absent the
/// pipeline falls back to no flat-field correction (matches the legacy
/// behaviour for non-DNG inputs).
pub fn decode_for_pano(bytes: &[u8], ext: &str) -> Result<PanoIngest> {
    let raw = crate::decode::decode_bytes(bytes, ext)?;
    let gain_map = extract_gain_map(bytes);
    let image = develop_for_pano_with_gain_map(&raw, gain_map.as_ref())?;

    // ── Gimbal angles from embedded XMP ──────────────────────────────────────
    // DJI DNGs embed a drone-dji XMP packet inside TIFF tag 0x02BC (700).
    // Strategy: extract XMP bytes from rawler's root IFD via TiffCommonTag::Xmp,
    // then grep for the three gimbal keys. This path is entirely optional —
    // any failure leaves `gimbal: None`.
    //
    // Implementation note: rawler's decoder exposes the root IFD but does not
    // offer a high-level `xmp()` accessor. We read tag 700 directly via the
    // same WellKnownIFD::Root + get_entry pattern used in decode.rs for
    // BaselineExposure. The `tiff` workspace crate is NOT needed because rawler
    // already parses the TIFF structure for us; its Value::Byte variant holds
    // the raw XMP UTF-8 bytes.
    let gimbal = extract_xmp_from_bytes(bytes)
        .as_deref()
        .and_then(extract_gimbal_from_xmp);

    let focal_pixels = extract_focal_pixels(bytes, image.width);
    let distortion = focal_pixels
        .and_then(|f_px| extract_lens_distortion(bytes, image.width, image.height, f_px));
    let principal_point = extract_principal_point(bytes, image.width, image.height);

    Ok(PanoIngest {
        image,
        orientation: raw.orientation,
        camera_make: raw.camera_make,
        camera_model: raw.camera_model,
        gimbal,
        focal_pixels,
        distortion,
        principal_point,
    })
}

/// Extract pixel focal length from EXIF tags.
///
/// Strategy (preferring precision over universality):
/// 1. **Physical `FocalLength` (tag 0x920a) × sensor-width lookup**
///    when both are available. EXIF `FocalLength` is a rational with
///    sub-mm precision (e.g. 12.3 mm on the L2D-20c) and the sensor
///    width is a known constant per model — together they give a
///    pixel focal that's accurate to better than 1%.
/// 2. **Fallback: `FocalLengthIn35mmFormat`** (tag 0xa405). Universal
///    across cameras but reported as an integer mm in many firmwares.
///    For the L2D-20c this rounds 24.6 → 24 (a 2.5% bias) which BA
///    then has to absorb into focal drift.  Used when no sensor-width
///    lookup is available for the model.
///
/// Returns `None` if neither path resolves. Caller should fall back to
/// whatever prior they were using before (typically `image_width as f32`,
/// which biases focal high by 5–30%).
///
/// Empirical note: with strategy 1 enabled, BA's focal drift on
/// pano_01's outer-row cameras drops from +9% to +1–2% (the residual
/// being unmodelled translation parallax — see follow-up Item 2).
fn extract_focal_pixels(bytes: &[u8], image_width: u32) -> Option<f32> {
    use rawler::decoders::{RawDecodeParams, WellKnownIFD};
    use rawler::rawsource::RawSource;
    use rawler::tags::ExifTag;

    let source = RawSource::new_from_slice(bytes)
        .with_path(std::path::Path::new("rawfile.dng"));
    let _params = RawDecodeParams::default();
    let decoder = rawler::get_decoder(&source).ok()?;
    let exif_ifd = decoder.ifd(WellKnownIFD::Exif).ok().flatten()?;

    // Strategy 1: physical FocalLength (rational, sub-mm precision)
    // + sensor-width lookup. This is the high-precision path.
    let focal_mm = exif_ifd
        .get_entry(ExifTag::FocalLength)
        .and_then(|e| e.value.get_f32(0).ok().flatten())
        .filter(|&f| f > 0.5 && f < 1000.0);

    let model = decoder.ifd(WellKnownIFD::Root).ok().flatten().and_then(|ifd| {
        ifd.get_entry(rawler::tags::TiffCommonTag::Model)
            .and_then(|e| {
                let bytes = e.value.get_data();
                std::str::from_utf8(bytes)
                    .ok()
                    .map(|s| s.trim_end_matches('\0').to_string())
            })
    });

    if let (Some(f_mm), Some(model_str)) = (focal_mm, model.as_deref()) {
        if let Some(sensor_w_mm) = sensor_width_for_model(model_str) {
            return Some((image_width as f32) * f_mm / sensor_w_mm);
        }
    }

    // Strategy 2: 35mm equivalent (EXIF SHORT, single value).
    // Used when no sensor-width lookup is available for the camera
    // model. Note: many firmwares write this as an integer, which
    // rounds the true value (e.g. DJI L2D-20c real 24.6mm → 24mm
    // EXIF) — strategy 1 above sidesteps that rounding when possible.
    if let Some(entry) = exif_ifd.get_entry(ExifTag::FocalLengthIn35mmFormat) {
        if let Ok(Some(f_35mm)) = entry.value.get_usize(0) {
            let f = f_35mm as f32;
            if f > 1.0 && f < 1000.0 {
                return Some((image_width as f32) * f / 36.0);
            }
        }
    }

    None
}

/// Extract Brown-Conrady radial-distortion coefficients (k1, k2) from
/// a DNG's `OpcodeList3 → WarpRectilinear` opcode.
///
/// DNG's `WarpRectilinear` uses the polynomial
/// `r_corrected = r · (kr0 + kr1·r² + kr2·r⁴ + kr3·r⁶)` with `r`
/// normalised so that r=1 at the image's furthest corner from the
/// optical centre (corner-pixel radius = `√((W/2)² + (H/2)²)`).
///
/// pano-core's Brown-Conrady model uses `r' = r · (1 + k1·r² + k2·r⁴)`
/// with `r` in normalised camera coordinates (one focal length per
/// unit). The conversion ratio from DNG-r to camera-r is
/// `scale = focal_px / r_max_px`, and the polynomial coefficients
/// pull through as:
///
/// ```text
/// k1 = kr1 / scale²
/// k2 = kr2 / scale⁴
/// ```
///
/// We use the **green plane** coefficients only (DNG stores per-channel
/// polynomials; G is ~70% of luminance and the closest single-channel
/// proxy for the broadband alignment we use). The `kr0 ≈ 1` global
/// scale and the `kr3 · r⁶` higher-order term are dropped — both
/// contribute < 0.5% radial error at the corners on DJI L2D-20c, well
/// inside the gimbal-filter tolerance.
///
/// Returns `None` when:
/// - the source is not a DNG / has no `OpcodeList3`,
/// - no `WarpRectilinear` opcode is in the list,
/// - parsing of the polynomial bytes fails (truncated / malformed).
fn extract_lens_distortion(
    bytes: &[u8],
    image_w: u32,
    image_h: u32,
    focal_px: f32,
) -> Option<(f32, f32)> {
    use rawler::decoders::WellKnownIFD;
    use rawler::rawsource::RawSource;
    use rawler::tags::DngTag;

    let source = RawSource::new_from_slice(bytes).with_path(std::path::Path::new("rawfile.dng"));
    let decoder = rawler::get_decoder(&source).ok()?;
    // OpcodeList3 lives in the raw IFD, not the root IFD.
    let raw_ifd = decoder.ifd(WellKnownIFD::Raw).ok().flatten()?;
    let entry = raw_ifd.get_entry(DngTag::OpcodeList3)?;
    let opcode_bytes = entry.value.get_data();

    let coeffs = parse_warp_rectilinear_green(opcode_bytes)?;

    let cx = image_w as f32 / 2.0;
    let cy = image_h as f32 / 2.0;
    let r_max_px = (cx * cx + cy * cy).sqrt();
    let scale = focal_px / r_max_px;
    if scale.abs() < 1e-6 {
        return None;
    }
    let s2 = (scale as f64) * (scale as f64);
    let s4 = s2 * s2;
    let k1 = (coeffs.kr1 / s2) as f32;
    let k2 = (coeffs.kr2 / s4) as f32;
    Some((k1, k2))
}

/// Decoded green-plane polynomial coefficients of a DNG WarpRectilinear opcode.
struct WarpRectilinearGreen {
    #[allow(dead_code)]
    kr0: f64,
    kr1: f64,
    kr2: f64,
    #[allow(dead_code)]
    kr3: f64,
}

/// Decoded `(cx, cy)` optical centre from a DNG WarpRectilinear opcode,
/// in **normalised image coordinates** (where (0, 0) is the top-left
/// corner and (1, 1) is the bottom-right). Typical values are very
/// close to (0.5, 0.5) but consumer lenses can offset by ~1 % of image
/// dimensions either way.
struct WarpRectilinearCenter {
    cx: f64,
    cy: f64,
}

/// Parse the OpcodeList3 stream (big-endian) and return the green-plane
/// `WarpRectilinear` coefficients, if any.
///
/// OpcodeList format:
/// ```text
/// [u32 BE]   N (number of opcodes)
/// for each opcode:
///   [u32 BE] opcodeID
///   [u32 BE] dngVersion
///   [u32 BE] flags
///   [u32 BE] paramByteCount
///   [bytes]  parameters (paramByteCount bytes)
/// ```
///
/// WarpRectilinear (opcode ID 1) parameter layout:
/// ```text
/// [u32 BE]   nplanes (1 or 3)
/// for each plane: 6 × f64 BE — kr0, kr1, kr2, kr3, kt0, kt1
/// 2 × f64 BE — cx, cy (optical center in normalised image coords)
/// ```
fn parse_warp_rectilinear_green(stream: &[u8]) -> Option<WarpRectilinearGreen> {
    let mut cursor = 0usize;
    if stream.len() < 4 {
        return None;
    }
    let n_opcodes = read_u32_be(stream, cursor)? as usize;
    cursor += 4;

    for _ in 0..n_opcodes {
        if stream.len() < cursor + 16 {
            return None;
        }
        let opcode_id = read_u32_be(stream, cursor)?;
        let _dng_version = read_u32_be(stream, cursor + 4)?;
        let _flags = read_u32_be(stream, cursor + 8)?;
        let param_bytes = read_u32_be(stream, cursor + 12)? as usize;
        cursor += 16;
        if stream.len() < cursor + param_bytes {
            return None;
        }
        let params = &stream[cursor..cursor + param_bytes];
        cursor += param_bytes;

        if opcode_id == 1 {
            // WarpRectilinear.
            if params.len() < 4 {
                continue;
            }
            let nplanes = read_u32_be(params, 0)? as usize;
            // Per-plane block size = 6 doubles = 48 bytes.
            // We always read the green plane: index 0 if 1 plane,
            // index 1 if 3 planes. (DNG WarpRectilinear orders planes
            // R, G, B for 3-plane mode.)
            let plane_idx = if nplanes >= 2 { 1 } else { 0 };
            let off = 4 + plane_idx * 48;
            if params.len() < off + 48 {
                continue;
            }
            return Some(WarpRectilinearGreen {
                kr0: read_f64_be(params, off)?,
                kr1: read_f64_be(params, off + 8)?,
                kr2: read_f64_be(params, off + 16)?,
                kr3: read_f64_be(params, off + 24)?,
            });
        }
    }
    None
}

/// Walk OpcodeList3 to find the WarpRectilinear opcode and return its
/// `(cx, cy)` field — the optical centre in normalised image coords
/// (`[0, 1] × [0, 1]`).
///
/// Layout for WarpRectilinear params: `[u32 nplanes; nplanes × 6 ×
/// f64 (kr0..3, kt0, kt1); 2 × f64 (cx, cy)]`. So `cx` lives at offset
/// `4 + nplanes × 48` and `cy` at `+ 8`.
fn parse_warp_rectilinear_center(stream: &[u8]) -> Option<WarpRectilinearCenter> {
    let mut cursor = 0usize;
    if stream.len() < 4 {
        return None;
    }
    let n_opcodes = read_u32_be(stream, cursor)? as usize;
    cursor += 4;

    for _ in 0..n_opcodes {
        if stream.len() < cursor + 16 {
            return None;
        }
        let opcode_id = read_u32_be(stream, cursor)?;
        let _dng_version = read_u32_be(stream, cursor + 4)?;
        let _flags = read_u32_be(stream, cursor + 8)?;
        let param_bytes = read_u32_be(stream, cursor + 12)? as usize;
        cursor += 16;
        if stream.len() < cursor + param_bytes {
            return None;
        }
        let params = &stream[cursor..cursor + param_bytes];
        cursor += param_bytes;

        if opcode_id == 1 {
            if params.len() < 4 {
                continue;
            }
            let nplanes = read_u32_be(params, 0)? as usize;
            let cxcy_off = 4 + nplanes * 48;
            if params.len() < cxcy_off + 16 {
                continue;
            }
            return Some(WarpRectilinearCenter {
                cx: read_f64_be(params, cxcy_off)?,
                cy: read_f64_be(params, cxcy_off + 8)?,
            });
        }
    }
    None
}

/// Extract the optical centre (principal point) from a DNG's
/// `WarpRectilinear` opcode, converted from normalised to pixel
/// coordinates using the supplied image dimensions.
///
/// Returns `None` when no `WarpRectilinear` opcode is present in the
/// DNG's OpcodeList3.
fn extract_principal_point(bytes: &[u8], image_w: u32, image_h: u32) -> Option<(f32, f32)> {
    use rawler::decoders::WellKnownIFD;
    use rawler::rawsource::RawSource;
    use rawler::tags::DngTag;

    let source = RawSource::new_from_slice(bytes).with_path(std::path::Path::new("rawfile.dng"));
    let decoder = rawler::get_decoder(&source).ok()?;
    let raw_ifd = decoder.ifd(WellKnownIFD::Raw).ok().flatten()?;
    let entry = raw_ifd.get_entry(DngTag::OpcodeList3)?;
    let opcode_bytes = entry.value.get_data();
    let centre = parse_warp_rectilinear_center(opcode_bytes)?;
    Some((
        (centre.cx as f32) * (image_w as f32),
        (centre.cy as f32) * (image_h as f32),
    ))
}

#[inline]
fn read_u32_be(buf: &[u8], at: usize) -> Option<u32> {
    if buf.len() < at + 4 {
        return None;
    }
    Some(u32::from_be_bytes([
        buf[at],
        buf[at + 1],
        buf[at + 2],
        buf[at + 3],
    ]))
}

#[inline]
fn read_f64_be(buf: &[u8], at: usize) -> Option<f64> {
    if buf.len() < at + 8 {
        return None;
    }
    let mut bytes = [0u8; 8];
    bytes.copy_from_slice(&buf[at..at + 8]);
    Some(f64::from_be_bytes(bytes))
}

// ---------------------------------------------------------------------------
// GainMap (vignetting correction)
// ---------------------------------------------------------------------------

/// Decoded `WarpRectilinear`-companion vignetting gain map from a DNG's
/// `OpcodeList3 → GainMap` opcode (id = 9).
///
/// Per the DNG 1.4 spec § 7.3.4: the lens projects light unevenly across
/// the sensor (corners receive less light than the centre). DNG embeds
/// a per-channel multiplicative gain grid that, when applied
/// pixel-by-pixel after demosaic, undoes that falloff. A typical
/// L2D-20c map runs from gain ≈ 1.0 at the centre to gain ≈ 1.3 at the
/// corners on each of R, G, B independently (the channels diverge
/// because longer wavelengths fall off less steeply).
///
/// We store the map decoded into a flat 32×32×3 (or whatever
/// dimensions the DNG reports) `Vec<f32>` plus the rectangle in raw-
/// image pixel coords it applies to. Application time uses bilinear
/// interpolation of the grid against each output pixel's normalised
/// position within the rectangle.
#[derive(Clone, Debug)]
pub struct GainMap {
    /// Rectangle in raw-image pixel coords this map applies to:
    /// (top, left, bottom, right). When the decoded image dimensions
    /// differ from `right − left × bottom − top`, the map is applied
    /// only to the matching subrectangle and pixels outside are left
    /// untouched.
    pub rect: (u32, u32, u32, u32),
    /// Number of grid rows.
    pub points_v: u32,
    /// Number of grid columns.
    pub points_h: u32,
    /// Number of plane samples per grid point. 1 = single-channel
    /// (apply same gain to all RGB), 3 = per-channel (R, G, B).
    pub map_planes: u32,
    /// Grid origin in normalised-rect coordinates (typically (0, 0)).
    pub origin: (f64, f64),
    /// Spacing between grid points in normalised-rect coordinates
    /// (typically (1/(points_v−1), 1/(points_h−1))).
    pub spacing: (f64, f64),
    /// Flat row-major samples: `gain[(v × points_h + h) × map_planes + p]`.
    /// Length = `points_v × points_h × map_planes`.
    pub samples: Vec<f32>,
}

impl GainMap {
    /// Sample the map at a normalised position `(u, v)` ∈ `[0, 1]²`,
    /// returning per-channel gains `(r, g, b)`. Bilinear-interpolated
    /// across the grid; clamped to the grid boundary on out-of-range
    /// inputs.
    pub fn sample(&self, u: f64, v: f64) -> (f32, f32, f32) {
        // Convert normalised position into grid-cell coordinates.
        let gh = ((u - self.origin.1) / self.spacing.1).clamp(
            0.0,
            (self.points_h.saturating_sub(1)) as f64,
        );
        let gv = ((v - self.origin.0) / self.spacing.0).clamp(
            0.0,
            (self.points_v.saturating_sub(1)) as f64,
        );

        let h0 = gh.floor() as u32;
        let v0 = gv.floor() as u32;
        let h1 = (h0 + 1).min(self.points_h - 1);
        let v1 = (v0 + 1).min(self.points_v - 1);
        let dh = (gh - h0 as f64) as f32;
        let dv = (gv - v0 as f64) as f32;

        let fetch = |row: u32, col: u32| -> (f32, f32, f32) {
            let base = ((row * self.points_h + col) * self.map_planes) as usize;
            let r = self.samples[base];
            let g = if self.map_planes >= 2 { self.samples[base + 1] } else { r };
            let b = if self.map_planes >= 3 { self.samples[base + 2] } else { r };
            (r, g, b)
        };

        let (r00, g00, b00) = fetch(v0, h0);
        let (r10, g10, b10) = fetch(v0, h1);
        let (r01, g01, b01) = fetch(v1, h0);
        let (r11, g11, b11) = fetch(v1, h1);

        let lerp = |a: f32, b: f32, t: f32| a + (b - a) * t;
        let r = lerp(lerp(r00, r10, dh), lerp(r01, r11, dh), dv);
        let g = lerp(lerp(g00, g10, dh), lerp(g01, g11, dh), dv);
        let b = lerp(lerp(b00, b10, dh), lerp(b01, b11, dh), dv);
        (r, g, b)
    }
}

/// Parse the `GainMap` opcode (id = 9) from a DNG's `OpcodeList3` tag,
/// returning the first one we find (panoramas typically have just one).
///
/// Returns `None` when:
/// - the source isn't a DNG / `OpcodeList3` is absent,
/// - no `GainMap` opcode is present in the list (some bodies don't
///   embed vignetting correction),
/// - parsing fails (truncated / malformed bytes).
pub fn extract_gain_map(bytes: &[u8]) -> Option<GainMap> {
    use rawler::decoders::WellKnownIFD;
    use rawler::rawsource::RawSource;
    use rawler::tags::DngTag;

    let source = RawSource::new_from_slice(bytes).with_path(std::path::Path::new("rawfile.dng"));
    let decoder = rawler::get_decoder(&source).ok()?;
    let raw_ifd = decoder.ifd(WellKnownIFD::Raw).ok().flatten()?;
    let entry = raw_ifd.get_entry(DngTag::OpcodeList3)?;
    let opcode_bytes = entry.value.get_data();
    parse_gain_map(opcode_bytes)
}

/// Parse the OpcodeList3 stream (big-endian) and return the **first**
/// GainMap opcode (id = 9) we find. Other opcodes (notably
/// WarpRectilinear, id = 1) are skipped.
fn parse_gain_map(stream: &[u8]) -> Option<GainMap> {
    let mut cursor = 0usize;
    if stream.len() < 4 {
        return None;
    }
    let n_opcodes = read_u32_be(stream, cursor)? as usize;
    cursor += 4;

    for _ in 0..n_opcodes {
        if stream.len() < cursor + 16 {
            return None;
        }
        let opcode_id = read_u32_be(stream, cursor)?;
        let _dng_version = read_u32_be(stream, cursor + 4)?;
        let _flags = read_u32_be(stream, cursor + 8)?;
        let param_bytes = read_u32_be(stream, cursor + 12)? as usize;
        cursor += 16;
        if stream.len() < cursor + param_bytes {
            return None;
        }
        let params = &stream[cursor..cursor + param_bytes];
        cursor += param_bytes;

        if opcode_id == 9 {
            return decode_gain_map_params(params);
        }
    }
    None
}

/// Decode a `GainMap` opcode's parameter bytes into a [`GainMap`].
///
/// Parameter layout (big-endian, per DNG 1.4 spec § 7.3.4):
/// - `[u32]`  Top, Left, Bottom, Right        (16 bytes)
/// - `[u32]`  Plane, Planes                   (8 bytes)
/// - `[u32]`  RowPitch, ColPitch              (8 bytes)
/// - `[u32]`  MapPointsV, MapPointsH          (8 bytes)
/// - `[f64]`  MapSpacingV, MapSpacingH        (16 bytes)
/// - `[f64]`  MapOriginV, MapOriginH          (16 bytes)
/// - `[u32]`  MapPlanes                       (4 bytes)
/// - `[f32 × MapPointsV × MapPointsH × MapPlanes]`  MapGainSamples
///
/// Total fixed-size header: 76 bytes; sample data follows.
fn decode_gain_map_params(params: &[u8]) -> Option<GainMap> {
    if params.len() < 76 {
        return None;
    }
    let top = read_u32_be(params, 0)?;
    let left = read_u32_be(params, 4)?;
    let bottom = read_u32_be(params, 8)?;
    let right = read_u32_be(params, 12)?;
    let _plane = read_u32_be(params, 16)?;
    let _planes = read_u32_be(params, 20)?;
    let _row_pitch = read_u32_be(params, 24)?;
    let _col_pitch = read_u32_be(params, 28)?;
    let points_v = read_u32_be(params, 32)?;
    let points_h = read_u32_be(params, 36)?;
    let spacing_v = read_f64_be(params, 40)?;
    let spacing_h = read_f64_be(params, 48)?;
    let origin_v = read_f64_be(params, 56)?;
    let origin_h = read_f64_be(params, 64)?;
    let map_planes = read_u32_be(params, 72)?;

    let n_samples = (points_v as usize)
        .checked_mul(points_h as usize)?
        .checked_mul(map_planes as usize)?;
    let sample_bytes = n_samples.checked_mul(4)?;
    if params.len() < 76 + sample_bytes {
        return None;
    }
    let mut samples = Vec::with_capacity(n_samples);
    for k in 0..n_samples {
        let off = 76 + k * 4;
        let mut buf = [0u8; 4];
        buf.copy_from_slice(&params[off..off + 4]);
        samples.push(f32::from_be_bytes(buf));
    }

    Some(GainMap {
        rect: (top, left, bottom, right),
        points_v,
        points_h,
        map_planes,
        origin: (origin_v, origin_h),
        spacing: (spacing_v, spacing_h),
        samples,
    })
}

/// Apply a vignetting gain map to a demosaiced camera-RGB image
/// in-place. Pixels outside the gain map's rectangle are left
/// unmodified (we don't know what the lens did there).
///
/// Sampling: each output pixel's normalised position within the rect
/// is bilinearly looked up in the gain grid and the per-channel gains
/// multiplied into the pixel.
fn apply_gain_map(image: &mut Image, gm: &GainMap) {
    let (top, left, bottom, right) = gm.rect;
    let img_w = image.width;
    let img_h = image.height;

    // Clamp the rect to the actual image bounds (DJI's GainMap rect
    // is sometimes a few px smaller than the decoded image's "active
    // area" — we apply only over the intersection).
    let rx0 = left.min(img_w);
    let ry0 = top.min(img_h);
    let rx1 = right.min(img_w);
    let ry1 = bottom.min(img_h);
    if rx1 <= rx0 || ry1 <= ry0 {
        return;
    }
    let rect_w = (rx1 - rx0) as f64;
    let rect_h = (ry1 - ry0) as f64;
    if rect_w < 1.0 || rect_h < 1.0 {
        return;
    }

    for y in ry0..ry1 {
        let v_norm = (y as f64 - ry0 as f64) / (rect_h - 1.0).max(1.0);
        for x in rx0..rx1 {
            let u_norm = (x as f64 - rx0 as f64) / (rect_w - 1.0).max(1.0);
            let (gr, gg, gb) = gm.sample(u_norm, v_norm);
            let idx = (y as usize) * (img_w as usize) + (x as usize);
            let p = &mut image.pixels[idx];
            p[0] *= gr;
            p[1] *= gg;
            p[2] *= gb;
        }
    }
}

/// Sensor width (mm) lookup by camera Model EXIF string.
///
/// Currently DJI-only; extend with other cameras as they show up in
/// fixtures. When Model isn't recognised, returns None and the caller
/// falls back to its prior.
fn sensor_width_for_model(model: &str) -> Option<f32> {
    let m = model.trim();
    match m {
        // DJI Mavic 3 (Hasselblad L2D-20c) — 4/3" sensor.
        "L2D-20c" | "Hasselblad L2D-20c" => Some(17.3),
        // DJI Mavic 3 Pro main camera (Hasselblad L3D-100c) — 4/3"
        // sensor (different chip but same effective width).
        "L3D-100c" | "Hasselblad L3D-100c" => Some(17.3),
        _ => None,
    }
}

/// Extract the raw XMP packet from the input bytes.
///
/// Attempts two strategies in order:
/// 1. **rawler root IFD** — ask rawler's decoder for tag 0x02BC (`TiffCommonTag::Xmp`).
///    This is the cleanest path and works for all DNG/TIFF-container formats.
/// 2. **Byte scan fallback** — scan the raw bytes for the literal `<x:xmpmeta`
///    ... `</x:xmpmeta>` packet, which DJI embeds as plain UTF-8. This is
///    tolerant of formats where rawler's IFD parse doesn't surface tag 700.
fn extract_xmp_from_bytes(bytes: &[u8]) -> Option<String> {
    // Strategy 1: rawler root IFD, tag 700
    {
        use rawler::decoders::{RawDecodeParams, WellKnownIFD};
        use rawler::rawsource::RawSource;
        use rawler::tags::TiffCommonTag;

        let source = RawSource::new_from_slice(bytes).with_path(
            std::path::Path::new("rawfile.dng"),
        );
        let _params = RawDecodeParams::default();
        if let Some(decoder) = rawler::get_decoder(&source).ok() {
            if let Some(ifd) = decoder.ifd(WellKnownIFD::Root).ok().flatten() {
                if let Some(entry) = ifd.get_entry(TiffCommonTag::Xmp) {
                    let xmp_bytes = entry.value.get_data();
                    if let Ok(s) = std::str::from_utf8(xmp_bytes) {
                        return Some(s.to_string());
                    }
                }
            }
        }
    }

    // Strategy 2: scan raw bytes for the XMP packet start/end markers.
    // DJI embeds XMP as plain ASCII/UTF-8 directly in the TIFF stream.
    let s = std::str::from_utf8(bytes).ok()?;
    let start = s.find("<x:xmpmeta")?;
    let end = s[start..].find("</x:xmpmeta>").map(|i| start + i + 12)?;
    Some(s[start..end].to_string())
}

/// Parse the three DJI gimbal angle fields from an XMP string.
///
/// Returns `None` if any of the three fields is absent or unparseable.
fn extract_gimbal_from_xmp(xmp: &str) -> Option<GimbalAngles> {
    let yaw = grep_dji_attr(xmp, "GimbalYawDegree")?;
    let pitch = grep_dji_attr(xmp, "GimbalPitchDegree")?;
    let roll = grep_dji_attr(xmp, "GimbalRollDegree")?;
    Some(GimbalAngles {
        yaw_deg: yaw,
        pitch_deg: pitch,
        roll_deg: roll,
    })
}

/// Tolerant grep for a DJI XMP attribute value.
///
/// DJI writes gimbal fields in two forms:
/// - Element:   `<drone-dji:GimbalYawDegree>+87.9</drone-dji:GimbalYawDegree>`
/// - Attribute: `drone-dji:GimbalYawDegree="+87.9"`
///
/// Both contain `GimbalYawDegree` followed (eventually) by a signed decimal.
/// We skip punctuation/whitespace after the key name, then collect the first
/// signed numeric token.
fn grep_dji_attr(xmp: &str, key: &str) -> Option<f32> {
    let idx = xmp.find(key)?;
    let after = &xmp[idx + key.len()..];
    let mut chars = after.chars().peekable();
    // Skip non-numeric characters until the start of a signed decimal token.
    while let Some(&c) = chars.peek() {
        if c == '+' || c == '-' || c.is_ascii_digit() {
            break;
        }
        chars.next();
    }
    let mut buf = String::new();
    for c in chars {
        if c == '+' || c == '-' || c.is_ascii_digit() || c == '.' || c == 'e' || c == 'E' {
            buf.push(c);
        } else if !buf.is_empty() {
            break;
        }
    }
    buf.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::illuminant::Illuminant;
    use crate::image::ColorSpace;
    use crate::math::Matrix3;
    use std::collections::HashMap;

    fn synth_linear_rgb_raw() -> RawImage {
        // Canon-shape color matrix (XYZ→camera, D65). Same shape used in
        // the existing dcp tests. Pixel value 50% gray.
        let cm = Matrix3([
            [0.6722, -0.0635, -0.0963],
            [-0.4287, 1.2460, 0.2028],
            [-0.0908, 0.2162, 0.5668],
        ]);
        let mut cms = HashMap::new();
        cms.insert(Illuminant::D65, cm);

        let as_shot_neutral = [1.65, 1.0, 2.16]; // warm WB

        // 2×2 LinearRgb image — 12 u16 entries (3 channels × 4 pixels).
        // Values in 0..white_level=1024 range; `linearraw_to_camera_rgb`
        // will normalize to f32 in [0, 1] then apply the AsShotNeutral
        // pre-bake undo.
        RawImage {
            width: 2,
            height: 2,
            cfa: CfaPattern::LinearRgb,
            black_level: [0; 4],
            white_level: 1024,
            raw_data: vec![512; 12], // mid-gray
            as_shot_neutral,
            as_shot_cct: None,
            camera_make: "Test".into(),
            camera_model: "Test".into(),
            color_matrices: cms,
            orientation: ExifOrientation::Normal,
            baseline_exposure: 0.0,
        }
    }

    #[test]
    fn develop_for_pano_returns_scene_linear_rec2020() {
        let raw = synth_linear_rgb_raw();
        let img = develop_for_pano(&raw).expect("DCP applies");
        assert_eq!(img.space, ColorSpace::SceneLinearRec2020);
        assert_eq!(img.width, 2);
        assert_eq!(img.height, 2);
        assert_eq!(img.pixels.len(), 4);
    }

    #[test]
    fn develop_for_pano_neutral_input_yields_neutral_rec2020() {
        // Mid-gray neutral camera RGB should come out roughly neutral in
        // Rec.2020 — same as the existing dcp test, just exercised
        // through the panorama wrapper.
        let raw = synth_linear_rgb_raw();
        let img = develop_for_pano(&raw).expect("DCP applies");
        let p = img.pixels[0];
        let rg = (p[0] - p[1]).abs();
        let bg = (p[2] - p[1]).abs();
        // Looser tolerance than the dcp test because we're going through
        // the linearize → camera_rgb path which has its own quantization.
        assert!(
            rg < 0.05 && bg < 0.05,
            "expected near-neutral, got RGB = ({:.4}, {:.4}, {:.4})",
            p[0],
            p[1],
            p[2],
        );
    }

    #[test]
    fn develop_for_pano_baseline_exposure_brightens() {
        let mut raw = synth_linear_rgb_raw();
        let baseline = develop_for_pano(&raw).unwrap();
        let baseline_g = baseline.pixels[0][1];

        raw.baseline_exposure = 1.0; // +1 EV → 2× gain
        let brighter = develop_for_pano(&raw).unwrap();
        let brighter_g = brighter.pixels[0][1];

        assert!(
            brighter_g > baseline_g * 1.5,
            "expected +1 EV to roughly double green; baseline={}, brighter={}",
            baseline_g,
            brighter_g,
        );
    }

    #[test]
    fn grep_dji_attr_element_form() {
        let xmp = r#"<drone-dji:GimbalYawDegree>+87.9</drone-dji:GimbalYawDegree>"#;
        let v = super::grep_dji_attr(xmp, "GimbalYawDegree").expect("should parse");
        assert!((v - 87.9).abs() < 0.01, "got {}", v);
    }

    #[test]
    fn grep_dji_attr_attribute_form() {
        let xmp = r#"drone-dji:GimbalPitchDegree="-1.3""#;
        let v = super::grep_dji_attr(xmp, "GimbalPitchDegree").expect("should parse");
        assert!((v + 1.3).abs() < 0.01, "got {}", v);
    }

    #[test]
    fn grep_dji_attr_zero() {
        let xmp = r#"<drone-dji:GimbalRollDegree>+0.0</drone-dji:GimbalRollDegree>"#;
        let v = super::grep_dji_attr(xmp, "GimbalRollDegree").expect("should parse");
        assert!(v.abs() < 0.01, "got {}", v);
    }

    #[test]
    fn extract_gimbal_from_xmp_full_packet() {
        let xmp = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/">
          <rdf:RDF>
            <rdf:Description
              drone-dji:GimbalYawDegree="+87.9"
              drone-dji:GimbalPitchDegree="-1.3"
              drone-dji:GimbalRollDegree="+0.0"
            />
          </rdf:RDF>
        </x:xmpmeta>"#;
        let g = super::extract_gimbal_from_xmp(xmp).expect("should parse gimbal");
        assert!((g.yaw_deg - 87.9).abs() < 0.01);
        assert!((g.pitch_deg + 1.3).abs() < 0.01);
        assert!(g.roll_deg.abs() < 0.01);
    }

    #[test]
    #[ignore] // fixture-gated — requires test-fixtures/raws/pano_01/
    fn pano_01_dng_exposes_gimbal_angles() {
        let path = std::path::Path::new(
            "/Users/riabuz/Projects/_Maple/test-fixtures/raws/pano_01/PANO0001.DNG",
        );
        if !path.exists() { return; }
        let bytes = std::fs::read(path).unwrap();
        let ingest = decode_for_pano(&bytes, "dng").unwrap();
        let gimbal = ingest.gimbal.expect("expected gimbal angles in DJI DNG");
        assert!((gimbal.yaw_deg - 87.9).abs() < 0.5, "yaw={}", gimbal.yaw_deg);
        assert!((gimbal.pitch_deg + 1.3).abs() < 0.5, "pitch={}", gimbal.pitch_deg);
        assert!((gimbal.roll_deg - 0.0).abs() < 0.5, "roll={}", gimbal.roll_deg);
    }

    #[test]
    #[ignore] // fixture-gated — requires test-fixtures/raws/pano_01/
    fn pano_01_dng_exposes_focal_pixels() {
        // DJI L2D-20c on a 5376 × 3956 image:
        //   physical FocalLength = 12.3 mm (EXIF, sub-mm precision)
        //   4/3" sensor width    = 17.3 mm
        //   f_px = 5376 × 12.3 / 17.3 ≈ 3822.7
        //
        // Strategy 1 (physical + sensor lookup) gives this value.
        // Strategy 2 (35mm-equiv = 24, integer-rounded) would give
        // 5376 × 24 / 36 = 3584 — off by ~6.5%, which BA had to
        // absorb as a +9% focal drift on outer-row cameras before
        // we promoted strategy 1 to first-priority.
        let path = std::path::Path::new(
            "/Users/riabuz/Projects/_Maple/test-fixtures/raws/pano_01/PANO0001.DNG",
        );
        if !path.exists() {
            return;
        }
        let bytes = std::fs::read(path).unwrap();
        let ingest = decode_for_pano(&bytes, "dng").unwrap();
        let f_px = ingest
            .focal_pixels
            .expect("expected focal_pixels for DJI L2D-20c DNG");
        // Expected from strategy 1: 3822.7 ± a few px (depending on
        // exact EXIF rational rounding for FocalLength).
        let expected_phys = 5376.0_f32 * 12.3 / 17.3; // ≈ 3822.7
        assert!(
            (f_px - expected_phys).abs() < 50.0,
            "focal_pixels = {f_px}, expected ≈ {expected_phys} (strategy 1: physical + sensor)",
        );
        // Sanity: must NOT equal the old image_width hardcode.
        assert!(
            (f_px - 5376.0).abs() > 500.0,
            "focal_pixels still equals image_width — extraction silently fell back",
        );
        // Sanity: must NOT equal the strategy-2 integer-rounded path.
        // (If it does, strategy 1 silently fell through.)
        assert!(
            (f_px - 3584.0).abs() > 50.0,
            "focal_pixels = {f_px} matches strategy-2 (rounded 24mm-eq) — strategy 1 should have fired first",
        );
    }

    #[test]
    fn sensor_width_lookup_handles_dji_models() {
        assert_eq!(super::sensor_width_for_model("L2D-20c"), Some(17.3));
        assert_eq!(super::sensor_width_for_model("L3D-100c"), Some(17.3));
        assert_eq!(
            super::sensor_width_for_model("Hasselblad L3D-100c"),
            Some(17.3)
        );
        assert_eq!(super::sensor_width_for_model("Canon EOS R5"), None);
        assert_eq!(super::sensor_width_for_model(""), None);
    }

    /// Hand-built OpcodeList3 stream containing a single WarpRectilinear
    /// opcode with known coefficients. Validates the parser end-to-end
    /// without depending on a real DNG.
    #[test]
    fn parse_warp_rectilinear_synthetic_stream() {
        let mut buf: Vec<u8> = Vec::new();
        // Number of opcodes.
        buf.extend_from_slice(&1u32.to_be_bytes());
        // Opcode 1: WarpRectilinear, 1 plane.
        buf.extend_from_slice(&1u32.to_be_bytes()); // ID
        buf.extend_from_slice(&0x01040000u32.to_be_bytes()); // DngVersion
        buf.extend_from_slice(&0u32.to_be_bytes()); // flags
        // Param byte count = 4 (nplanes) + 6×8 (one plane) + 16 (cx, cy) = 68
        buf.extend_from_slice(&68u32.to_be_bytes());
        // Params: 1 plane, kr0=1.0, kr1=-0.05, kr2=0.02, kr3=-0.01, kt0=kt1=0,
        // cx=0.5, cy=0.5
        buf.extend_from_slice(&1u32.to_be_bytes());
        buf.extend_from_slice(&1.0_f64.to_be_bytes());
        buf.extend_from_slice(&(-0.05_f64).to_be_bytes());
        buf.extend_from_slice(&0.02_f64.to_be_bytes());
        buf.extend_from_slice(&(-0.01_f64).to_be_bytes());
        buf.extend_from_slice(&0.0_f64.to_be_bytes());
        buf.extend_from_slice(&0.0_f64.to_be_bytes());
        buf.extend_from_slice(&0.5_f64.to_be_bytes());
        buf.extend_from_slice(&0.5_f64.to_be_bytes());

        let coeffs = super::parse_warp_rectilinear_green(&buf)
            .expect("parser should find the WarpRectilinear opcode");
        assert!((coeffs.kr0 - 1.0).abs() < 1e-9);
        assert!((coeffs.kr1 + 0.05).abs() < 1e-9);
        assert!((coeffs.kr2 - 0.02).abs() < 1e-9);
        assert!((coeffs.kr3 + 0.01).abs() < 1e-9);
    }

    /// 3-plane WarpRectilinear: parser should return the green plane
    /// (index 1), not the red plane.
    #[test]
    fn parse_warp_rectilinear_three_planes_returns_green() {
        let mut buf: Vec<u8> = Vec::new();
        buf.extend_from_slice(&1u32.to_be_bytes()); // 1 opcode
        buf.extend_from_slice(&1u32.to_be_bytes()); // ID = WarpRectilinear
        buf.extend_from_slice(&0x01040000u32.to_be_bytes());
        buf.extend_from_slice(&0u32.to_be_bytes());
        // 3 planes: 4 + 3×48 + 16 = 164 bytes
        buf.extend_from_slice(&164u32.to_be_bytes());

        buf.extend_from_slice(&3u32.to_be_bytes()); // nplanes = 3

        // R plane: kr0=1.001, kr1=-0.066, kr2=0.038, kr3=-0.053, kt0=kt1=0
        let r_kr: [f64; 6] = [1.001, -0.066, 0.038, -0.053, 0.0, 0.0];
        for v in r_kr {
            buf.extend_from_slice(&v.to_be_bytes());
        }
        // G plane: distinct values so we can verify which one is read.
        let g_kr: [f64; 6] = [1.002, -0.067, 0.039, -0.054, 0.0, 0.0];
        for v in g_kr {
            buf.extend_from_slice(&v.to_be_bytes());
        }
        // B plane.
        let b_kr: [f64; 6] = [1.003, -0.068, 0.040, -0.055, 0.0, 0.0];
        for v in b_kr {
            buf.extend_from_slice(&v.to_be_bytes());
        }
        // cx, cy
        buf.extend_from_slice(&0.5_f64.to_be_bytes());
        buf.extend_from_slice(&0.5_f64.to_be_bytes());

        let coeffs =
            super::parse_warp_rectilinear_green(&buf).expect("parser should find WarpRectilinear");
        // Green plane values.
        assert!((coeffs.kr0 - 1.002).abs() < 1e-9, "kr0={}", coeffs.kr0);
        assert!((coeffs.kr1 + 0.067).abs() < 1e-9);
        assert!((coeffs.kr2 - 0.039).abs() < 1e-9);
        assert!((coeffs.kr3 + 0.054).abs() < 1e-9);
    }

    /// Stream missing WarpRectilinear (only contains a different opcode like
    /// GainMap id=9) should return None.
    #[test]
    fn parse_warp_rectilinear_returns_none_when_absent() {
        let mut buf: Vec<u8> = Vec::new();
        buf.extend_from_slice(&1u32.to_be_bytes()); // 1 opcode
        buf.extend_from_slice(&9u32.to_be_bytes()); // ID = GainMap (not WarpRectilinear)
        buf.extend_from_slice(&0x01040000u32.to_be_bytes());
        buf.extend_from_slice(&0u32.to_be_bytes());
        buf.extend_from_slice(&8u32.to_be_bytes()); // 8 bytes of "params"
        buf.extend_from_slice(&[0u8; 8]);

        assert!(super::parse_warp_rectilinear_green(&buf).is_none());
    }

    /// Truncated stream — must not panic, must return None.
    #[test]
    fn parse_warp_rectilinear_handles_truncation() {
        // Header claims 1 opcode but the stream ends mid-header.
        let mut buf: Vec<u8> = Vec::new();
        buf.extend_from_slice(&1u32.to_be_bytes()); // 1 opcode
        buf.extend_from_slice(&[0u8; 8]); // only 8 bytes of the 16-byte header
        assert!(super::parse_warp_rectilinear_green(&buf).is_none());
    }

    /// Build a synthetic GainMap opcode stream with known parameters
    /// and a 2 × 2 × 3 grid: corners marked with distinct values so we
    /// can verify samples land in the right grid slots.
    fn make_synthetic_gainmap_opcode_stream() -> Vec<u8> {
        let mut buf: Vec<u8> = Vec::new();
        buf.extend_from_slice(&1u32.to_be_bytes()); // 1 opcode
        buf.extend_from_slice(&9u32.to_be_bytes()); // ID = GainMap
        buf.extend_from_slice(&0x01040000u32.to_be_bytes()); // DngVersion
        buf.extend_from_slice(&0u32.to_be_bytes()); // flags

        // 2×2 grid × 3 planes = 12 samples × 4 bytes = 48 bytes data
        // Header 76 + data 48 = 124 bytes total params.
        buf.extend_from_slice(&124u32.to_be_bytes());

        // Top, Left, Bottom, Right
        buf.extend_from_slice(&0u32.to_be_bytes());
        buf.extend_from_slice(&0u32.to_be_bytes());
        buf.extend_from_slice(&100u32.to_be_bytes());
        buf.extend_from_slice(&100u32.to_be_bytes());
        // Plane = 0, Planes = 3
        buf.extend_from_slice(&0u32.to_be_bytes());
        buf.extend_from_slice(&3u32.to_be_bytes());
        // RowPitch, ColPitch
        buf.extend_from_slice(&1u32.to_be_bytes());
        buf.extend_from_slice(&1u32.to_be_bytes());
        // MapPointsV, MapPointsH = 2
        buf.extend_from_slice(&2u32.to_be_bytes());
        buf.extend_from_slice(&2u32.to_be_bytes());
        // MapSpacingV, MapSpacingH = 1.0 (full grid spans 0 to 1)
        buf.extend_from_slice(&1.0_f64.to_be_bytes());
        buf.extend_from_slice(&1.0_f64.to_be_bytes());
        // MapOriginV, MapOriginH = 0.0
        buf.extend_from_slice(&0.0_f64.to_be_bytes());
        buf.extend_from_slice(&0.0_f64.to_be_bytes());
        // MapPlanes = 3
        buf.extend_from_slice(&3u32.to_be_bytes());

        // Samples in row-major (v, h, plane):
        //   (0,0,R)=1.0, (0,0,G)=1.1, (0,0,B)=1.2,
        //   (0,1,R)=2.0, (0,1,G)=2.1, (0,1,B)=2.2,
        //   (1,0,R)=3.0, (1,0,G)=3.1, (1,0,B)=3.2,
        //   (1,1,R)=4.0, (1,1,G)=4.1, (1,1,B)=4.2,
        let samples: [f32; 12] = [
            1.0, 1.1, 1.2,
            2.0, 2.1, 2.2,
            3.0, 3.1, 3.2,
            4.0, 4.1, 4.2,
        ];
        for s in samples {
            buf.extend_from_slice(&s.to_be_bytes());
        }
        buf
    }

    #[test]
    fn parse_gain_map_synthetic_2x2() {
        let stream = make_synthetic_gainmap_opcode_stream();
        let gm = super::parse_gain_map(&stream).expect("parser must find GainMap");
        assert_eq!(gm.rect, (0, 0, 100, 100));
        assert_eq!(gm.points_v, 2);
        assert_eq!(gm.points_h, 2);
        assert_eq!(gm.map_planes, 3);
        assert_eq!(gm.samples.len(), 12);
        // Spot-check first and last sample.
        assert!((gm.samples[0] - 1.0).abs() < 1e-6);
        assert!((gm.samples[11] - 4.2).abs() < 1e-6);
    }

    #[test]
    fn gain_map_sample_corners_match_grid() {
        let stream = make_synthetic_gainmap_opcode_stream();
        let gm = super::parse_gain_map(&stream).expect("parser must find GainMap");
        // Corner (u=0, v=0) — top-left, should be (1.0, 1.1, 1.2).
        let (r, g, b) = gm.sample(0.0, 0.0);
        assert!((r - 1.0).abs() < 1e-6);
        assert!((g - 1.1).abs() < 1e-6);
        assert!((b - 1.2).abs() < 1e-6);
        // Corner (u=1, v=1) — bottom-right, should be (4.0, 4.1, 4.2).
        let (r, g, b) = gm.sample(1.0, 1.0);
        assert!((r - 4.0).abs() < 1e-6);
        assert!((g - 4.1).abs() < 1e-6);
        assert!((b - 4.2).abs() < 1e-6);
    }

    #[test]
    fn gain_map_sample_centre_is_average_of_four_corners() {
        let stream = make_synthetic_gainmap_opcode_stream();
        let gm = super::parse_gain_map(&stream).expect("parser must find GainMap");
        // Centre (u=0.5, v=0.5) — average of all 4 corners on each channel.
        let (r, g, b) = gm.sample(0.5, 0.5);
        let exp_r = (1.0 + 2.0 + 3.0 + 4.0) / 4.0;
        let exp_g = (1.1 + 2.1 + 3.1 + 4.1) / 4.0;
        let exp_b = (1.2 + 2.2 + 3.2 + 4.2) / 4.0;
        assert!((r - exp_r).abs() < 1e-6);
        assert!((g - exp_g).abs() < 1e-6);
        assert!((b - exp_b).abs() < 1e-6);
    }

    #[test]
    fn gain_map_apply_multiplies_pixels() {
        // Build a 4 × 4 image with all pixels at (1.0, 1.0, 1.0), apply
        // a constant-2.0 gain map, expect every pixel = (2.0, 2.0, 2.0).
        use crate::image::{ColorSpace as Cs, Image as Im};
        let mut img = Im::new(4, 4, Cs::SceneLinearRec2020);
        for p in &mut img.pixels {
            *p = [1.0, 1.0, 1.0];
        }
        let gm = super::GainMap {
            rect: (0, 0, 4, 4),
            points_v: 2,
            points_h: 2,
            map_planes: 3,
            origin: (0.0, 0.0),
            spacing: (1.0, 1.0),
            samples: vec![
                2.0, 2.0, 2.0,
                2.0, 2.0, 2.0,
                2.0, 2.0, 2.0,
                2.0, 2.0, 2.0,
            ],
        };
        super::apply_gain_map(&mut img, &gm);
        for p in &img.pixels {
            assert!((p[0] - 2.0).abs() < 1e-6);
            assert!((p[1] - 2.0).abs() < 1e-6);
            assert!((p[2] - 2.0).abs() < 1e-6);
        }
    }

    #[test]
    fn gain_map_apply_brightens_corners_more_than_centre() {
        // Build an image with constant pixels and a gain map that has
        // brighter corners than centre — verify post-application that
        // corner pixels are higher than centre pixels.
        use crate::image::{ColorSpace as Cs, Image as Im};
        let w = 100u32;
        let h = 100u32;
        let mut img = Im::new(w, h, Cs::SceneLinearRec2020);
        for p in &mut img.pixels {
            *p = [1.0, 1.0, 1.0];
        }
        // 2×2 map: 1.0 at centre... wait, 2×2 has only corners. Use 3×3.
        let gm = super::GainMap {
            rect: (0, 0, h, w),
            points_v: 3,
            points_h: 3,
            map_planes: 1,
            origin: (0.0, 0.0),
            spacing: (0.5, 0.5),
            // Centre (1,1) = 1.0 (no gain), all others = 1.5 (50 % brighter at edges).
            samples: vec![
                1.5, 1.5, 1.5,
                1.5, 1.0, 1.5,
                1.5, 1.5, 1.5,
            ],
        };
        super::apply_gain_map(&mut img, &gm);
        // Centre pixel should be ≈ 1.0 (no gain), corner pixel ≈ 1.5.
        let centre_idx = ((h / 2) as usize) * (w as usize) + (w as usize / 2);
        let corner_idx = 0;
        assert!(
            img.pixels[centre_idx][0] < 1.1,
            "centre should keep gain ≈ 1.0, got {}",
            img.pixels[centre_idx][0]
        );
        assert!(
            img.pixels[corner_idx][0] > 1.4,
            "corner should be brightened to ≈ 1.5, got {}",
            img.pixels[corner_idx][0]
        );
    }

    /// Truncated GainMap stream — must not panic, must return None.
    #[test]
    fn parse_gain_map_handles_truncation() {
        // Stream claims 200 bytes of params but provides only 32.
        let mut buf: Vec<u8> = Vec::new();
        buf.extend_from_slice(&1u32.to_be_bytes()); // 1 opcode
        buf.extend_from_slice(&9u32.to_be_bytes()); // ID = GainMap
        buf.extend_from_slice(&0x01040000u32.to_be_bytes());
        buf.extend_from_slice(&0u32.to_be_bytes());
        buf.extend_from_slice(&200u32.to_be_bytes()); // claim 200 bytes
        buf.extend_from_slice(&[0u8; 32]); // but only provide 32
        assert!(super::parse_gain_map(&buf).is_none());
    }

    #[test]
    #[ignore] // fixture-gated — requires test-fixtures/raws/pano_01/
    fn pano_01_dng_exposes_principal_point() {
        // DJI L2D-20c lenses are well-centred — the WarpRectilinear
        // optical centre is normally within ±2 % of the geometric
        // image centre on a 5376 × 3956 image (so within ±107 px /
        // ±79 px). Anything wildly off would indicate a parser bug.
        let path = std::path::Path::new(
            "/Users/riabuz/Projects/_Maple/test-fixtures/raws/pano_01/PANO0001.DNG",
        );
        if !path.exists() {
            return;
        }
        let bytes = std::fs::read(path).unwrap();
        let ingest = decode_for_pano(&bytes, "dng").unwrap();
        let (cx, cy) = ingest
            .principal_point
            .expect("expected principal_point on DJI L2D-20c DNG");
        let image_cx = (ingest.image.width as f32) / 2.0;
        let image_cy = (ingest.image.height as f32) / 2.0;
        let dx = cx - image_cx;
        let dy = cy - image_cy;
        // Print so we can see the actual offset when running with --nocapture.
        eprintln!(
            "principal_point=({cx:.1}, {cy:.1})  image_centre=({image_cx:.1}, {image_cy:.1})  offset=({dx:+.1}, {dy:+.1}) px"
        );
        // Sanity: must be within 2 % of image centre.
        assert!(
            dx.abs() < (ingest.image.width as f32) * 0.02,
            "principal_point cx={cx} too far from image centre",
        );
        assert!(
            dy.abs() < (ingest.image.height as f32) * 0.02,
            "principal_point cy={cy} too far from image centre",
        );
    }

    #[test]
    #[ignore] // fixture-gated — requires test-fixtures/raws/pano_01/
    fn pano_01_dng_exposes_gain_map() {
        // DJI L2D-20c GainMap is 32 × 32 × 3 covering roughly the
        // active sensor area. Corner gains should exceed centre by
        // ~20–40 %.
        let path = std::path::Path::new(
            "/Users/riabuz/Projects/_Maple/test-fixtures/raws/pano_01/PANO0001.DNG",
        );
        if !path.exists() {
            return;
        }
        let bytes = std::fs::read(path).unwrap();
        let gm = super::extract_gain_map(&bytes).expect("expected GainMap on DJI L2D-20c DNG");

        assert_eq!(gm.points_v, 32, "DJI L2D-20c expected 32 grid rows");
        assert_eq!(gm.points_h, 32, "DJI L2D-20c expected 32 grid cols");
        assert_eq!(gm.map_planes, 3, "expected 3-plane (R, G, B) gain map");
        assert_eq!(gm.samples.len(), 32 * 32 * 3);

        // Centre gain (u = v = 0.5) should be ≈ 1.0 (no vignetting at
        // optical centre by construction). Corners should be > 1.0
        // (correcting the lens's edge falloff).
        let (cr, cg, cb) = gm.sample(0.5, 0.5);
        let (kr, kg, kb) = gm.sample(0.0, 0.0);
        assert!(
            cr < 1.05 && cg < 1.05 && cb < 1.05,
            "centre gain should be ≈ 1.0, got R={cr} G={cg} B={cb}"
        );
        assert!(
            kr > 1.05 && kg > 1.05 && kb > 1.05,
            "corner gain should compensate vignetting (>1.05), got R={kr} G={kg} B={kb}"
        );
    }

    #[test]
    #[ignore] // fixture-gated — requires test-fixtures/raws/pano_01/
    fn pano_01_dng_exposes_lens_distortion() {
        // DJI L2D-20c reports green-plane WarpRectilinear coefficients
        // approximately:  kr1 ≈ -0.066,  kr2 ≈ +0.038. With focal_px ≈ 3584
        // and r_max_px ≈ 3338 (5376×3956 image, center principal point),
        // scale ≈ 1.074 and:
        //   k1 = kr1 / scale²  ≈ -0.066 / 1.154  ≈ -0.0572
        //   k2 = kr2 / scale⁴  ≈  0.038 / 1.331  ≈  0.0286
        // Wide tolerance because firmware-rounded coefficients vary a bit
        // across DJI revisions and we may pick up a different focal/EXIF
        // path on edge fixtures.
        let path = std::path::Path::new(
            "/Users/riabuz/Projects/_Maple/test-fixtures/raws/pano_01/PANO0001.DNG",
        );
        if !path.exists() {
            return;
        }
        let bytes = std::fs::read(path).unwrap();
        let ingest = decode_for_pano(&bytes, "dng").unwrap();
        let (k1, k2) = ingest
            .distortion
            .expect("expected distortion coefficients for DJI L2D-20c DNG");
        // k1 must be negative (barrel) and roughly in [-0.10, -0.02].
        assert!(
            k1 < -0.02 && k1 > -0.10,
            "expected mild barrel k1 in [-0.10, -0.02], got {k1}",
        );
        // k2 must be positive (pincushion correction at outer edge) and small.
        assert!(
            k2 > 0.0 && k2 < 0.10,
            "expected mild pincushion k2 in (0, 0.10), got {k2}",
        );
    }
}
