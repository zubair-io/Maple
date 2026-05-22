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
    // BaselineExposure for the asset: DNG tag if present, else the
    // per-camera camconst lookup. No additional global compensation is
    // applied here. An earlier `MAPLE_AGX_BASELINE_COMPENSATION_EV =
    // 0.65` constant was added (commit da1ad87) to match ACR's brightness
    // at default sliders. That was the wrong target: Maple uses AgX as
    // the platform view transform; ACR uses Adobe's proprietary tone
    // curve. They will not produce identical images by design, and
    // pushing AgX brightness toward ACR via a global EV bump fights the
    // view-transform's intended look. The constant is removed; if the
    // AgX shape itself needs work, retune the Y_PIVOT / matrix
    // compression / sigmoid powers in src/scripts/derive_agx_lut.py
    // against canonical Sobotka AgX (#263 — see view::agx_coeffs).
    // BaselineExposure resolution:
    //
    //   MAPLE_BE_OVERRIDE (env, dev-only) → absolute override
    //                                       OR
    //   (DNG BaselineExposure tag) + (DNG BaselineExposureOffset tag)
    //     + (camera_calibration::baseline_exposure lookup, additive)
    //
    // Each tag/lookup contributes 0.0 when absent. The per-body lookup is
    // ADDITIVE on top of the DNG-supplied value — lets us fine-tune bodies
    // whose embedded BaselineExposure undershoots ACR's brightness on this
    // body (e.g. Hasselblad H2D-39, tag=0, needs +0.3 lift). For vendor RAW
    // formats (CR2/ARW/RAF/NEF/X3F/fff/RAW) the tags are absent and the
    // lookup is the sole source — same as Phase 1.1. The lookup returns
    // 0.0 for unknown bodies so adding an entry never breaks anything that
    // wasn't there.
    //
    // MAPLE_BE_OVERRIDE is only used by tools/calibration/derive_baseline_
    // exposure.py to sweep absolute BE values during calibration; production
    // never sets it.
    let baseline_exposure = match std::env::var("MAPLE_BE_OVERRIDE")
        .ok()
        .and_then(|s| s.parse::<f32>().ok())
    {
        Some(ev) => ev,
        None => {
            let from_tags = baseline_tag.unwrap_or(0.0) + offset_tag.unwrap_or(0.0);
            let from_lookup = crate::camera_calibration::baseline_exposure(
                &raw.clean_make, &raw.clean_model,
            );
            from_tags + from_lookup
        }
    };

    // ── 2. CFA pattern ────────────────────────────────────────────────────
    let cfa = match &raw.photometric {
        RawPhotometricInterpretation::Cfa(cfg) => {
            map_cfa_pattern(&cfg.cfa.name)?
        }
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
            let read_fm = |fm_tag: DngTag, illum_tag: DngTag| -> Option<(CoreIlluminant, Matrix3)> {
                let floats = read_floats(ifd.as_ref(), fm_tag)?;
                if floats.len() < 9 { return None; }
                let m = Matrix3([
                    [floats[0], floats[1], floats[2]],
                    [floats[3], floats[4], floats[5]],
                    [floats[6], floats[7], floats[8]],
                ]);
                let illum_code = ifd.as_ref().get_entry(illum_tag)?.value.force_u16(0);
                let illum = exif_illuminant_to_core(illum_code);
                Some((illum, m))
            };
            if let Some((illum, m)) = read_fm(DngTag::ForwardMatrix1, DngTag::CalibrationIlluminant1) {
                map.insert(illum, m);
            }
            if let Some((illum, m)) = read_fm(DngTag::ForwardMatrix2, DngTag::CalibrationIlluminant2) {
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
    let (hsm_data1, hsm_data2, plt) = read_hsm_plt(&root_ifd);

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
            crate::color::profile_gain_table_map::ProfileGainTableMap::from_bytes(
                bytes,
                endian_le,
            )
        })
    });

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
        forward_matrices,
        orientation,
        baseline_exposure,
        hsm_data1,
        hsm_data2,
        plt,
        profile_tone_curve,
        profile_gain_table_map,
    })
}

/// Read ProfileHueSatMap1/2 + ProfileLookTable from a DNG Root IFD.
/// Returns `(hsm1, hsm2, plt)` — each `None` when the tag is absent or
/// malformed. All four bail to `None` on `ifd == None` (vendor RAW path).
fn read_hsm_plt(
    root_ifd: &Option<std::rc::Rc<rawler::formats::tiff::IFD>>,
) -> (
    Option<crate::color::hsm::HsmTable>,
    Option<crate::color::hsm::HsmTable>,
    Option<crate::color::hsm::HsmTable>,
) {
    let ifd = match root_ifd.as_ref() {
        Some(i) => i.as_ref(),
        None => return (None, None, None),
    };
    let hsm_dims = read_dims(ifd, DngTag::ProfileHueSatMapDims);
    let hsm_enc = read_encoding(ifd, DngTag::ProfileHueSatMapEncoding);
    let hsm1 = hsm_dims.and_then(|dims| {
        read_floats(ifd, DngTag::ProfileHueSatMapData1)
            .and_then(|data| crate::color::hsm::HsmTable::new(dims, data, hsm_enc))
    });
    let hsm2 = hsm_dims.and_then(|dims| {
        read_floats(ifd, DngTag::ProfileHueSatMapData2)
            .and_then(|data| crate::color::hsm::HsmTable::new(dims, data, hsm_enc))
    });

    let plt_dims = read_dims(ifd, DngTag::ProfileLookTableDims);
    let plt_enc = read_encoding(ifd, DngTag::ProfileLookTableEncoding);
    let plt = plt_dims.and_then(|dims| {
        read_floats(ifd, DngTag::ProfileLookTableData)
            .and_then(|data| crate::color::hsm::HsmTable::new(dims, data, plt_enc))
    });
    (hsm1, hsm2, plt)
}

/// Read a 3-tuple LONG dims tag. Returns `None` if absent or malformed.
fn read_dims(ifd: &rawler::formats::tiff::IFD, tag: DngTag) -> Option<[u32; 3]> {
    let entry = ifd.get_entry(tag)?;
    if entry.value.count() < 3 { return None; }
    let h = entry.value.force_u32(0);
    let s = entry.value.force_u32(1);
    let v = entry.value.force_u32(2);
    if h == 0 || s == 0 || v == 0 { return None; }
    Some([h, s, v])
}

/// Read a FLOAT array tag into `Vec<f32>`. Returns `None` if absent.
/// Coerces non-Float types via `force_f32` per index — fine for the small
/// per-tag arrays we deal with here.
fn read_floats(ifd: &rawler::formats::tiff::IFD, tag: DngTag) -> Option<Vec<f32>> {
    let entry = ifd.get_entry(tag)?;
    let n = entry.value.count();
    if n == 0 { return None; }
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
        _  => CoreIlluminant::D65,
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
    /// test_0000.DNG carries BaselineExposure = 1.01 EV in metadata.
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

    /// Regression test for HSM tag reading (DNG § 6.6 / Ticket 10c).
    /// test_0000.DNG (Hasselblad 100 MP) ships ProfileHueSatMapData1 +
    /// ProfileHueSatMapData2 with dims [36, 10, 1] (per `exiftool`). After
    /// decode, both `hsm_data1` and `hsm_data2` must be `Some(_)`, the
    /// dims must match, and the data length must be 36 × 10 × 1 × 3 = 1080
    /// floats per illuminant.
    #[test]
    fn decode_test_0000_reads_dual_illuminant_hsm() {
        let path = fixture_root().join("test_0000.DNG");
        if !path.exists() { return; }
        let raw = decode_path(&path).expect("decode Hasselblad DNG");
        let h1 = raw.hsm_data1.as_ref().expect("test_0000 ships HSM data 1");
        let h2 = raw.hsm_data2.as_ref().expect("test_0000 ships HSM data 2");
        assert_eq!(h1.dims, [36, 10, 1], "expected DNG-typical [36,10,1]");
        assert_eq!(h2.dims, [36, 10, 1]);
        assert_eq!(h1.data.len(), 36 * 10 * 1 * 3);
        assert_eq!(h2.data.len(), 36 * 10 * 1 * 3);
        // No PLT in this fixture.
        assert!(raw.plt.is_none(), "test_0000 has no PLT");
    }

    /// Regression test for PLT tag reading. test_0017.dng (Leica M10) ships a
    /// tiny 3 × 2 × 1 PLT with all-zero hueDeltas and unit sat/val scales —
    /// effectively a no-op identity table.
    #[test]
    fn decode_test_0017_reads_plt() {
        let path = fixture_root().join("test_0017.dng");
        if !path.exists() { return; }
        let raw = decode_path(&path).expect("decode Leica DNG");
        let plt = raw.plt.as_ref().expect("test_0017 ships a PLT");
        assert_eq!(plt.dims, [3, 2, 1], "expected Leica's [3,2,1] no-op shape");
        assert_eq!(plt.data.len(), 3 * 2 * 1 * 3);
    }

    /// Vendor RAW (CR2 / ARW / NEF / RAF / X3F) never carry a DCP — confirm
    /// the decoder cleanly reports `None` for all HSM/PLT tables. test_0010
    /// is a Canon CR2.
    #[test]
    fn decode_vendor_raw_yields_no_hsm_or_plt() {
        let path = fixture_root().join("test_0010.CR2");
        if !path.exists() { return; }
        let raw = decode_path(&path).expect("decode CR2");
        assert!(raw.hsm_data1.is_none(), "CR2 should not carry HSM");
        assert!(raw.hsm_data2.is_none(), "CR2 should not carry HSM");
        assert!(raw.plt.is_none(), "CR2 should not carry PLT");
        assert!(raw.profile_tone_curve.is_none(), "CR2 should not carry PTC");
        assert!(raw.profile_gain_table_map.is_none(), "CR2 should not carry PGTM");
    }

    /// Regression test for ProfileToneCurve reading on the iPhone 12 Pro
    /// fixture (test_0013.DNG). Apple writes a 257-pair PTC in IFD0; we
    /// must surface it on `RawImage.profile_tone_curve` so the apply stage
    /// can run.
    #[test]
    fn decode_test_0013_reads_profile_tone_curve() {
        let path = fixture_root().join("test_0013.DNG");
        if !path.exists() { return; }
        let raw = decode_path(&path).expect("decode iPhone DNG");
        let curve = raw.profile_tone_curve.as_ref()
            .expect("test_0013 ships a ProfileToneCurve");
        assert_eq!(curve.points.len(), 257,
            "expected 257-pair Apple PTC, got {}", curve.points.len());
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
    fn decode_test_0013_pgtm_recognises_apple_extended_layout() {
        let path = fixture_root().join("test_0013.DNG");
        if !path.exists() { return; }
        let raw = decode_path(&path).expect("decode iPhone DNG");
        // Apple's PGTM has MapPlanes=257 (a DNG 1.7 extension); strict
        // parser yields None to avoid mis-applying it.
        assert!(raw.profile_gain_table_map.is_none(),
            "Apple iPhone PGTM uses non-canonical MapPlanes=257; \
             strict parser must skip rather than corrupt");
    }

    /// Regression test for ticket #07: LinearRaw DNGs (PhotometricInterpretation
    /// = 34892) decode with `CfaPattern::LinearRgb` and a `raw_data` buffer
    /// of length 3 × w × h (interleaved RGB, not mosaic).
    #[test]
    fn decode_test_0006_linearraw_uses_linearrgb_cfa() {
        let path = fixture_root().join("test_0006.DNG");
        if !path.exists() { return; }
        let raw = decode_path(&path).expect("decode LinearRaw DNG");
        assert_eq!(raw.cfa, CfaPattern::LinearRgb,
            "test_0006 is a LinearRaw DNG; cfa must be LinearRgb");
        assert_eq!(raw.raw_data.len(), 3 * raw.width as usize * raw.height as usize,
            "LinearRaw raw_data must be interleaved RGB (3 × w × h)");
    }
}
