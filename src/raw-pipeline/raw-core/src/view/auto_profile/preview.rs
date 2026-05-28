//! Embedded JPEG preview extraction with two-tier fallback.
//!
//! 1. rawler `extract_preview_pixels` — fast, no subprocess. Handles
//!    Canon CR2/CR3, Sony ARW, Fuji RAF, most Nikon NEF, modern Hasselblad
//!    FFF, and most baseline DNGs.
//! 2. exiftool subprocess — fallback for formats rawler chokes on, even
//!    when the file contains a standard JPEG (verified: iPhone 12 Pro
//!    LinearDNG and pre-2020 Adobe DNG both miss rawler but extract via
//!    exiftool). Subprocess cost is paid per render call today — a
//!    per-RAW-mtime cache for the fitted [`super::curve::ProfileCurve`]
//!    is the Phase 5 follow-up (`.claude/plans/crystalline-sparking-sun.md`)
//!    that will short-circuit the extract + fit on slider ticks.
//!
//! Returns `None` on any extraction error or when exiftool is absent.

use std::path::Path;
use std::process::Command;

use image::DynamicImage;
use rawler::decoders::RawDecodeParams;
use rawler::rawsource::RawSource;

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

/// Bytes-based mirror of [`extract_preview`] for the WASM render entry,
/// which has the RAW file's bytes in memory but no filesystem path.
/// No exiftool fallback — WASM has no subprocess access.
pub fn extract_preview_from_bytes(bytes: &[u8]) -> Option<DynamicImage> {
    let src = RawSource::new_from_slice(bytes);
    extract_preview_from_rawsource(&src)
}

fn extract_preview_from_rawsource(src: &RawSource) -> Option<DynamicImage> {
    let params = RawDecodeParams::default();
    let decoder = rawler::get_decoder(src).ok()?;
    if let Ok(Some(img)) = decoder.preview_image(src, &params) {
        return Some(img);
    }
    decoder.full_image(src, &params).ok().flatten()
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
pub fn detect_jpeg_color_space_from_bytes(bytes: &[u8]) -> JpegColorSpace {
    let src = RawSource::new_from_slice(bytes);
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
        let out = Command::new("exiftool").args(["-b", tag]).arg(path).output().ok()?;
        if out.status.success() && !out.stdout.is_empty() {
            if let Ok(img) = image::load_from_memory(&out.stdout) {
                return Some(img);
            }
        }
    }
    None
}
