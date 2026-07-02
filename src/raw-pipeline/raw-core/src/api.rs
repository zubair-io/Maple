//! EXIF + decode façade for `raw-core`.
//!
//! Shell-agnostic, byte-in/byte-out helpers consumed inside the crate (the
//! image-identity derivation in [`crate::id`] takes the parsed [`Exif`]) and
//! by the `xtrans_e2e` example. It is intentionally:
//!
//! * No filesystem access — every entry point takes or returns bytes.
//! * No wall-clock dependency, no unseeded RNG (see `docs/best-practices.md`
//!   "Rust core → determinism").
//! * Never panics on bad input: returns [`Error`] instead.
//!
//! History: this module used to also carry a render façade (`apply`,
//! `histogram`, `waveform`, `thumbnail`, `preview`, `encode`) and a *second*
//! XMP reader/writer (`xmp_read` / `xmp_write` / `Sidecar`) duplicating the
//! dual-namespace contract in [`crate::xmp`]. Both surfaces had zero
//! consumers across `raw-ffi`, `raw-wasm`, and `maple-cli` and were removed in
//! #1090 — the live render path is [`crate::pipeline::render_from_raw`] and the
//! sole XMP implementation is [`crate::xmp`].

use crate::error::{Error, Result};
use crate::image::{ExifOrientation, RawImage};

use rawler::decoders::RawDecodeParams;
use rawler::formats::tiff::{Rational, SRational};
use rawler::rawsource::RawSource;

// ─── Types ────────────────────────────────────────────────────────────────

/// Parsed EXIF payload. All fields are `Option` because the tag set a camera
/// emits is vendor-dependent.
#[derive(Clone, Debug, Default)]
pub struct Exif {
    pub camera_make: Option<String>,
    pub camera_model: Option<String>,
    pub lens_make: Option<String>,
    pub lens_model: Option<String>,
    /// ISO speed (EXIF `ISOSpeedRatings` or `ISOSpeed`).
    pub iso: Option<u32>,
    /// Shutter speed in seconds. Derived from EXIF `ExposureTime` (Rational).
    pub shutter_s: Option<f32>,
    /// F-number. Derived from EXIF `FNumber` (Rational).
    pub aperture: Option<f32>,
    /// Focal length in millimetres.
    pub focal_mm: Option<f32>,
    /// Capture time as an EXIF string ("YYYY:MM:DD HH:MM:SS"). Preserved
    /// verbatim — timezone handling is shell-side.
    pub captured_at: Option<String>,
    pub gps: Option<ExifGps>,
    pub orientation: ExifOrientation,
}

/// Decimal GPS coordinates. Spec §07 stores these as GeoJSON Point in
/// MongoDB; the core returns raw degrees.
#[derive(Copy, Clone, Debug)]
pub struct ExifGps {
    pub lat_deg: f64,
    pub lon_deg: f64,
    pub altitude_m: Option<f32>,
}

// ─── Decode / EXIF ───────────────────────────────────────────────────────

/// Decode a RAW from an in-memory byte slice.
///
/// The `ext` hint is a lowercase file extension (`"dng"`, `"cr2"`, `"arw"`,
/// …). Spec §02 lists this entry as `decode_raw(bytes)`, but rawler's format
/// dispatcher needs the hint when magic is ambiguous; taking it here avoids a
/// fragile sniff. Shells pass through the extension they already have.
pub fn decode_raw(bytes: &[u8], ext: &str) -> Result<RawImage> {
    crate::decode::decode_bytes(bytes, ext)
}

/// Extract EXIF metadata from a RAW byte slice without running the full
/// decode pipeline.
///
/// Reuses rawler's metadata pass (the same path `decode_raw` uses for
/// orientation + baseline exposure). Cheap compared to a full RAW decode.
pub fn read_exif(bytes: &[u8], ext: &str) -> Result<Exif> {
    let hint_path = format!("rawfile.{}", ext);
    let source = RawSource::new_from_slice(bytes).with_path(std::path::Path::new(&hint_path));
    let params = RawDecodeParams::default();
    let decoder = rawler::get_decoder(&source).map_err(|e| Error::Decode {
        path: std::path::PathBuf::from(&hint_path),
        reason: e.to_string(),
    })?;
    let md = decoder
        .raw_metadata(&source, &params)
        .map_err(|e| Error::Decode {
            path: std::path::PathBuf::from(&hint_path),
            reason: e.to_string(),
        })?;
    let exif = &md.exif;

    // Rawler's Rational is (n, d). Convert to f32 on extract.
    let rat_f32 = |r: &Rational| -> f32 {
        if r.d == 0 {
            0.0
        } else {
            r.n as f32 / r.d as f32
        }
    };
    let srat_f32 = |r: &SRational| -> f32 {
        if r.d == 0 {
            0.0
        } else {
            r.n as f32 / r.d as f32
        }
    };

    let iso = exif.iso_speed_ratings.map(|v| v as u32).or(exif.iso_speed);

    // ExposureTime is the canonical shutter-seconds tag. Fallback to
    // ShutterSpeedValue (APEX units: 2^-val = seconds) if absent.
    let shutter_s = exif.exposure_time.as_ref().map(rat_f32).or_else(|| {
        exif.shutter_speed_value
            .as_ref()
            .map(|s| 2.0_f32.powf(-srat_f32(s)))
    });

    let aperture = exif.fnumber.as_ref().map(rat_f32).or_else(|| {
        exif.aperture_value
            .as_ref()
            .map(|a| 2.0_f32.powf(rat_f32(a) * 0.5))
    });

    let focal_mm = exif.focal_length.as_ref().map(rat_f32);

    let captured_at = exif
        .date_time_original
        .clone()
        .or_else(|| exif.create_date.clone())
        .or_else(|| exif.modify_date.clone());

    let gps = exif.gps.as_ref().and_then(|g| {
        // rawler's ExifGPS stores lat/lon as [deg, min, sec] rationals with
        // N/S + E/W refs. Convert to decimal degrees.
        let to_decimal = |dms: &[Rational; 3], neg: bool| -> f64 {
            let d = if dms[0].d == 0 {
                0.0
            } else {
                dms[0].n as f64 / dms[0].d as f64
            };
            let m = if dms[1].d == 0 {
                0.0
            } else {
                dms[1].n as f64 / dms[1].d as f64
            };
            let s = if dms[2].d == 0 {
                0.0
            } else {
                dms[2].n as f64 / dms[2].d as f64
            };
            let decimal = d + m / 60.0 + s / 3600.0;
            if neg {
                -decimal
            } else {
                decimal
            }
        };
        match (
            g.gps_latitude,
            g.gps_latitude_ref.as_deref(),
            g.gps_longitude,
            g.gps_longitude_ref.as_deref(),
        ) {
            (Some(lat), Some(lat_ref), Some(lon), Some(lon_ref)) => {
                let lat_deg = to_decimal(&lat, lat_ref.eq_ignore_ascii_case("S"));
                let lon_deg = to_decimal(&lon, lon_ref.eq_ignore_ascii_case("W"));
                let altitude_m = g.gps_altitude.as_ref().map(rat_f32);
                Some(ExifGps {
                    lat_deg,
                    lon_deg,
                    altitude_m,
                })
            }
            _ => None,
        }
    });

    let none_if_empty = |s: String| if s.is_empty() { None } else { Some(s) };

    Ok(Exif {
        camera_make: none_if_empty(md.make.clone()),
        camera_model: none_if_empty(md.model.clone()),
        lens_make: exif.lens_make.clone(),
        lens_model: exif.lens_model.clone(),
        iso,
        shutter_s,
        aperture,
        focal_mm,
        captured_at,
        gps,
        orientation: exif
            .orientation
            .map(ExifOrientation::from_u16)
            .unwrap_or_default(),
    })
}

// ─── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::fixtures::require_raw;

    // ─── decode_raw ────────────────────────────────────────────────────

    #[test]
    #[cfg_attr(not(feature = "fixtures"), ignore)]
    fn decode_raw_happy_path_for_test_0002() {
        let path = require_raw("test_0002.dng");
        let bytes = std::fs::read(&path).unwrap();
        let raw = decode_raw(&bytes, "dng").expect("decode_raw");
        assert!(raw.width > 0 && raw.height > 0);
    }

    #[test]
    fn decode_raw_errors_on_garbage() {
        let junk = vec![0u8; 128];
        assert!(decode_raw(&junk, "dng").is_err());
    }

    // ─── read_exif ─────────────────────────────────────────────────────

    #[test]
    #[cfg_attr(not(feature = "fixtures"), ignore)]
    fn read_exif_returns_camera_for_test_0002() {
        let path = require_raw("test_0002.dng");
        let bytes = std::fs::read(&path).unwrap();
        let exif = read_exif(&bytes, "dng").expect("read_exif");
        assert!(
            exif.camera_make.is_some() || exif.camera_model.is_some(),
            "expected camera metadata, got {:?}",
            exif
        );
    }

    #[test]
    fn read_exif_errors_on_garbage() {
        let junk = vec![0u8; 128];
        assert!(read_exif(&junk, "dng").is_err());
    }

    // ─── maple_id (derived from the parsed Exif) ───────────────────────

    fn exif_with_capture(ts: &str) -> Exif {
        Exif {
            captured_at: Some(ts.into()),
            ..Default::default()
        }
    }

    #[test]
    fn maple_id_primary_is_deterministic() {
        let bytes = b"the quick brown fox jumps over the lazy dog".repeat(4000);
        let exif = exif_with_capture("2025:06:01 12:34:56");
        let a = crate::id::maple_id(&bytes, &exif, Some("SERIAL42"), Some(1234));
        let b = crate::id::maple_id(&bytes, &exif, Some("SERIAL42"), Some(1234));
        assert_eq!(a, b);
        assert_eq!(a.kind(), crate::id::IdKind::Primary);
    }

    #[test]
    fn maple_id_primary_changes_with_capture_time() {
        let bytes = vec![7u8; 4096];
        let e1 = exif_with_capture("2025:06:01 12:34:56");
        let e2 = exif_with_capture("2025:06:01 12:34:57"); // +1 second
        let id1 = crate::id::maple_id(&bytes, &e1, None, None);
        let id2 = crate::id::maple_id(&bytes, &e2, None, None);
        assert_ne!(id1, id2);
    }

    #[test]
    fn maple_id_fallback_when_exif_missing() {
        let bytes = vec![42u8; 1024];
        let exif = Exif::default(); // captured_at = None
        let id = crate::id::maple_id(&bytes, &exif, None, None);
        assert_eq!(id.kind(), crate::id::IdKind::Fallback);
    }

    #[test]
    fn maple_id_tag_byte_distinguishes_forms() {
        let bytes = vec![0xA5u8; 2048];
        let primary = crate::id::MapleId::primary(&bytes, "2025:06:01 00:00:00", None, None);
        let fallback = crate::id::MapleId::fallback(&bytes, bytes.len() as u64);
        assert_ne!(primary.0[0], fallback.0[0]);
        assert_eq!(primary.0[0], crate::id::TAG_PRIMARY);
        assert_eq!(fallback.0[0], crate::id::TAG_FALLBACK);
        // And thus the full ids cannot alias.
        assert_ne!(primary, fallback);
    }

    #[test]
    fn maple_id_hex_roundtrip() {
        let bytes = vec![1u8, 2, 3, 4, 5];
        let id = crate::id::MapleId::fallback(&bytes, 5);
        let hex = id.to_hex();
        assert_eq!(hex.len(), 32);
        let back = crate::id::MapleId::from_hex(&hex).expect("from_hex");
        assert_eq!(back, id);
    }
}
