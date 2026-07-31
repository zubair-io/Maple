//! Embedded preview extraction.
//!
//! The Auto Profile fit needs the camera's embedded preview image (its rendered
//! look) as the fit target. Extraction is layered, in-process first:
//!
//! 1. rawler `preview_image()` — in-process. Unimplemented for every decoder
//!    in rawler 0.7.2 (the trait default returns `None`); kept only to pick up
//!    native preview support if a future rawler adds it.
//! 2. rawler `full_image()` — in-process. Implemented for the common camera
//!    formats (CR2/CR3, DNG, NEF, ARW, RAF, RW2, MRW, PEF, FFF) and returns the
//!    camera's embedded preview *image* — usually a decoded JPEG (cr2 = IFD0,
//!    dng = the `NewSubFileType==1` preview sub-IFD, nef/arw = the largest
//!    `JpegInterchangeFormat` IFD), occasionally uncompressed RGB (e.g. some
//!    CR2), but never a sensor decode — so fitting against it matches the
//!    camera's rendered look. Decoders that don't implement it (e.g. ORF, IIQ,
//!    X3F) return the trait default `None` and fall through to the next tier.
//!    This is the in-process tier that works on the sandboxed Apple app, iOS,
//!    and Web/WASM, none of which can spawn a subprocess (#927).
//! 3. rawler `thumbnail_image()` (DNG only) — in-process. Recovers the
//!    reduced-res (`NewSubFileType==1`) preview when it lives in the ROOT IFD
//!    rather than a sub-IFD (some DNGs, e.g. Apple/iPhone), which `full_image`
//!    doesn't check. Targets `NewSubFileType==1`, so it never returns the
//!    full-res RAW-as-JPEG beside it — non-circular (#930).
//! 4. embedded-JPEG byte scan — in-process, last resort, ONLY for non-TIFF
//!    containers (e.g. Sigma X3F). Such formats embed a JPEG preview but never
//!    RAW-as-JPEG, so the largest color JPEG is safely the preview; gated on the
//!    file lacking TIFF magic so it can never fire on a TIFF/DNG where a blind
//!    scan would be circular (#930).
//! 5. exiftool subprocess (path variant only) — last resort for files rawler
//!    can't decode natively (e.g. iPhone 12 Pro LinearDNG, pre-2020 Adobe DNG).
//!    UNAVAILABLE in the sandboxed macOS app, on iOS, and on Web/WASM, so it
//!    must never be the only path to a preview — that was the bug behind #927.
//!
//! Returns `None` only when no tier yields a preview. The bytes/WASM entry
//! ([`extract_preview_from_bytes`]) has no exiftool tier at all (#870).

use std::path::Path;
use std::process::Command;

use image::DynamicImage;
use rawler::decoders::{FormatHint, RawDecodeParams};
use rawler::rawsource::RawSource;

use crate::color::matrices::{M_REC2020_TO_SRGB, M_XYZ_D65_TO_REC2020};
use crate::image::{apply_orientation, ExifOrientation};
use crate::math::Matrix3;
use crate::view::encode::srgb_gamma;

/// Color space of the embedded preview JPEG. Cameras shoot in different
/// color spaces; the embedded JPEG inherits that setting. Decoding an
/// Adobe RGB JPEG as sRGB compresses its wider gamut into a smaller
/// volume — colors land 30-50% under-saturated, which the Auto Profile
/// fit then learns as the target, producing a flat/desaturated render.
///
/// Test fixtures: `test_0003.CR2` ships Adobe RGB (Canon makernote
/// `Canon:ColorSpace = Adobe RGB`); most others are sRGB.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JpegColorSpace {
    /// IEC 61966-2-1, the DCF default. Most cameras' default.
    SRgb,
    /// Adobe RGB (1998) — wider gamut, gamma 2.2 EOTF.
    AdobeRgb,
}

/// Extract the embedded JPEG preview from a RAW file at `path`.
///
/// Tries rawler first; falls back to `exiftool -b -PreviewImage`, then
/// `exiftool -b -JpgFromRaw`. Returns `None` for any failure or when
/// exiftool is unavailable.
pub fn extract_preview<P: AsRef<Path>>(path: P) -> Option<DynamicImage> {
    if let Ok(src) = RawSource::new(path.as_ref()) {
        if let Some(img) = extract_preview_from_rawsource(&src) {
            return Some(img);
        }
    }
    extract_preview_via_exiftool(path.as_ref())
}

/// A decoded embedded preview plus its detected color space — the unit the
/// Auto Profile fits consume. Extracted ONCE per cold fit and threaded through
/// the curve fit, the residual-LUT fit, and the render path's will-it-fit
/// probe (#1085): pre-fix, each of those three extracted + JPEG-decoded the
/// preview independently (and detected the color space twice).
#[derive(Clone, Debug)]
pub struct ExtractedPreview {
    /// The embedded preview, SENSOR-oriented (as stored in the RAW).
    pub image: DynamicImage,
    /// The preview's color space per [`detect_jpeg_color_space`].
    pub color_space: JpegColorSpace,
}

/// Extract the embedded preview AND detect its color space in one pass — the
/// bundle every Auto Profile fit shares (#1085). Path variant (exiftool
/// fallback included via [`extract_preview`]).
pub fn extract_for_fit<P: AsRef<Path>>(path: P) -> Option<ExtractedPreview> {
    let image = extract_preview(path.as_ref())?;
    let color_space = detect_jpeg_color_space(path.as_ref());
    Some(ExtractedPreview { image, color_space })
}

/// Bytes/WASM mirror of [`extract_for_fit`] (no exiftool tier — see
/// [`extract_preview_from_bytes`]).
pub fn extract_for_fit_from_bytes(bytes: &[u8], ext: &str) -> Option<ExtractedPreview> {
    let image = extract_preview_from_bytes(bytes, ext)?;
    let color_space = detect_jpeg_color_space_from_bytes(bytes, ext);
    Some(ExtractedPreview { image, color_space })
}

/// EXIF orientation (TIFF tag 0x0112) for the RAW at `path`, read from
/// rawler's `raw_metadata().exif.orientation` — the SAME primary source
/// `decode.rs` uses to orient the final render, so the preview and the render
/// agree on every fixture that carries the tag. The embedded JPEG preview is
/// stored in SENSOR orientation; the camera's *displayed* JPEG (and Maple's
/// final render) are in DISPLAY orientation, so comparison consumers must
/// rotate the preview by this orientation first.
///
/// Fallback divergence (intentional, documented): when the metadata tag is
/// absent, `decode.rs` falls back to the decoded `RawImage`'s rawler
/// orientation, whereas here we fall back to `Normal` rather than fully
/// decoding the RAW just for orientation. Every verified fixture carries the
/// metadata tag, so the two paths agree in practice; a preview-less or tag-
/// less RAW is already handled by the `None` extraction fallback upstream.
pub fn preview_orientation<P: AsRef<Path>>(path: P) -> ExifOrientation {
    match RawSource::new(path.as_ref()) {
        Ok(src) => orientation_from_rawsource(&src),
        Err(_) => ExifOrientation::Normal,
    }
}

fn orientation_from_rawsource(src: &RawSource) -> ExifOrientation {
    rawler::get_decoder(src)
        .ok()
        .and_then(|dec| dec.raw_metadata(src, &RawDecodeParams::default()).ok())
        .and_then(|md| md.exif.orientation)
        .map(ExifOrientation::from_u16)
        .unwrap_or(ExifOrientation::Normal)
}

/// Rotate a [`DynamicImage`] from SENSOR into DISPLAY orientation using the
/// same per-pixel mapping the render pipeline applies at end-of-chain
/// ([`crate::image::apply_orientation`]). `Normal` returns the input
/// unchanged. Used by `extract-preview` so the camera-baked reference the
/// Auto Profile gate diffs against is display-oriented (matching the render),
/// not sensor-oriented — without this, rotated fixtures compare a portrait
/// render against a landscape preview through a non-aspect-preserving squash.
pub fn orient_preview_to_display(img: DynamicImage, orient: ExifOrientation) -> DynamicImage {
    if orient == ExifOrientation::Normal {
        return img;
    }
    let rgb = img.to_rgb8();
    let (w, h) = (rgb.width(), rgb.height());
    let (nw, nh, bytes) = apply_orientation(rgb.as_raw(), w, h, orient);
    let buf = image::RgbImage::from_raw(nw, nh, bytes)
        .expect("apply_orientation returns a correctly sized RGB buffer");
    DynamicImage::ImageRgb8(buf)
}

const M_ADOBE_RGB_TO_XYZ_D65: Matrix3 = Matrix3([
    [0.5767309, 0.1855540, 0.1881852],
    [0.2973769, 0.6273491, 0.0752741],
    [0.0270343, 0.0706872, 0.9911085],
]);

const ADOBE_RGB_GAMMA: f32 = 563.0 / 256.0;

fn adobe_to_srgb_matrix() -> Matrix3 {
    static CELL: std::sync::OnceLock<Matrix3> = std::sync::OnceLock::new();
    *CELL.get_or_init(|| {
        let adobe_to_rec2020 = M_XYZ_D65_TO_REC2020.mul_mat(&M_ADOBE_RGB_TO_XYZ_D65);
        M_REC2020_TO_SRGB.mul_mat(&adobe_to_rec2020)
    })
}

/// Decode one embedded-JPEG pixel (channels already normalised to `[0, 1]`)
/// into display-encoded sRGB f32, honouring its color space.
///
/// - [`JpegColorSpace::SRgb`]: the preview is already sRGB-encoded, so this is
///   a passthrough — the only transform the caller needs was the `byte / 255.0`
///   normalisation done before calling.
/// - [`JpegColorSpace::AdobeRgb`]: inverse Adobe-RGB EOTF (`v^γ`, γ = 563/256)
///   → Adobe→sRGB primary matrix → sRGB OETF (`srgb_gamma`).
///
/// This is the exact per-pixel conversion the #550 display-space fit
/// (`fit_display::fit_curve_from_preview_display`) and the LUT pair sampler
/// (`super::pairs::sample_display_pairs`) share, so both decode the preview
/// identically.
pub fn decode_jpeg_pixel_to_srgb(rgb01: [f32; 3], cs: JpegColorSpace) -> [f32; 3] {
    match cs {
        JpegColorSpace::SRgb => rgb01,
        JpegColorSpace::AdobeRgb => {
            let m = adobe_to_srgb_matrix();
            let r_lin = rgb01[0].max(0.0).powf(ADOBE_RGB_GAMMA);
            let g_lin = rgb01[1].max(0.0).powf(ADOBE_RGB_GAMMA);
            let b_lin = rgb01[2].max(0.0).powf(ADOBE_RGB_GAMMA);
            let srgb_lin = m.mul_vec([r_lin, g_lin, b_lin]);
            [
                srgb_gamma(srgb_lin[0]),
                srgb_gamma(srgb_lin[1]),
                srgb_gamma(srgb_lin[2]),
            ]
        }
    }
}

/// Convert a `DynamicImage` from Adobe RGB color space to sRGB color space.
pub fn convert_adobe_rgb_to_srgb(img: DynamicImage) -> DynamicImage {
    let mut rgb = img.to_rgb8();
    let m = adobe_to_srgb_matrix();
    for pixel in rgb.pixels_mut() {
        let r_lin = (pixel[0] as f32 / 255.0).max(0.0).powf(ADOBE_RGB_GAMMA);
        let g_lin = (pixel[1] as f32 / 255.0).max(0.0).powf(ADOBE_RGB_GAMMA);
        let b_lin = (pixel[2] as f32 / 255.0).max(0.0).powf(ADOBE_RGB_GAMMA);
        let srgb_lin = m.mul_vec([r_lin, g_lin, b_lin]);
        pixel[0] = (srgb_gamma(srgb_lin[0]) * 255.0 + 0.5).clamp(0.0, 255.0) as u8;
        pixel[1] = (srgb_gamma(srgb_lin[1]) * 255.0 + 0.5).clamp(0.0, 255.0) as u8;
        pixel[2] = (srgb_gamma(srgb_lin[2]) * 255.0 + 0.5).clamp(0.0, 255.0) as u8;
    }
    DynamicImage::ImageRgb8(rgb)
}

/// Extract the embedded JPEG preview and rotate it into DISPLAY orientation
/// (see [`orient_preview_to_display`]). This is what comparison consumers
/// (the `extract-preview` CLI / Auto Profile gate) want: a preview aligned
/// with Maple's display-oriented render. Returns `None` if extraction fails.
pub fn extract_preview_display_oriented<P: AsRef<Path>>(path: P) -> Option<DynamicImage> {
    let img = extract_preview(path.as_ref())?;
    let oriented = orient_preview_to_display(img, preview_orientation(path.as_ref()));
    let cs = detect_jpeg_color_space(path.as_ref());
    if cs == JpegColorSpace::AdobeRgb {
        Some(convert_adobe_rgb_to_srgb(oriented))
    } else {
        Some(oriented)
    }
}

/// Bytes-based mirror of [`extract_preview`] for the WASM render entry,
/// which has the RAW file's bytes in memory but no filesystem path.
/// No exiftool fallback — WASM has no subprocess access.
///
/// `ext` is the file extension (e.g. `"dng"`, `"cr2"`, `"arw"`) — passed
/// through to rawler as a `with_path("rawfile.<ext>")` hint. Without it,
/// rawler must rely on magic-byte sniffing, which is ambiguous for some
/// formats (matching how `raw-core/src/decode.rs` and `api.rs` hand bytes
/// to rawler). Pass `""` if unknown — rawler will fall back to sniffing.
pub fn extract_preview_from_bytes(bytes: &[u8], ext: &str) -> Option<DynamicImage> {
    let src = rawsource_from_bytes(bytes, ext);
    extract_preview_from_rawsource(&src)
}

fn rawsource_from_bytes(bytes: &[u8], ext: &str) -> RawSource {
    let src = RawSource::new_from_slice(bytes);
    if ext.is_empty() {
        src
    } else {
        src.with_path(format!("rawfile.{ext}"))
    }
}

fn extract_preview_from_rawsource(src: &RawSource) -> Option<DynamicImage> {
    let params = RawDecodeParams::default();
    let decoder = rawler::get_decoder(src).ok()?;
    if let Ok(Some(img)) = decoder.preview_image(src, &params) {
        return Some(img);
    }
    // `preview_image()` is unimplemented for EVERY decoder in rawler 0.7.2 (the
    // trait default just returns `None`), so the call above never succeeds today
    // — it is kept only to pick up native preview support if a future rawler
    // adds it. The working in-process source is `full_image()`, implemented for
    // the common camera formats (CR2/CR3, DNG, NEF, ARW, RAF, RW2, MRW, PEF,
    // FFF). It returns the camera's embedded preview *image* — usually a decoded
    // JPEG (cr2 = IFD0, dng = the `NewSubFileType==1` preview sub-IFD, nef/arw =
    // the largest `JpegInterchangeFormat` IFD), occasionally uncompressed RGB
    // (e.g. some CR2), but never a sensor decode — so fitting against it matches
    // the camera's rendered look, not a self-referential decode of our own
    // pixels. This is the in-process path the sandboxed Apple app, iOS, and
    // Web/WASM rely on (none can reach the `exiftool` subprocess below), so
    // without it Auto Profile silently degrades to Neutral on those surfaces
    // (#927). Decoders that don't implement `full_image` (e.g. ORF, IIQ, X3F),
    // or a file with no embedded preview, return `None`/`Err` here and fall
    // through to the caller's `None` (→ exiftool on the path variant; the
    // bytes/WASM no-preview case stays #870).
    if let Ok(Some(img)) = decoder.full_image(src, &params) {
        return Some(img);
    }
    // `full_image` only checks SUB-IFDs for the `NewSubFileType==1` reduced-res
    // preview; some DNGs (e.g. Apple/iPhone) store it in the ROOT IFD instead,
    // which rawler's `thumbnail_image` checks. It targets `NewSubFileType==1`, so
    // it never returns the full-res RAW-as-JPEG (`NewSubFileType==0`) beside it in
    // a lossy/linear DNG — non-circular (#930). Gate on DNG: the root-IFD preview
    // is a DNG quirk, and `thumbnail_image`'s trait default logs a warning + does
    // nothing for every other decoder, so calling it unconditionally would be
    // log-noise on the X3F / no-preview paths that reach here.
    if decoder.format_hint() == FormatHint::DNG {
        if let Ok(Some(img)) = decoder.thumbnail_image(src, &params) {
            return Some(img);
        }
    }
    // Last in-process resort for a NON-TIFF container (e.g. Sigma X3F — Foveon,
    // with no full/preview/thumbnail). Such formats embed a JPEG preview but
    // never RAW-as-JPEG, so the largest color JPEG is safely the preview. GATE on
    // the file NOT being a TIFF container: every format that can carry a
    // RAW-as-JPEG (DNG and the other TIFF-based raws) starts with TIFF magic, so
    // this can never run there and go circular. (`ifd(Root)` is NOT a usable
    // "non-TIFF" proxy — only the DNG decoder implements `ifd()`, so every other
    // TIFF raw also reports no Root IFD.)
    if !is_tiff_container(src.buf()) {
        if let Some(img) = largest_embedded_jpeg(src.buf()) {
            return Some(img);
        }
    }
    None
}

/// TIFF container magic: little-endian `II 2A 00` or big-endian `MM 00 2A`. DNG
/// and the TIFF-based raws (CR2/NEF/ARW/RW2/…) all start with it; non-TIFF
/// containers (Sigma X3F `FOVb`, Canon CR3 BMFF, Fuji RAF `FUJIFILM`) do not.
/// Used to gate the embedded-JPEG byte scan away from any container that could
/// hold a RAW-as-JPEG.
///
/// `pub(crate)`: shared with [`crate::preview::extract_embedded_preview`]
/// (#2413), which needs the same non-TIFF gate for its own byte-scan tier.
pub(crate) fn is_tiff_container(buf: &[u8]) -> bool {
    matches!(
        buf.get(0..4),
        Some([0x49, 0x49, 0x2A, 0x00]) | Some([0x4D, 0x4D, 0x00, 0x2A])
    )
}

/// Last-resort IN-PROCESS preview for non-TIFF containers (#930): scan `bytes`
/// for embedded JPEG streams and return the largest COLOR JPEG that clears a
/// min-edge threshold. Only reached for non-TIFF files (see `is_tiff_container`),
/// so it can never see a TIFF RAW-as-JPEG. The filters are belt-and-suspenders:
///   * require `FF D8 FF` (JPEG SOI + a marker) to skip the many coincidental
///     `FF D8` byte pairs in sensor data;
///   * reject grayscale decodes (a CFA RAW stored as a 1-component JPEG);
///   * reject `< MIN_EDGE` px (thumbnails);
///   * keep the largest by pixel area (the camera preview dwarfs the thumbnail).
///
/// `pub(crate)`: shared with [`crate::preview::extract_embedded_preview`]
/// (#2413) — see [`is_tiff_container`] doc.
pub(crate) fn largest_embedded_jpeg(bytes: &[u8]) -> Option<DynamicImage> {
    const MIN_EDGE: u32 = 256;
    let mut best: Option<DynamicImage> = None;
    let mut best_area: u64 = 0;
    let mut i = 0usize;
    while i + 2 < bytes.len() {
        if bytes[i] == 0xFF && bytes[i + 1] == 0xD8 && bytes[i + 2] == 0xFF {
            // The jpeg decoder reads to this stream's EOI and ignores trailing
            // bytes; a coincidental SOI over non-JPEG data errors out fast.
            if let Ok(img) =
                image::load_from_memory_with_format(&bytes[i..], image::ImageFormat::Jpeg)
            {
                let (w, h) = (img.width(), img.height());
                let is_color = !matches!(
                    img.color(),
                    image::ColorType::L8
                        | image::ColorType::L16
                        | image::ColorType::La8
                        | image::ColorType::La16
                );
                let area = u64::from(w) * u64::from(h);
                if is_color && w >= MIN_EDGE && h >= MIN_EDGE && area > best_area {
                    best_area = area;
                    best = Some(img);
                }
            }
        }
        i += 1;
    }
    best
}

/// Detect the embedded preview JPEG's color space from the RAW's EXIF
/// via rawler — no subprocess, ships with the app.
///
/// Rule:
///   - Standard EXIF `ColorSpace = 1` → sRGB
///   - Standard EXIF `ColorSpace = 2` → Adobe RGB (Nikon/Sony/Fuji
///     convention; Adobe DNG converter also writes 2)
///   - Standard EXIF `ColorSpace = Uncalibrated (0xFFFF)` AND make
///     is "Canon" → Adobe RGB (Canon's non-standard convention — they
///     write Uncalibrated and stuff the truth in the Canon makernote)
///   - Anything else → sRGB (the DCF default)
///
/// Why Canon needs special-casing: when set to Adobe RGB the body writes
/// `ColorSpace = 0xFFFF` and `InteropIndex = R98 (sRGB)` to the standard
/// tags, then puts the actual setting in `Canon:ColorSpace`. We don't
/// parse Canon makernotes (out of scope for one Adobe-RGB fixture); the
/// `Canon + Uncalibrated → Adobe RGB` heuristic covers the case. sRGB
/// Canon shooting writes `ColorSpace = 1` and is detected correctly.
pub fn detect_jpeg_color_space<P: AsRef<Path>>(path: P) -> JpegColorSpace {
    match RawSource::new(path.as_ref()) {
        Ok(src) => detect_jpeg_color_space_from_rawsource(&src),
        Err(_) => JpegColorSpace::SRgb,
    }
}

/// Bytes-based mirror of [`detect_jpeg_color_space`] for WASM. Same EXIF
/// rules; returns [`JpegColorSpace::SRgb`] on any rawler failure.
///
/// `ext` is the file extension — see [`extract_preview_from_bytes`] doc.
pub fn detect_jpeg_color_space_from_bytes(bytes: &[u8], ext: &str) -> JpegColorSpace {
    let src = rawsource_from_bytes(bytes, ext);
    detect_jpeg_color_space_from_rawsource(&src)
}

fn detect_jpeg_color_space_from_rawsource(raw_src: &RawSource) -> JpegColorSpace {
    let decoder = match rawler::get_decoder(raw_src) {
        Ok(d) => d,
        Err(_) => return JpegColorSpace::SRgb,
    };
    let meta = match decoder.raw_metadata(raw_src, &RawDecodeParams::default()) {
        Ok(m) => m,
        Err(_) => return JpegColorSpace::SRgb,
    };
    let make_is_canon = meta.make.eq_ignore_ascii_case("Canon");
    match meta.exif.color_space {
        Some(1) => JpegColorSpace::SRgb,
        Some(2) => JpegColorSpace::AdobeRgb,
        Some(0xFFFF) | None if make_is_canon => JpegColorSpace::AdobeRgb,
        _ => JpegColorSpace::SRgb,
    }
}

fn extract_preview_via_exiftool(path: &Path) -> Option<DynamicImage> {
    for tag in ["-PreviewImage", "-JpgFromRaw"] {
        let out = Command::new("exiftool")
            .args(["-b", tag, "--"])
            .arg(path)
            .output()
            .ok()?;
        if out.status.success() && !out.stdout.is_empty() {
            if let Ok(img) = image::load_from_memory(&out.stdout) {
                return Some(img);
            }
        }
    }
    None
}
