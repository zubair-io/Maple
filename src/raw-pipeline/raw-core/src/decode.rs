//! RAW file decode via rawler 0.7.x.
//!
//! Extracts sensor data and metadata into a [`RawImage`] without applying any
//! tone-mapping, demosaic, or sensor linearization. Those steps are handled by
//! later pipeline stages (Task 5.1 onward).
//!
//! # Rawler API notes (0.7.2)
//! - Entry point: `rawler::decode_file(&Path) -> Result<rawler::RawImage>`
//! - Byte-based entry: `rawler::decode(&RawSource, &RawDecodeParams)` where
//!   `RawSource::new_from_slice(&[u8])` wraps an in-memory buffer and
//!   `.with_path("hint.ext")` attaches an extension hint for format detection.
//! - CFA pattern lives in `rawler::RawImage::photometric` as
//!   `RawPhotometricInterpretation::Cfa(CFAConfig { cfa, .. })` where
//!   `cfa.name` is a string like `"RGGB"` / `"BGGR"` / `"GRBG"` / `"GBRG"`.
//!   Six-character X-Trans names are also possible — those return
//!   `Error::UnsupportedCfa` per spec §3.3.
//! - Black/white levels: `blacklevel.as_bayer_array() -> [f32; 4]` and
//!   `whitelevel.as_bayer_array() -> [f32; 4]`.
//! - WB: `wb_coeffs: [f32; 4]` in RGBE order; index 1 is Green, used as the
//!   normalising channel.
//! - Color matrix: `color_matrix: HashMap<Illuminant, FlatColorMatrix>` where
//!   `FlatColorMatrix = Vec<f32>` (row-major 3×3 or 4×3 XYZ→Camera matrix).
//!   We prefer D65 → D50 → first available, and take only the top 3 rows.
//! - CCT: rawler 0.7 does not expose CCT directly; `as_shot_cct` is `None`.

use std::collections::HashMap;

use rawler::decoders::{RawDecodeParams, WellKnownIFD};
use rawler::imgop::xyz::Illuminant as RawlerIlluminant;
use rawler::rawimage::{RawImageData, RawPhotometricInterpretation};
use rawler::rawsource::RawSource;
use rawler::tags::DngTag;

use crate::color::illuminant::Illuminant as CoreIlluminant;
use crate::error::Error;
use crate::image::{CfaPattern, ExifOrientation, RawImage};
use crate::math::Matrix3;
use crate::Result;

/// Decode a RAW file at `path`. Thin `std::fs::read` wrapper over
/// [`decode_bytes`] — the byte-based entry point used by WASM / non-POSIX
/// callers. Native / CLI / tests can use whichever is more convenient.
pub fn decode(path: &std::path::Path) -> Result<RawImage> {
    let bytes = std::fs::read(path).map_err(|e| Error::Io {
        path: path.to_path_buf(),
        source: e,
    })?;
    let ext = path.extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    decode_bytes(&bytes, &ext)
}

/// Decode a RAW from an in-memory byte slice.
///
/// `ext` is a **lowercase** file extension (e.g. `"dng"`, `"cr2"`, `"arw"`)
/// used by rawler as a format hint when the file's internal magic is ambiguous.
/// It is attached as a dummy path `"rawfile.<ext>"` on the [`RawSource`] so
/// rawler's format-detection logic can key off it.
///
/// This is the browser-safe entry point: WASM has no filesystem paths, so the
/// caller reads the file via the Web File API and passes the bytes + extension
/// here. The existing [`decode`] function is now a thin `std::fs::read` wrapper
/// that delegates here.
pub fn decode_bytes(bytes: &[u8], ext: &str) -> Result<RawImage> {
    // Attach a synthetic filename so rawler can use the extension as a hint.
    let hint_path = format!("rawfile.{}", ext);
    let source = RawSource::new_from_slice(bytes)
        .with_path(std::path::Path::new(&hint_path));

    // ── 1. Decode via rawler ───────────────────────────────────────────────
    let params = RawDecodeParams::default();
    let raw = rawler::decode(&source, &params).map_err(|e| Error::Decode {
        path: std::path::PathBuf::from(&hint_path),
        reason: e.to_string(),
    })?;

    // ── 1a. EXIF orientation ──────────────────────────────────────────────
    // rawler populates `raw.orientation` for DNG via TIFF parsing, but for
    // CR2/ARW it's hardcoded to Normal (see decoders/mod.rs:389 "TODO fixme").
    // To get real orientation for all formats, pull it out of the metadata
    // pass instead — `raw_metadata().exif.orientation` is the raw TIFF tag
    // and works across decoders. Falls back to the RawImage field on error.
    //
    // The same decoder is also queried below for the Root IFD so we can
    // read BaselineExposure (§ 1b). Reusing the decoder avoids re-parsing.
    let decoder = rawler::get_decoder(&source).ok();
    let orientation = decoder.as_ref()
        .and_then(|dec| dec.raw_metadata(&source, &params).ok())
        .and_then(|md| md.exif.orientation)
        .map(ExifOrientation::from_u16)
        .unwrap_or_else(|| rawler_orientation_to_core(&raw.orientation));

    // ── 1b. BaselineExposure + BaselineExposureOffset (DNG § C.1.2 / § 6.2.15) ──
    // Two distinct DNG tags that compose additively when producing the
    // scene-referred exposure correction:
    //   tag 50730 (BaselineExposure, SRational) — per-body calibration.
    //   tag 51109 (BaselineExposureOffset, SRational) — per-image offset
    //     suggested by the DCP profile. Per DNG 1.4 spec § 6.2.15:
    //     "When present, this value is added to BaselineExposure."
    // Both are EV units. Rawler ignores both on decode (only copies them
    // in the DNG writer path — decoders/dng.rs:175 and 186), so we read
    // them directly from the Root IFD.
    //
    // For vendor RAW formats (CR2, RW2, ARW, ...) neither tag is present;
    // we fall back to `camera_calibration::baseline_exposure`.
    let root_ifd = decoder.as_ref()
        .and_then(|dec| dec.ifd(WellKnownIFD::Root).ok().flatten());
    let baseline_tag = root_ifd.as_ref()
        .and_then(|ifd| ifd.get_entry(DngTag::BaselineExposure)
            .map(|e| e.value.force_f32(0)));
    let offset_tag = root_ifd.as_ref()
        .and_then(|ifd| ifd.get_entry(DngTag::BaselineExposureOffset)
            .map(|e| e.value.force_f32(0)));
    let baseline_exposure = match (baseline_tag, offset_tag) {
        (Some(b), Some(o)) => b + o,
        (Some(b), None)    => b,
        (None, Some(o))    => o,
        (None, None)       => crate::camera_calibration::baseline_exposure(
            &raw.clean_make, &raw.clean_model
        ),
    };

    // ── 2. CFA pattern ────────────────────────────────────────────────────
    let cfa = match &raw.photometric {
        RawPhotometricInterpretation::Cfa(cfg) => {
            map_cfa_pattern(&cfg.cfa.name)?
        }
        RawPhotometricInterpretation::LinearRaw => {
            // TODO(slice-4+): LinearRaw DNGs carry already-demosaiced RGB data and may
            // not have a meaningful CFA pattern. Defaulting to RGGB is conservative —
            // slice-1 fixtures don't trigger this path. Revisit when a LinearRaw
            // fixture is added.
            CfaPattern::Rggb
        }
        RawPhotometricInterpretation::BlackIsZero => {
            return Err(Error::UnsupportedCfa("BlackIsZero (monochrome)".to_string()));
        }
    };

    // ── 3. Dimensions ─────────────────────────────────────────────────────
    let width = raw.width as u32;
    let height = raw.height as u32;

    // ── 4. Black / white levels ───────────────────────────────────────────
    // `as_bayer_array()` returns 4 values in [top-left, top-right, bottom-left, bottom-right]
    // order matching the 2×2 Bayer tile — i.e. the same per-position indexing
    // our `RawImage.black_level` uses.
    let bl = raw.blacklevel.as_bayer_array();
    let mut black_level = [
        bl[0].round() as u32,
        bl[1].round() as u32,
        bl[2].round() as u32,
        bl[3].round() as u32,
    ];

    let wl = raw.whitelevel.as_bayer_array();
    // All four positions share the same white level in practice; we take the max
    // to be conservative (never over-clip).
    let mut white_level = wl.iter().cloned().fold(f32::NEG_INFINITY, f32::max).round() as u32;

    // ── 4a. RawTherapee camconst.json override ────────────────────────────
    // When our static table has a per-body entry, replace rawler's black/
    // white with RT's (more precise, per-ISO) values. ISO comes from the
    // same raw_metadata pass used above for orientation; falls back to 100
    // if missing. Data-only override — no math is changed.
    {
        let iso: u32 = decoder.as_ref()
            .and_then(|dec| dec.raw_metadata(&source, &params).ok())
            .and_then(|md| md.exif.iso_speed_ratings.map(|v| v as u32))
            .unwrap_or(100);

        if let Some(lin) = crate::camera_calibration::lookup_linearization(
            &raw.clean_make, &raw.clean_model, iso,
        ) {
            if let Some(bl_bucket) = lin.black_for_iso(iso) {
                black_level = bl_bucket.as_bayer_array();
            }
            if let Some(wl_bucket) = lin.white_for_iso(iso) {
                white_level = wl_bucket.scalar_conservative();
            }
        }
    }

    // ── 5. Raw pixel data ─────────────────────────────────────────────────
    let raw_data: Vec<u16> = match raw.data {
        RawImageData::Integer(data) => data,
        RawImageData::Float(fdata) => {
            // Before rescaling: guard against silent data loss.
            // sensor_linearize (Task 5.1) subtracts black_level from the u16 result,
            // but RawImageData::Float is already black-subtracted/normalized. If the
            // metadata still reports a non-zero black_level, our rescale will produce
            // under-subtracted pixels. None of the slice-1 fixtures hit this path;
            // if a future fixture does, revisit the Float-rescale math.
            if black_level.iter().any(|&b| b > 0) {
                return Err(Error::Decode {
                    path: std::path::PathBuf::from(&hint_path),
                    reason: format!(
                        "RawImageData::Float with non-zero black_level {:?} — \
                         refuse to silently lose data; see decode.rs comment",
                        black_level
                    ),
                });
            }

            // Some DNGs are stored as f32 (linearised). Convert back to u16
            // using the white level so downstream linearisation still works.
            let scale = white_level as f32;
            fdata
                .iter()
                .map(|&v| ((v * scale).round().clamp(0.0, u16::MAX as f32)) as u16)
                .collect()
        }
    };

    // ── 6. White balance ──────────────────────────────────────────────────
    // rawler's `wb_coeffs` are WB *multipliers* (the gains that balance
    // camera RGB to neutral). Confirmed by reading the DNG decoder at
    // rawler-0.7.2/src/decoders/dng.rs:293, which stores
    // `[1.0 / AsShotNeutral[i]]` — i.e. the reciprocal of the DNG-spec
    // AsShotNeutral tag. Other format decoders (ARW, MRW, CR2) follow
    // the same multiplier convention.
    //
    // Our `RawImage::as_shot_neutral` carries the DNG-spec semantics
    // (camera reading of a neutral patch, G-normalized) because the
    // downstream DCP math — `inv(CM) * AsShotNeutral = XYZ_scene_white`
    // — requires the reading, not the multipliers. Invert rawler's
    // values back to reading-space here, once, and flag NaN inputs.
    let wb = raw.wb_coeffs;
    let as_shot_neutral = if wb[0].is_nan() || wb[1].is_nan() || wb[2].is_nan()
        || wb[0] == 0.0 || wb[1] == 0.0 || wb[2] == 0.0
    {
        // rawler signals "no WB" with NaN; fall back to unity (matches a
        // D65-like sensor calibration).
        [1.0f32, 1.0, 1.0]
    } else {
        // multipliers → camera reading, then G-normalize.
        // reading ∝ 1/mult per channel; R/G = (1/R_mult)/(1/G_mult) = G_mult/R_mult.
        let g = wb[1];
        [g / wb[0], 1.0, g / wb[2]]
    };

    // rawler 0.7 does not expose CCT from metadata. Set to None; a future
    // task (slice 7 XMP round-trip) can populate this from XMP if needed.
    let as_shot_cct: Option<f32> = None;

    // ── 7. Camera make / model ────────────────────────────────────────────
    let camera_make = raw.clean_make.clone();
    let camera_model = raw.clean_model.clone();

    // ── 8. Color matrices (XYZ → Camera) per illuminant ──────────────────
    // Collect all per-illuminant calibration matrices into our HashMap.
    // `FlatColorMatrix` is a `Vec<f32>` in row-major order. The DNG spec
    // stores XYZ→Camera matrices that may be 3×3 or 4×3 (for RGBE sensors).
    // We only take the first 3 rows (R G B) and ignore the 4th (E/W channel).
    // This preserves all illuminants for dual-illuminant CCT interpolation
    // in dcp::profile_for (spec § 3.4).
    let color_matrices: HashMap<CoreIlluminant, Matrix3> = {
        let mut map = HashMap::new();
        for (rawler_illum, flat) in &raw.color_matrix {
            if flat.len() < 9 {
                continue;
            }
            let core_illum = rawler_illuminant_to_core(rawler_illum);
            let m = Matrix3([
                [flat[0], flat[1], flat[2]],
                [flat[3], flat[4], flat[5]],
                [flat[6], flat[7], flat[8]],
            ]);
            // If multiple rawler illuminants map to the same CoreIlluminant,
            // keep the first insertion (HashMap::entry().or_insert semantics).
            map.entry(core_illum).or_insert(m);
        }
        map
    };

    Ok(RawImage {
        width,
        height,
        cfa,
        black_level,
        white_level,
        raw_data,
        as_shot_neutral,
        as_shot_cct,
        camera_make,
        camera_model,
        color_matrices,
        orientation,
        baseline_exposure,
    })
}

/// Map rawler's `Orientation` enum to our `ExifOrientation`. Used as the
/// fallback when `raw_metadata().exif.orientation` is absent.
fn rawler_orientation_to_core(o: &rawler::decoders::Orientation) -> ExifOrientation {
    use rawler::decoders::Orientation as R;
    match o {
        R::Normal | R::Unknown => ExifOrientation::Normal,
        R::HorizontalFlip => ExifOrientation::HorizontalFlip,
        R::Rotate180 => ExifOrientation::Rotate180,
        R::VerticalFlip => ExifOrientation::VerticalFlip,
        R::Transpose => ExifOrientation::Transpose,
        R::Rotate90 => ExifOrientation::Rotate90,
        R::Transverse => ExifOrientation::Transverse,
        R::Rotate270 => ExifOrientation::Rotate270,
    }
}

/// Map a rawler `Illuminant` to our `CoreIlluminant`.
///
/// Rawler's enum (from `rawler::imgop::xyz::Illuminant`) covers the full DNG
/// CalibrationIlluminant tag range. We collapse it to our five-variant enum:
/// StdA (illuminant A, ~2856K), D50, D55, D65, and Other for everything else.
/// Tungsten / IsoStudioTungsten are both incandescent (~3200K) and map to
/// `Other(3200)` — distinct from StdA (~2856K) which is the DNG standard for
/// dual-illuminant CM1. If a fixture uses `Tungsten` as CM1, it will degrade
/// to the single-illuminant fallback path in `profile_for`, which is fine.
fn rawler_illuminant_to_core(r: &RawlerIlluminant) -> CoreIlluminant {
    match r {
        RawlerIlluminant::A => CoreIlluminant::StdA,
        RawlerIlluminant::D50 => CoreIlluminant::D50,
        RawlerIlluminant::D55 => CoreIlluminant::D55,
        RawlerIlluminant::D65 => CoreIlluminant::D65,
        RawlerIlluminant::Tungsten => CoreIlluminant::Other(3200),
        RawlerIlluminant::IsoStudioTungsten => CoreIlluminant::Other(3200),
        other => {
            // Unknown illuminant — fall back to D65. This covers Daylight,
            // Fluorescent, Flash, CloudyWeather, etc. The interpolation logic
            // in profile_for degrades gracefully to single-illuminant fallback.
            let _ = other;
            CoreIlluminant::D65
        }
    }
}

/// Map a rawler CFA name string to our [`CfaPattern`] enum.
///
/// Only 2×2 Bayer patterns are supported. X-Trans (36-char) and other exotic
/// patterns return [`Error::UnsupportedCfa`] per spec §3.3.
fn map_cfa_pattern(name: &str) -> Result<CfaPattern> {
    match name {
        "RGGB" => Ok(CfaPattern::Rggb),
        "BGGR" => Ok(CfaPattern::Bggr),
        "GRBG" => Ok(CfaPattern::Grbg),
        "GBRG" => Ok(CfaPattern::Gbrg),
        other => Err(Error::UnsupportedCfa(other.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../test-fixtures/raws")
    }

    /// Shell helper for tests only: read from disk, then delegate to
    /// [`decode_bytes`]. The core no longer exposes a path-based entrypoint —
    /// I/O is the shell's responsibility (spec §02).
    fn decode_path(path: &std::path::Path) -> Result<RawImage> {
        let bytes = std::fs::read(path).map_err(|e| Error::Io {
            path: path.to_path_buf(), source: e,
        })?;
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        decode_bytes(&bytes, ext)
    }

    #[test]
    fn decode_test_0002_reports_plausible_dimensions() {
        let path = fixture_root().join("test_0002.dng");
        if !path.exists() {
            eprintln!("skip: {}", path.display());
            return;
        }
        let raw = decode_path(&path).expect("decode DNG");
        assert!(raw.width >= 1024, "suspiciously narrow: {}", raw.width);
        assert!(raw.height >= 1024, "suspiciously short: {}", raw.height);
        assert_eq!(raw.raw_data.len(), (raw.width as usize) * (raw.height as usize));
        assert!(raw.white_level > 0);
        assert!(matches!(
            raw.cfa,
            CfaPattern::Rggb | CfaPattern::Bggr | CfaPattern::Grbg | CfaPattern::Gbrg
        ));
    }

    #[test]
    fn decode_test_0003_canon_cr2() {
        let path = fixture_root().join("test_0003.CR2");
        if !path.exists() {
            return;
        }
        let raw = decode_path(&path).expect("decode CR2");
        assert!(raw.width > 0 && raw.height > 0);
        assert_eq!(raw.camera_make.to_lowercase(), "canon");
    }

    #[test]
    fn decode_test_0001_hasselblad_3fr() {
        let path = fixture_root().join("test_0001.RAW");
        if !path.exists() {
            return;
        }
        let raw = decode_path(&path).expect("decode 3FR");
        assert!(raw.width > 0 && raw.height > 0);
    }

    #[test]
    fn decode_test_0000_hasselblad_100mp() {
        let path = fixture_root().join("test_0000.DNG");
        if !path.exists() {
            return;
        }
        let raw = decode_path(&path).expect("decode 100MP DNG");
        assert!(raw.width > 8000, "100MP expected, got {} wide", raw.width);
    }

    /// Regression test for BaselineExposure reading (DNG § C.1.2, tag 50730).
    #[test]
    fn decode_test_0000_reads_baseline_exposure() {
        let path = fixture_root().join("test_0000.DNG");
        if !path.exists() { return; }
        let raw = decode_path(&path).expect("decode Hasselblad DNG");
        assert!((raw.baseline_exposure - 1.01).abs() < 0.01,
            "expected BaselineExposure ≈ 1.01 EV, got {:.4}", raw.baseline_exposure);
    }

    /// Regression test for fix #4 (EXIF orientation): test_0003.CR2 was shot
    /// in portrait, so its EXIF orientation tag must be a non-Normal value.
    #[test]
    fn decode_test_0003_reports_exif_orientation() {
        let path = fixture_root().join("test_0003.CR2");
        if !path.exists() { return; }
        let raw = decode_path(&path).expect("decode CR2");
        assert_ne!(raw.orientation, ExifOrientation::Normal,
            "expected a non-Normal EXIF orientation for portrait CR2; got {:?}",
            raw.orientation);
    }

    /// Verify decode_bytes works on Canon CR2 format via extension hint.
    #[test]
    fn decode_bytes_works_on_cr2() {
        let path = fixture_root().join("test_0003.CR2");
        if !path.exists() { return; }
        let bytes = std::fs::read(&path).unwrap();
        let raw = decode_bytes(&bytes, "cr2").expect("decode cr2 from bytes");
        assert!(raw.width > 0 && raw.height > 0);
        assert_eq!(raw.camera_make.to_lowercase(), "canon");
    }

    /// `decode_bytes` must error cleanly (not panic) on a non-RAW byte blob.
    #[test]
    fn decode_bytes_garbage_errors() {
        let junk = vec![0u8; 128];
        let err = decode_bytes(&junk, "dng").unwrap_err();
        match err {
            Error::Decode { .. } => {}
            other => panic!("expected Error::Decode, got {:?}", other),
        }
    }
}
