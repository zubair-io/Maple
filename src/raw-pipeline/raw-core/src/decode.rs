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
use crate::image::{CfaPattern, CropRect, ExifOrientation, RawImage};
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
    let ext = path
        .extension()
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
    let source = RawSource::new_from_slice(bytes).with_path(std::path::Path::new(&hint_path));

    // Foveon X3F: rawler 0.7 ships an X3F decoder stub that returns
    // "X3F decoding not implemented yet" from its compressed-image
    // branch. Surface that as a structured `UnsupportedFormat` error
    // rather than a generic `Decode` so callers can render a clear
    // "this format isn't supported" message. See ticket #417.
    //
    // We dispatch on the extension hint (X3F is not magic-byte-clean
    // enough to detect via leading bytes), which matches how the rest
    // of the decode path uses `ext` for routing.
    if ext.eq_ignore_ascii_case("x3f") {
        return Err(Error::UnsupportedFormat(
            "Sigma Foveon (.X3F) decoding is not supported — the embedded \
             rawler decoder is a stub. Tracked under #417."
                .into(),
        ));
    }

    // ── 1. Decode via rawler ───────────────────────────────────────────────
    let params = RawDecodeParams::default();
    let raw = rawler::decode(&source, &params).map_err(|e| {
        // Belt-and-braces: even when ext wasn't `.x3f` (e.g. a wrapped
        // X3F passed without the extension hint), rawler's own decoder
        // emits "X3F decoding not implemented yet" — promote it to the
        // structured variant so callers can branch on it.
        let msg = e.to_string();
        if msg.contains("X3F decoding not implemented") {
            Error::UnsupportedFormat(format!(
                "Sigma Foveon (.X3F) decoding is not supported: {}",
                msg
            ))
        } else {
            Error::Decode {
                path: std::path::PathBuf::from(&hint_path),
                reason: msg,
            }
        }
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
    let orientation = decoder
        .as_ref()
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
    let root_ifd = decoder
        .as_ref()
        .and_then(|dec| dec.ifd(WellKnownIFD::Root).ok().flatten());
    let noise_profile = root_ifd
        .as_ref()
        .and_then(|ifd| read_floats(ifd, DngTag::NoiseProfile))
        .or_else(|| {
            decoder
                .as_ref()
                .and_then(|dec| dec.ifd(WellKnownIFD::Raw).ok().flatten())
                .as_ref()
                .and_then(|ifd| read_floats(ifd, DngTag::NoiseProfile))
        });
    let baseline_tag = root_ifd.as_ref().and_then(|ifd| {
        ifd.get_entry(DngTag::BaselineExposure)
            .map(|e| e.value.force_f32(0))
    });
    let offset_tag = root_ifd.as_ref().and_then(|ifd| {
        ifd.get_entry(DngTag::BaselineExposureOffset)
            .map(|e| e.value.force_f32(0))
    });
    // BaselineExposure resolution (compose chain):
    //
    //   MAPLE_BE_OVERRIDE (env, dev-only) → absolute override
    //                                       OR
    //   (DNG BaselineExposure tag)
    //     + (DNG BaselineExposureOffset tag)
    //     + (bundled DCP profile baseline_exposure_offset)
    //
    // Each contribution defaults to 0.0 when absent. The bundled-profile
    // term is sourced via `color::profile_loader::lookup_profile` once the
    // `RawImage` is otherwise assembled (it gates on the same matrix /
    // PLT checks the rest of the pipeline uses). Only 5/1447 bundled
    // profiles ship a non-zero offset; the field was previously parsed but
    // never applied — see ticket #370 for the architectural rationale.
    // (The per-body aesthetic-alignment Look LUT that #370 deferred to
    // shipped briefly under #371 and was retired in #443 / closing step
    // of #416 — color correctness now comes from colorimetry + AgX, not
    // a per-body 1D bridge.)
    //
    // MAPLE_BE_OVERRIDE is a dev-only absolute override (replaces the
    // entire chain) used by harness sweeps; production never sets it.
    let be_override = std::env::var("MAPLE_BE_OVERRIDE")
        .ok()
        .and_then(|s| s.parse::<f32>().ok());
    let be_from_tags = baseline_tag.unwrap_or(0.0) + offset_tag.unwrap_or(0.0);

    // ── 2. CFA pattern ────────────────────────────────────────────────────
    let cfa = match &raw.photometric {
        RawPhotometricInterpretation::Cfa(cfg) => map_cfa_pattern_with_pattern(&cfg.cfa)?,
        RawPhotometricInterpretation::LinearRaw => {
            // DNG PhotometricInterpretation = LinearRaw (34892): the file
            // already carries demosaiced, white-balanced 3-channel RGB.
            // Emit the LinearRgb cfa variant; pipeline.rs routes through
            // linearize::linearraw_to_camera_rgb instead of the mosaic path,
            // and dcp::profile_for sets wb_already_baked so AsShotNeutral
            // is not re-applied. See ticket #07.
            CfaPattern::LinearRgb
        }
        RawPhotometricInterpretation::BlackIsZero => {
            return Err(Error::UnsupportedCfa(
                "BlackIsZero (monochrome)".to_string(),
            ));
        }
    };

    // ── 3. Dimensions ─────────────────────────────────────────────────────
    let width = raw.width as u32;
    let height = raw.height as u32;

    // Reject zero / degenerate dimensions before they reach the pipeline
    // (#1087). Rawler passes malformed declarations through on some
    // container paths (e.g. an uncompressed DNG strip with ImageLength = 0
    // decodes "successfully" to an empty buffer), and downstream stages
    // hard-panic on them instead of erroring: `sensor_linearize` feeds the
    // width into rayon's `par_chunks_mut`, which aborts on a chunk size of
    // zero, and the half-res demosaic halves each axis first (1 px → 0) so
    // even a 1-px-wide input dies the same way. A Bayer mosaic needs at
    // least one full 2×2 CFA quad to mean anything (and no real camera
    // file of any kind is under 2 px on a side), so enforce that floor
    // here — decode must fail with a structured error, never panic, on
    // untrusted input.
    if width < 2 || height < 2 {
        return Err(Error::Decode {
            path: std::path::PathBuf::from(&hint_path),
            reason: format!(
                "invalid sensor dimensions {}×{}: a decodable RAW must be \
                 at least 2×2 pixels",
                width, height
            ),
        });
    }

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
    let iso: u32 = decoder
        .as_ref()
        .and_then(|dec| dec.raw_metadata(&source, &params).ok())
        .and_then(|md| md.exif.iso_speed_ratings.map(|v| v as u32))
        .unwrap_or(100);

    {
        if let Some(lin) =
            crate::camera_calibration::lookup_linearization(&raw.clean_make, &raw.clean_model, iso)
        {
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
    let as_shot_neutral = if wb[0].is_nan()
        || wb[1].is_nan()
        || wb[2].is_nan()
        || wb[0] == 0.0
        || wb[1] == 0.0
        || wb[2] == 0.0
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

    // DNG UniqueCameraModel tag (50708). Apple DNGs ship a per-lens-variant
    // UCM ("iPhone13,3 back telephoto camera") that's distinct from
    // `clean_model`. The bundled-DCP lookup keys off this when present so
    // the lens variant resolves to the correct upstream profile. Vendor RAWs
    // (CR2, ARW, NEF, ...) typically omit the tag — None there is fine,
    // the loader falls back to `camera_model`.
    let unique_camera_model: Option<String> = root_ifd.as_ref().and_then(|ifd| {
        ifd.get_entry(DngTag::UniqueCameraModel)
            .and_then(|e| match &e.value {
                rawler::formats::tiff::Value::Ascii(s) => {
                    // Take the first string when multiple ASCII strings are packed.
                    s.strings().first().map(|raw| {
                        // ASCII tag may include a trailing NUL terminator —
                        // trim it (and any whitespace) before bundling.
                        raw.trim_end_matches('\0').trim().to_string()
                    })
                }
                _ => None,
            })
            .filter(|s| !s.is_empty())
    });

    // ── 8. Color matrices (XYZ → Camera) per illuminant ──────────────────
    // Collect all per-illuminant calibration matrices into our HashMap.
    // `FlatColorMatrix` is a `Vec<f32>` in row-major order. The DNG spec
    // stores XYZ→Camera matrices that may be 3×3 or 4×3 (for RGBE sensors).
    // We only take the first 3 rows (R G B) and ignore the 4th (E/W channel).
    // This preserves all illuminants for dual-illuminant CCT interpolation
    // in dcp::profile_for (spec § 3.4).
    //
    // Source-mixing avoidance (ticket #345 + #424): rawler exposes
    // `raw.color_matrix` whether or not the source file actually shipped
    // ColorMatrix tags — for vendor RAW formats (.fff/.cr2/.arw/.nef) the
    // map is rawler's dcraw-lineage per-body substitute, NOT a matrix
    // from the file. Empirically those substitutes regress fixtures
    // versus the bundled or generic fallbacks (test_0004 .fff regresses
    // 7.24 → 8.86 ΔE if treated as a real embedded matrix), so we only
    // populate `color_matrices` when the source file's Root IFD actually
    // carries `ColorMatrix1` and/or `ColorMatrix2` tags. DNG sources
    // always do; vendor RAWs typically don't.
    let cm_in_ifd = root_ifd.as_ref().is_some_and(|ifd| {
        ifd.as_ref().get_entry(DngTag::ColorMatrix1).is_some()
            || ifd.as_ref().get_entry(DngTag::ColorMatrix2).is_some()
    });
    let color_matrices: HashMap<CoreIlluminant, Matrix3> = if cm_in_ifd {
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
    } else {
        // Vendor-RAW source (no DNG-spec ColorMatrix tag in the IFD): drop
        // rawler's dcraw-lineage substituted matrices to prevent the source-
        // mixing failure mode. `dcp::profile_for_with_source` will fall
        // through to its `Generic` (D65 → Rec.2020) fallback instead.
        HashMap::new()
    };

    // ── 8b. ForwardMatrix1 / ForwardMatrix2 (DNG § 1.4.4.3) ───────────────
    // Camera→XYZ-D50 chromatic adaptation matrices. When present, the DCP
    // path uses these instead of Bradford CA (see `dcp::apply`). Tags:
    //   50964 ForwardMatrix1 (SRATIONAL[9], paired with CalibrationIlluminant1)
    //   50965 ForwardMatrix2 (SRATIONAL[9], paired with CalibrationIlluminant2)
    // Indexed by the same `Illuminant` keys as `color_matrices` so dual-CM
    // interpolation can pair them up. Empty for non-Apple bodies (Canon,
    // Nikon, Sony, Hasselblad, ...) which typically omit FM tags.
    let forward_matrices: HashMap<CoreIlluminant, Matrix3> = {
        let mut map = HashMap::new();
        if let Some(ifd) = root_ifd.as_ref() {
            // Helper: read a 9-float matrix at a tag and pair with an illuminant tag.
            let read_fm =
                |fm_tag: DngTag, illum_tag: DngTag| -> Option<(CoreIlluminant, Matrix3)> {
                    let floats = read_floats(ifd.as_ref(), fm_tag)?;
                    if floats.len() < 9 {
                        return None;
                    }
                    let m = Matrix3([
                        [floats[0], floats[1], floats[2]],
                        [floats[3], floats[4], floats[5]],
                        [floats[6], floats[7], floats[8]],
                    ]);
                    let illum_code = ifd.as_ref().get_entry(illum_tag)?.value.force_u16(0);
                    let illum = exif_illuminant_to_core(illum_code);
                    Some((illum, m))
                };
            if let Some((illum, m)) =
                read_fm(DngTag::ForwardMatrix1, DngTag::CalibrationIlluminant1)
            {
                map.insert(illum, m);
            }
            if let Some((illum, m)) =
                read_fm(DngTag::ForwardMatrix2, DngTag::CalibrationIlluminant2)
            {
                map.insert(illum, m);
            }
        }
        map
    };

    // ── 9. HSM / PLT (DNG § 6.6 / § 6.7) ──────────────────────────────────
    // Same pattern as BaselineExposure (§ 1b): rawler stores these tags
    // unparsed in the Root IFD; we read them by tag and assemble HsmTable
    // structs. Both HSM and PLT share the algorithm in `color::hsm`. Tags:
    //   50937 ProfileHueSatMapDims (3 × LONG)        → [hue, sat, val]
    //   50938 ProfileHueSatMapData1 (FLOAT[*])
    //   50939 ProfileHueSatMapData2 (FLOAT[*])       (optional 2nd illuminant)
    //   50981 ProfileLookTableDims (3 × LONG)        → [hue, sat, val]
    //   50982 ProfileLookTableData (FLOAT[*])
    //   51107 ProfileHueSatMapEncoding (LONG)        0 = Linear (default), 1 = sRGB
    //   51108 ProfileLookTableEncoding (LONG)        same
    //
    // Vendor RAWs (CR2, ARW, RW2, NEF, …) don't ship a DCP profile so all
    // four reads return None; the per-pixel apply step falls through cleanly.
    let (hsm_data, plt) = read_hsm_plt(&root_ifd);

    // ── 9a. ProfileToneCurve (DNG § 6.4.4, tag 50940) ─────────────────────
    // 1D tone curve in profile working space. Apple iPhone DNGs ship one
    // (514 floats = 257 input/output pairs, identity-passed for sRGB-like
    // tone). Most vendor RAWs and many DNGs omit it.
    let profile_tone_curve = root_ifd
        .as_ref()
        .and_then(|ifd| read_floats(ifd.as_ref(), DngTag::ProfileToneCurve))
        .and_then(crate::color::profile_tone_curve::ProfileToneCurve::from_floats);

    // ── 9b. ProfileGainTableMap (DNG § 6.8, tag 52525) ────────────────────
    // Spatially-varying RGB gain map. Apple iPhone DNGs put it in a SubIFD
    // (per DNG 1.6 spec; the spec was "corrected" in DNG 1.7 docs to say
    // IFD0, but real Apple DNGs follow the original 1.6 placement). We
    // walk SubIFDs via the dng_ifd_walker recursively to find it.
    let profile_gain_table_map = root_ifd.as_ref().and_then(|ifd_rc| {
        let ifd = ifd_rc.as_ref();
        let endian_le = matches!(ifd.endian, rawler::bits::Endian::Little);
        crate::dng_ifd_walker::find_entry_recursive(
            ifd,
            DngTag::ProfileGainTableMap,
            crate::dng_ifd_walker::DEFAULT_MAX_DEPTH,
        )
        .and_then(|entry| {
            // PGTM is stored as Undefined (TIFF type 7) — raw bytes blob.
            // Try both Undefined and any other byte-shaped variant via
            // get_data, which returns the underlying byte buffer for both.
            let bytes: &[u8] = match &entry.value {
                rawler::formats::tiff::Value::Undefined(v) => v.as_slice(),
                rawler::formats::tiff::Value::Byte(v) => v.as_slice(),
                _ => return None,
            };
            crate::color::profile_gain_table_map::ProfileGainTableMap::from_bytes(bytes, endian_le)
        })
    });

    // ── 10. Default-crop rectangle (DNG § 6.3 DefaultCropOrigin/Size) ────
    // Rawler's `crop_area` is consistently populated for DNG / CR2 / CR3 /
    // ARW / NEF / RAF / ORF / RW2 from either the camera-table per-body
    // crop or the DNG tags themselves (see rawler/src/decoders/dng.rs:248).
    // Prefer it as the primary source. Fall back to reading DNG tags
    // directly only when rawler returns None — covers the rare malformed-
    // metadata case.
    //
    // Coordinates are sensor-absolute. The pipeline applies the crop
    // post-demosaic and (for half-res Preview) halves the rect at
    // apply-time, so we don't even-align here.
    //
    // test_0002 (DNG without crop tags), test_0013 (iPhone DNG, ditto),
    // test_0016 (X3F that rawler can't decode) hit the None path. The
    // pipeline treats None as "no crop" — full-sensor render, matches
    // ACR's behaviour on these fixtures.
    let crop_rect: Option<CropRect> = raw
        .crop_area
        .and_then(|r| {
            CropRect::clamped(
                r.p.x as u32,
                r.p.y as u32,
                r.d.w as u32,
                r.d.h as u32,
                width,
                height,
            )
        })
        .or_else(|| {
            // Fallback: read DNG tags directly. Rawler already does this
            // for DNG sources (`get_crop` in decoders/dng.rs), so this
            // path is hit only when the source claims to be a DNG but
            // rawler routed it to a non-DNG decoder that doesn't know
            // about `DefaultCrop*` (vanishingly rare in practice — none
            // of the slice-1 fixtures hit it). Kept as belt-and-braces.
            let ifd = root_ifd.as_ref()?;
            let origin = ifd.get_entry(DngTag::DefaultCropOrigin)?;
            let size = ifd.get_entry(DngTag::DefaultCropSize)?;
            if origin.value.count() < 2 || size.value.count() < 2 {
                return None;
            }
            let x = origin.value.force_f32(0).round() as u32;
            let y = origin.value.force_f32(1).round() as u32;
            let w = size.value.force_f32(0).round() as u32;
            let h = size.value.force_f32(1).round() as u32;
            CropRect::clamped(x, y, w, h, width, height)
        });

    let opcode_list3 = crate::pipeline::pano::opcodes::read_opcode_list3(bytes, ext, width, height);

    // Assemble first with a placeholder BE, then resolve the bundled-profile
    // contribution against the fully-populated RawImage (§ 1b compose chain).
    // `lookup_profile` gates on `raw.plt`, `raw.color_matrices`, and the
    // bundle's matrix-match check — so it must see the final struct, not a
    // partial. Cheap: BE is a single f32 mutation post-construction.
    let mut image = RawImage {
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
        unique_camera_model,
        color_matrices,
        forward_matrices,
        orientation,
        baseline_exposure: 0.0,
        hsm_data,
        plt,
        profile_tone_curve,
        profile_gain_table_map,
        crop_rect,
        iso,
        noise_profile,
        opcode_list3,
    };
    let be_from_bundle = if be_override.is_none() {
        crate::color::profile_loader::lookup_profile(&image)
            .map(|p| p.baseline_exposure_offset)
            .unwrap_or(0.0)
    } else {
        0.0
    };
    image.baseline_exposure = compose_baseline_exposure(be_from_tags, be_from_bundle, be_override);
    Ok(image)
}

/// Compose the final `RawImage.baseline_exposure` from its three sources.
///
/// * `be_from_tags` — the sum of DNG `BaselineExposure` (50730) and
///   `BaselineExposureOffset` (51109) on the source IFD.
/// * `be_from_bundle` — the `baseline_exposure_offset` field on the
///   matched bundled DCP profile, or 0.0 when there is no bundle match.
/// * `be_override` — escape hatch for diagnostics; when `Some(ev)` the
///   composition collapses to that value (no tags, no bundle).
///
/// Extracted as a pure function so the additive contract (#370) is unit-
/// testable without going through DNG decode.
fn compose_baseline_exposure(
    be_from_tags: f32,
    be_from_bundle: f32,
    be_override: Option<f32>,
) -> f32 {
    match be_override {
        Some(ev) => ev,
        None => be_from_tags + be_from_bundle,
    }
}

/// Read ProfileHueSatMap1/2 + ProfileLookTable from a DNG Root IFD.
/// Returns `(hsm_map, plt)`.
///
/// `hsm_map` is keyed by the matching `CalibrationIlluminant1` /
/// `CalibrationIlluminant2` so each HSM stays paired with its calibration
/// matrix even when a DNG lists `CalibrationIlluminant1` warmer than
/// `CalibrationIlluminant2` (non-spec but in the wild). Parallels the
/// `forward_matrices` decoder above. Empty when the tags are absent or
/// malformed; bail to (empty, None) on `ifd == None` (vendor RAW path).
fn read_hsm_plt(
    root_ifd: &Option<std::rc::Rc<rawler::formats::tiff::IFD>>,
) -> (
    HashMap<CoreIlluminant, crate::color::hsm::HsmTable>,
    Option<crate::color::hsm::HsmTable>,
) {
    let mut hsm_map: HashMap<CoreIlluminant, crate::color::hsm::HsmTable> = HashMap::new();
    let ifd = match root_ifd.as_ref() {
        Some(i) => i.as_ref(),
        None => return (hsm_map, None),
    };
    let hsm_dims = read_dims(ifd, DngTag::ProfileHueSatMapDims);
    let hsm_enc = read_encoding(ifd, DngTag::ProfileHueSatMapEncoding);
    // Pair each HSM with its calibration illuminant. The matching illuminant
    // tag (CalibrationIlluminant1/2) sits alongside ColorMatrix1/2 — keying
    // by it here mirrors how `forward_matrices` is built above and lets the
    // DCP path look the right table up by `il_cold`/`il_warm` rather than
    // assuming `hsm_data1` is the cold side (which fails when the file's
    // illuminant ordering is reversed).
    let read_hsm = |hsm_tag: DngTag,
                    illum_tag: DngTag|
     -> Option<(CoreIlluminant, crate::color::hsm::HsmTable)> {
        let dims = hsm_dims?;
        let data = read_floats(ifd, hsm_tag)?;
        let table = crate::color::hsm::HsmTable::new(dims, data, hsm_enc)?;
        let illum_code = ifd.get_entry(illum_tag)?.value.force_u16(0);
        let illum = exif_illuminant_to_core(illum_code);
        Some((illum, table))
    };
    if let Some((illum, table)) = read_hsm(
        DngTag::ProfileHueSatMapData1,
        DngTag::CalibrationIlluminant1,
    ) {
        hsm_map.insert(illum, table);
    }
    if let Some((illum, table)) = read_hsm(
        DngTag::ProfileHueSatMapData2,
        DngTag::CalibrationIlluminant2,
    ) {
        // First-write-wins matches color_matrices semantics: if both HSMs
        // map to the same CoreIlluminant variant (shouldn't happen in
        // practice — DNGs ship distinct illuminants), keep illuminant 1's.
        hsm_map.entry(illum).or_insert(table);
    }

    let plt_dims = read_dims(ifd, DngTag::ProfileLookTableDims);
    let plt_enc = read_encoding(ifd, DngTag::ProfileLookTableEncoding);
    let plt = plt_dims.and_then(|dims| {
        read_floats(ifd, DngTag::ProfileLookTableData)
            .and_then(|data| crate::color::hsm::HsmTable::new(dims, data, plt_enc))
    });
    (hsm_map, plt)
}

/// Read a 3-tuple LONG dims tag. Returns `None` if absent or malformed.
fn read_dims(ifd: &rawler::formats::tiff::IFD, tag: DngTag) -> Option<[u32; 3]> {
    let entry = ifd.get_entry(tag)?;
    if entry.value.count() < 3 {
        return None;
    }
    let h = entry.value.force_u32(0);
    let s = entry.value.force_u32(1);
    let v = entry.value.force_u32(2);
    if h == 0 || s == 0 || v == 0 {
        return None;
    }
    Some([h, s, v])
}

/// Read a FLOAT array tag into `Vec<f32>`. Returns `None` if absent.
/// Coerces non-Float types via `force_f32` per index — fine for the small
/// per-tag arrays we deal with here.
fn read_floats(ifd: &rawler::formats::tiff::IFD, tag: DngTag) -> Option<Vec<f32>> {
    let entry = ifd.get_entry(tag)?;
    let n = entry.value.count();
    if n == 0 {
        return None;
    }
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        out.push(entry.value.force_f32(i));
    }
    Some(out)
}

/// Read a single LONG encoding tag (0 = Linear, 1 = sRGB). Defaults to
/// Linear per DNG 1.6 § 6.6.4 when absent.
fn read_encoding(ifd: &rawler::formats::tiff::IFD, tag: DngTag) -> crate::color::hsm::HsmEncoding {
    ifd.get_entry(tag)
        .map(|e| crate::color::hsm::HsmEncoding::from_u32(e.value.force_u32(0)))
        .unwrap_or(crate::color::hsm::HsmEncoding::Linear)
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

/// Map an EXIF/DNG `CalibrationIlluminant` u16 code to our `CoreIlluminant`.
/// Used to pair `ForwardMatrix1` / `ForwardMatrix2` with their illuminants
/// during DNG decode (rawler doesn't expose FM directly, so we read the
/// raw IFD entries).
///
/// Codes per EXIF 2.32 / DNG spec § 3.4:
/// 17 = Standard Light A, 21 = D65, 22 = D55, 23 = D50.
/// Anything else degrades to D65 (matches `rawler_illuminant_to_core`'s
/// fallback policy — keeps the dual-CM lerp path working when the DNG
/// uses an exotic illuminant code).
fn exif_illuminant_to_core(code: u16) -> CoreIlluminant {
    match code {
        17 => CoreIlluminant::StdA,
        21 => CoreIlluminant::D65,
        22 => CoreIlluminant::D55,
        23 => CoreIlluminant::D50,
        _ => CoreIlluminant::D65,
    }
}

/// Map a rawler CFA name string to our [`CfaPattern`] enum. Only handles
/// the 2×2 Bayer variants — used as a pure-string helper by tests.
fn map_cfa_pattern(name: &str) -> Result<CfaPattern> {
    match name {
        "RGGB" => Ok(CfaPattern::Rggb),
        "BGGR" => Ok(CfaPattern::Bggr),
        "GRBG" => Ok(CfaPattern::Grbg),
        "GBRG" => Ok(CfaPattern::Gbrg),
        other => Err(Error::UnsupportedCfa(other.to_string())),
    }
}

/// Map a rawler [`rawler::CFA`] to our [`CfaPattern`].
///
/// Handles the 4 classic 2×2 Bayer patterns plus 6×6 X-Trans (Fuji RAF).
/// rawler reports X-Trans via the `XTransLayout` metadata block as a
/// 36-character name; we read the pattern off the `cfa.pattern[6][6]`
/// upper-left tile (rawler stores it expanded to 48×48 internally so
/// indexing is safe) and pack it into the [`CfaPattern::XTrans`]
/// variant. Other exotic patterns (CYGM, RGBE, 2×8 / 12×12) return
/// [`Error::UnsupportedCfa`].
fn map_cfa_pattern_with_pattern(cfa: &rawler::CFA) -> Result<CfaPattern> {
    // 2×2 Bayer dispatch by name keeps the hand-rolled `color_at`
    // matches in `CfaPattern` taking the fast path on the common case.
    if cfa.width == 2 && cfa.height == 2 {
        return map_cfa_pattern(&cfa.name);
    }
    if cfa.width == 6 && cfa.height == 6 {
        // Validate that every cell is R/G/B (0/1/2). Anything else (the
        // `X` sentinel rawler writes on unknown XTransLayout entries)
        // is an unsupported variant — bail with a clear error.
        let mut pat = [0u8; 36];
        for row in 0..6 {
            for col in 0..6 {
                let v = cfa.color_at(row, col);
                if v > 2 {
                    return Err(Error::UnsupportedCfa(format!(
                        "X-Trans pattern contains unknown channel {} at ({}, {}): {:?}",
                        v, col, row, cfa.name
                    )));
                }
                pat[row * 6 + col] = v as u8;
            }
        }
        return Ok(CfaPattern::XTrans(pat));
    }
    Err(Error::UnsupportedCfa(cfa.name.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::fixtures::require_raw;

    /// Fixture-backed tests are `#[cfg_attr(not(feature = "fixtures"), ignore)]`:
    /// visibly ignored without the feature, fail-closed (panic on a missing
    /// fixture via [`require_raw`]) with it (#1082).

    /// Shell helper for tests only: read from disk, then delegate to
    /// [`decode_bytes`]. The core no longer exposes a path-based entrypoint —
    /// I/O is the shell's responsibility (spec §02).
    fn decode_path(path: &std::path::Path) -> Result<RawImage> {
        let bytes = std::fs::read(path).map_err(|e| Error::Io {
            path: path.to_path_buf(),
            source: e,
        })?;
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        decode_bytes(&bytes, ext)
    }

    /// Regression test for #1087 — malformed files declaring degenerate
    /// dimensions must fail decode with a structured `Error::Decode`, never
    /// panic. Pre-fix, all three of these synthetic DNGs decoded `Ok` and
    /// the zero/one-px dimension propagated into the pipeline:
    /// `sensor_linearize` feeds the width into `par_chunks_mut`, which
    /// panics on a chunk size of zero, and `demosaic::half_res` halves
    /// each axis first, so even a 1-px-wide input dies the same way.
    #[test]
    fn decode_rejects_degenerate_dimensions() {
        use crate::test_support::synth_dng::SyntheticGreyDng;
        for (w, h) in [(8u32, 0u32), (1, 8), (8, 1)] {
            let dng = SyntheticGreyDng {
                width: w,
                height: h,
                ..Default::default()
            };
            let bytes = dng.write_to_bytes();
            let err = match decode_bytes(&bytes, "dng") {
                Err(e) => e,
                Ok(raw) => panic!(
                    "a {}×{} DNG must fail decode, got Ok({}×{})",
                    w, h, raw.width, raw.height
                ),
            };
            match err {
                Error::Decode { reason, .. } => assert!(
                    reason.contains("invalid sensor dimensions"),
                    "unexpected decode-error reason for {}×{}: {}",
                    w,
                    h,
                    reason
                ),
                other => panic!("expected Error::Decode for {}×{}, got {:?}", w, h, other),
            }
        }

        // Zero-*width*: rawler's own uncompressed-strip reader trips first
        // on the synthetic container (it catches an internal panic and
        // surfaces a decode error), so raw-core's validation never sees the
        // dimensions on this path. The contract still holds either way:
        // a structured error, not a process abort. Kept here so the full
        // zero/one-px matrix is pinned against rawler upgrades — if a
        // future rawler starts log-and-continuing on this path too, this
        // case falls through to the same `width < 2` guard as the rest.
        let dng = SyntheticGreyDng {
            width: 0,
            height: 8,
            ..Default::default()
        };
        assert!(
            decode_bytes(&dng.write_to_bytes(), "dng").is_err(),
            "a 0×8 DNG must fail decode with an error"
        );
    }

    #[test]
    #[cfg_attr(not(feature = "fixtures"), ignore)]
    fn decode_test_0002_reports_plausible_dimensions() {
        let path = require_raw("test_0002.dng");
        let raw = decode_path(&path).expect("decode DNG");
        assert!(raw.width >= 1024, "suspiciously narrow: {}", raw.width);
        assert!(raw.height >= 1024, "suspiciously short: {}", raw.height);
        assert_eq!(
            raw.raw_data.len(),
            (raw.width as usize) * (raw.height as usize)
        );
        assert!(raw.white_level > 0);
        assert!(matches!(
            raw.cfa,
            CfaPattern::Rggb | CfaPattern::Bggr | CfaPattern::Grbg | CfaPattern::Gbrg
        ));
    }

    #[test]
    #[cfg_attr(not(feature = "fixtures"), ignore)]
    fn decode_test_0003_canon_cr2() {
        let path = require_raw("test_0003.CR2");
        let raw = decode_path(&path).expect("decode CR2");
        assert!(raw.width > 0 && raw.height > 0);
        assert_eq!(raw.camera_make.to_lowercase(), "canon");
    }

    #[test]
    #[cfg_attr(not(feature = "fixtures"), ignore)]
    fn decode_test_0001_hasselblad_3fr() {
        let path = require_raw("test_0001.RAW");
        let raw = decode_path(&path).expect("decode 3FR");
        assert!(raw.width > 0 && raw.height > 0);
    }

    #[test]
    #[cfg_attr(not(feature = "fixtures"), ignore)]
    fn decode_test_0000_hasselblad_100mp() {
        let path = require_raw("test_0000.DNG");
        let raw = decode_path(&path).expect("decode 100MP DNG");
        assert!(raw.width > 8000, "100MP expected, got {} wide", raw.width);
    }

    /// Regression test for BaselineExposure reading (DNG § C.1.2, tag 50730).
    /// test_0000.DNG carries BaselineExposure = 1.01 EV in metadata.
    #[test]
    #[cfg_attr(not(feature = "fixtures"), ignore)]
    fn decode_test_0000_reads_baseline_exposure() {
        let path = require_raw("test_0000.DNG");
        let raw = decode_path(&path).expect("decode Hasselblad DNG");
        assert!(
            (raw.baseline_exposure - 1.01).abs() < 0.01,
            "expected BaselineExposure ≈ 1.01 EV, got {:.4}",
            raw.baseline_exposure
        );
    }

    /// Regression test for #370 — the bundled-DCP `baseline_exposure_offset`
    /// field must add into the final `RawImage.baseline_exposure` on top of
    /// the DNG tags. Covers three cases via the pure `compose_baseline_exposure`
    /// helper, which is what `decode_bytes` calls at the bottom of the
    /// BE composition chain.
    #[test]
    fn compose_baseline_exposure_adds_bundle_offset_to_tags() {
        // Tags = 1.0 EV, bundle = +0.5 EV → 1.5 EV. Demonstrates that the
        // bundled offset is additive on top of the DNG tags, which is the
        // contract that replaces the deleted per-body BE table from #370.
        assert!((compose_baseline_exposure(1.0, 0.5, None) - 1.5).abs() < 1e-6);
    }

    #[test]
    fn compose_baseline_exposure_override_wins_over_tags_and_bundle() {
        // Override is the diagnostic escape hatch; when set it ignores
        // both tags and bundle. (Used by the `MAPLE_BE_OVERRIDE` env var
        // pipeline path, see decode.rs § 1b.)
        assert!((compose_baseline_exposure(1.0, 0.5, Some(0.3)) - 0.3).abs() < 1e-6);
    }

    #[test]
    fn compose_baseline_exposure_zero_when_both_absent() {
        // No tags, no bundle, no override — stays at 0.0. This is the
        // "no BE adjustment anywhere" baseline.
        assert_eq!(compose_baseline_exposure(0.0, 0.0, None), 0.0);
    }

    /// Regression test for fix #4 (EXIF orientation): test_0003.CR2 was shot
    /// in portrait, so its EXIF orientation tag must be a non-Normal value.
    #[test]
    #[cfg_attr(not(feature = "fixtures"), ignore)]
    fn decode_test_0003_reports_exif_orientation() {
        let path = require_raw("test_0003.CR2");
        let raw = decode_path(&path).expect("decode CR2");
        assert_ne!(
            raw.orientation,
            ExifOrientation::Normal,
            "expected a non-Normal EXIF orientation for portrait CR2; got {:?}",
            raw.orientation
        );
    }

    /// Verify decode_bytes works on Canon CR2 format via extension hint.
    #[test]
    #[cfg_attr(not(feature = "fixtures"), ignore)]
    fn decode_bytes_works_on_cr2() {
        let path = require_raw("test_0003.CR2");
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

    /// Regression test for HSM tag reading (DNG § 6.6 / Ticket 10c).
    /// test_0000.DNG (Hasselblad 100 MP) ships ProfileHueSatMapData1 +
    /// ProfileHueSatMapData2 with dims [36, 10, 1] (per `exiftool`). After
    /// decode, `hsm_data` must carry two entries (one per calibration
    /// illuminant), the dims must match, and the data length must be
    /// 36 × 10 × 1 × 3 = 1080 floats per illuminant.
    #[test]
    #[cfg_attr(not(feature = "fixtures"), ignore)]
    fn decode_test_0000_reads_dual_illuminant_hsm() {
        let path = require_raw("test_0000.DNG");
        let raw = decode_path(&path).expect("decode Hasselblad DNG");
        assert_eq!(raw.hsm_data.len(), 2, "test_0000 ships both HSM tables");
        for (illum, table) in &raw.hsm_data {
            assert_eq!(
                table.dims,
                [36, 10, 1],
                "{:?} expected DNG-typical [36,10,1]",
                illum
            );
            assert_eq!(table.data.len(), 36 * 10 * 1 * 3);
        }
        // Both calibration illuminants must be represented (test_0000 ships
        // StdA + D65 per spec convention; either order is acceptable, but
        // the two illuminants must differ).
        assert_eq!(
            raw.hsm_data.keys().count(),
            2,
            "two distinct illuminants required for dual-HSM lerp"
        );
        // No PLT in this fixture.
        assert!(raw.plt.is_none(), "test_0000 has no PLT");
    }

    /// Regression test for PLT tag reading. test_0017.dng (Leica M10) ships a
    /// tiny 3 × 2 × 1 PLT with all-zero hueDeltas and unit sat/val scales —
    /// effectively a no-op identity table.
    #[test]
    #[cfg_attr(not(feature = "fixtures"), ignore)]
    fn decode_test_0017_reads_plt() {
        let path = require_raw("test_0017.dng");
        let raw = decode_path(&path).expect("decode Leica DNG");
        let plt = raw.plt.as_ref().expect("test_0017 ships a PLT");
        assert_eq!(plt.dims, [3, 2, 1], "expected Leica's [3,2,1] no-op shape");
        assert_eq!(plt.data.len(), 3 * 2 * 1 * 3);
    }

    /// Vendor RAW (CR2 / ARW / NEF / RAF / X3F) never carry a DCP — confirm
    /// the decoder cleanly reports `None` for all HSM/PLT tables. test_0010
    /// is a Canon CR2.
    #[test]
    #[cfg_attr(not(feature = "fixtures"), ignore)]
    fn decode_vendor_raw_yields_no_hsm_or_plt() {
        let path = require_raw("test_0010.CR2");
        let raw = decode_path(&path).expect("decode CR2");
        assert!(raw.hsm_data.is_empty(), "CR2 should not carry HSM");
        assert!(raw.plt.is_none(), "CR2 should not carry PLT");
        assert!(raw.profile_tone_curve.is_none(), "CR2 should not carry PTC");
        assert!(
            raw.profile_gain_table_map.is_none(),
            "CR2 should not carry PGTM"
        );
    }

    /// Regression test for ProfileToneCurve reading on the iPhone 12 Pro
    /// fixture (test_0013.DNG). Apple writes a 257-pair PTC in IFD0; we
    /// must surface it on `RawImage.profile_tone_curve` so the apply stage
    /// can run.
    #[test]
    #[cfg_attr(not(feature = "fixtures"), ignore)]
    fn decode_test_0013_reads_profile_tone_curve() {
        let path = require_raw("test_0013.DNG");
        let raw = decode_path(&path).expect("decode iPhone DNG");
        let curve = raw
            .profile_tone_curve
            .as_ref()
            .expect("test_0013 ships a ProfileToneCurve");
        assert_eq!(
            curve.points.len(),
            257,
            "expected 257-pair Apple PTC, got {}",
            curve.points.len()
        );
        // First pair should be (0.0, 0.0) per spec — curves typically start
        // at the origin. Last pair input close to 1.0.
        assert!((curve.points[0].0 - 0.0).abs() < 1e-3);
        assert!((curve.points[256].0 - 1.0).abs() < 1e-3);
    }

    /// Regression test for the SubIFD walker hookup: test_0013.DNG carries
    /// ProfileGainTableMap inside SubIFDs (tag 330). The strict parser
    /// rejects MapPlanes != 1|3, so for the Apple-extended PGTM the field
    /// stays None — but the walker MUST find the tag (we verify via
    /// dng_ifd_walker independently in [`crate::dng_ifd_walker`] tests).
    /// This test pins the user-visible field to the parser's expected
    /// behaviour: None for the canonical-spec case here means we found
    /// the tag, recognised the non-canonical layout, and bailed safely
    /// rather than corrupting downstream pixels.
    #[test]
    #[cfg_attr(not(feature = "fixtures"), ignore)]
    fn decode_test_0013_pgtm_recognises_apple_extended_layout() {
        let path = require_raw("test_0013.DNG");
        let raw = decode_path(&path).expect("decode iPhone DNG");
        // Apple's PGTM has MapPlanes=257 (a DNG 1.7 extension); strict
        // parser yields None to avoid mis-applying it.
        assert!(
            raw.profile_gain_table_map.is_none(),
            "Apple iPhone PGTM uses non-canonical MapPlanes=257; \
             strict parser must skip rather than corrupt"
        );
    }

    /// Regression test for #417: Fuji RAF decodes to `CfaPattern::XTrans`
    /// with rawler's per-body XTransLayout populated into the 36-cell
    /// pattern. test_0008 is a Fujifilm X-T3 RAF. The decoded pattern
    /// must have the canonical R/G/B count for a 6×6 X-Trans tile:
    /// 8 R, 20 G, 8 B per 36 cells.
    #[test]
    #[cfg_attr(not(feature = "fixtures"), ignore)]
    fn decode_test_0008_xtrans_pattern_has_canonical_channel_counts() {
        let path = require_raw("test_0008.RAF");
        let raw = decode_path(&path).expect("decode Fuji RAF");
        let pattern = match raw.cfa {
            CfaPattern::XTrans(p) => p,
            other => panic!("expected XTrans, got {:?}", other),
        };
        let mut counts = [0usize; 3];
        for &c in &pattern {
            assert!(c <= 2, "channel index out of range: {}", c);
            counts[c as usize] += 1;
        }
        // X-Trans canonical per-tile distribution.
        assert_eq!(
            counts,
            [8, 20, 8],
            "expected [R=8, G=20, B=8], got {:?} (pattern: {:?})",
            counts,
            pattern
        );
        assert_eq!(raw.camera_make.to_lowercase(), "fujifilm");
        // RAF dimensions should be plausible (X-T3 is 6240×4160 raw).
        assert!(
            raw.width >= 4000 && raw.height >= 4000,
            "RAF dimensions look wrong: {}x{}",
            raw.width,
            raw.height
        );
    }

    /// Regression test for #417: Foveon X3F surfaces as the structured
    /// `UnsupportedFormat` error variant (not a generic `Decode` error).
    /// rawler 0.7's X3F decoder is a stub.
    #[test]
    #[cfg_attr(not(feature = "fixtures"), ignore)]
    fn decode_test_0016_foveon_x3f_returns_unsupported_format() {
        let path = require_raw("test_0016.X3F");
        let err = decode_path(&path).expect_err("X3F decoding must error");
        match err {
            Error::UnsupportedFormat(msg) => {
                assert!(
                    msg.to_lowercase().contains("foveon") || msg.to_lowercase().contains("x3f"),
                    "expected Foveon/X3F mention, got: {}",
                    msg
                );
            }
            other => panic!("expected Error::UnsupportedFormat, got {:?}", other),
        }
    }

    /// Foveon detection works even if the caller passes a non-`x3f` extension
    /// (e.g. byte stream from a tool that lost the extension hint). The
    /// promotion path inside `decode_bytes` catches rawler's
    /// "X3F decoding not implemented" diagnostic.
    #[test]
    #[cfg_attr(not(feature = "fixtures"), ignore)]
    fn decode_foveon_promotes_decoder_error_to_unsupported_format() {
        let path = require_raw("test_0016.X3F");
        let bytes = std::fs::read(&path).expect("read X3F bytes");
        // Pass `raw` (a generic vendor extension) — the `x3f` short-circuit
        // is skipped and we exercise the message-promotion arm.
        let err = decode_bytes(&bytes, "raw").expect_err("X3F bytes must error");
        match err {
            Error::UnsupportedFormat(_) => {}
            // Some rawler builds may refuse to even identify X3F via the
            // wrong extension hint — that's still a structured Decode error,
            // not a panic, which is the minimum bar this test enforces.
            Error::Decode { .. } => {}
            other => panic!("expected UnsupportedFormat or Decode, got {:?}", other),
        }
    }

    /// Regression test for ticket #07: LinearRaw DNGs (PhotometricInterpretation
    /// = 34892) decode with `CfaPattern::LinearRgb` and a `raw_data` buffer
    /// of length 3 × w × h (interleaved RGB, not mosaic).
    #[test]
    #[cfg_attr(not(feature = "fixtures"), ignore)]
    fn decode_test_0006_linearraw_uses_linearrgb_cfa() {
        let path = require_raw("test_0006.DNG");
        let raw = decode_path(&path).expect("decode LinearRaw DNG");
        assert_eq!(
            raw.cfa,
            CfaPattern::LinearRgb,
            "test_0006 is a LinearRaw DNG; cfa must be LinearRgb"
        );
        assert_eq!(
            raw.raw_data.len(),
            3 * raw.width as usize * raw.height as usize,
            "LinearRaw raw_data must be interleaved RGB (3 × w × h)"
        );
    }
}
