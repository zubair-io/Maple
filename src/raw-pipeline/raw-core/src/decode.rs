//! RAW file decode via rawler 0.7.x.
//!
//! Extracts sensor data and metadata into a [`RawImage`] without applying any
//! tone-mapping, demosaic, or sensor linearization. Those steps are handled by
//! later pipeline stages (Task 5.1 onward).
//!
//! # Rawler API notes (0.7.2)
//! - Entry point: `rawler::decode_file(&Path) -> Result<rawler::RawImage>`
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

use std::path::Path;

use rawler::imgop::xyz::Illuminant;
use rawler::rawimage::{RawImageData, RawPhotometricInterpretation};

use crate::error::Error;
use crate::image::{CfaPattern, RawImage};
use crate::math::Matrix3;
use crate::Result;

/// Decode a RAW file at `path` and return a fully-populated [`RawImage`].
///
/// Supports DNG (little- and big-endian), Hasselblad 3FR, and Canon CR2.
/// Returns [`Error::UnsupportedCfa`] for X-Trans patterns.
pub fn decode(path: &Path) -> Result<RawImage> {
    // ── 1. Decode via rawler ───────────────────────────────────────────────
    let raw = rawler::decode_file(path).map_err(|e| Error::Decode {
        path: path.to_path_buf(),
        reason: e.to_string(),
    })?;

    // ── 2. CFA pattern ────────────────────────────────────────────────────
    let cfa = match &raw.photometric {
        RawPhotometricInterpretation::Cfa(cfg) => {
            map_cfa_pattern(&cfg.cfa.name)?
        }
        RawPhotometricInterpretation::LinearRaw => {
            // Linear RAW (some DNGs) — treat as RGGB; crop-aware processing
            // in later tasks can refine if needed.
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
    let black_level = [bl[0] as u32, bl[1] as u32, bl[2] as u32, bl[3] as u32];

    let wl = raw.whitelevel.as_bayer_array();
    // All four positions share the same white level in practice; we take the max
    // to be conservative (never over-clip).
    let white_level = wl.iter().cloned().fold(f32::NEG_INFINITY, f32::max) as u32;

    // ── 5. Raw pixel data ─────────────────────────────────────────────────
    let raw_data: Vec<u16> = match raw.data {
        RawImageData::Integer(data) => data,
        RawImageData::Float(fdata) => {
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
    // rawler stores RGBE; indices 0=R, 1=G, 2=B, 3=Emerald/unused.
    // Normalise so that G==1.0 (conventional camera-space multipliers).
    let wb = raw.wb_coeffs;
    let as_shot_neutral = if wb[0].is_nan() || wb[1].is_nan() || wb[2].is_nan() || wb[1] == 0.0 {
        // rawler signals "no WB" with NaN; fall back to unity.
        [1.0f32, 1.0, 1.0]
    } else {
        let g = wb[1];
        [wb[0] / g, 1.0, wb[2] / g]
    };

    // rawler 0.7 does not expose CCT from metadata. Set to None; a future
    // task (slice 7 XMP round-trip) can populate this from XMP if needed.
    let as_shot_cct: Option<f32> = None;

    // ── 7. Camera make / model ────────────────────────────────────────────
    let camera_make = raw.clean_make.clone();
    let camera_model = raw.clean_model.clone();

    // ── 8. Embedded color matrix (XYZ → Camera) ───────────────────────────
    // Prefer D65 for DNG compatibility; fall back to D50 then first available.
    // `FlatColorMatrix` is a `Vec<f32>` in row-major order.  The DNG spec
    // stores XYZ→Camera matrices that may be 3×3 or 4×3 (for RGBE sensors).
    // We only take the first 3 rows (R G B) and ignore the 4th (E/W channel).
    let embedded_color_matrix: Option<Matrix3> = {
        let cm = raw
            .color_matrix
            .get(&Illuminant::D65)
            .or_else(|| raw.color_matrix.get(&Illuminant::D50))
            .or_else(|| raw.color_matrix.values().next());

        cm.and_then(|flat| {
            if flat.len() < 9 {
                return None;
            }
            // Row-major: rows are camera channels (R,G,B), columns are XYZ
            Some(Matrix3([
                [flat[0], flat[1], flat[2]],
                [flat[3], flat[4], flat[5]],
                [flat[6], flat[7], flat[8]],
            ]))
        })
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
        embedded_color_matrix,
    })
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

    #[test]
    fn decode_test_0002_reports_plausible_dimensions() {
        let path = fixture_root().join("test_0002.dng");
        if !path.exists() {
            eprintln!("skip: {}", path.display());
            return;
        }
        let raw = decode(&path).expect("decode DNG");
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
        let raw = decode(&path).expect("decode CR2");
        assert!(raw.width > 0 && raw.height > 0);
        assert_eq!(raw.camera_make.to_lowercase(), "canon");
    }

    #[test]
    fn decode_test_0001_hasselblad_3fr() {
        let path = fixture_root().join("test_0001.RAW");
        if !path.exists() {
            return;
        }
        let raw = decode(&path).expect("decode 3FR");
        assert!(raw.width > 0 && raw.height > 0);
    }

    #[test]
    fn decode_test_0000_hasselblad_100mp() {
        let path = fixture_root().join("test_0000.DNG");
        if !path.exists() {
            return;
        }
        let raw = decode(&path).expect("decode 100MP DNG");
        assert!(raw.width > 8000, "100MP expected, got {} wide", raw.width);
    }
}
