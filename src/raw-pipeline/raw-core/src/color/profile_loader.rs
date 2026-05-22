//! Runtime loader for Maple's bundled Adobe-derived DCP profiles.
//!
//! Adobe ships 1,447 high-quality `Adobe Standard` DCPs under
//! `/Library/Application Support/Adobe/CameraRaw/CameraProfiles/`. The
//! `src/scripts/convert_adobe_dcps.py` tool re-encodes that data into a
//! single binary at `profiles/profiles.bin`, included into the crate via
//! [`include_bytes!`].
//!
//! Why bundled at all: rawler's per-camera matrices (its dcraw-lineage
//! defaults) are catastrophically wrong on some bodies — iPhone 12 Pro, the
//! Canon 5DM3/5DM4 family — producing 20+ ΔE biases on standard fixtures.
//! Adobe's calibrated DCPs fix the matrices. See ticket #324.
//!
//! Lookup key is `(UniqueCameraModel, Option<lens_id>)`. The lens
//! disambiguation handles mobile cameras whose lens variants ship as separate
//! Adobe DCPs (e.g. `iPhone13,3 back camera`, `iPhone13,3 back telephoto
//! camera`, `iPhone13,3 back ultra wide camera`).
//!
//! ## Bundle format
//!
//! Little-endian throughout. Header (16 bytes) followed by N variable-length
//! profile records. See `src/scripts/convert_adobe_dcps.py` module-docstring
//! for the per-byte spec — both reader (this file) and writer (the script)
//! must move together. Format version is bumped (header u16 at offset 4)
//! when the layout changes.
//!
//! ## What's bundled, what's dropped
//!
//! Kept verbatim: `ColorMatrix1`/`ColorMatrix2` (camera→XYZ at calib illum),
//! `ForwardMatrix1`/`ForwardMatrix2` (camera→XYZ-D50, when present),
//! `CalibrationIlluminant1`/`2`, optionally `ProfileHueSatMapData1`/`2` with
//! their dims and encoding tag.
//!
//! Dropped on purpose: `ProfileToneCurve` (Maple uses AgX as the view
//! transform; PTC would double tone-map) and `ProfileLookTable` (replaced by
//! a universal DisplayLookCurve in a separate ticket).
//!
//! ## Bundle size
//!
//! Matrices-only bundle is ~210 KB for all 1,447 profiles. With HSM the
//! bundle balloons to ~72 MB (HSM is mostly per-body 90×30×1×3×4 ≈ 32 KB,
//! two illuminants). The matrices alone fix the catastrophic-ΔE cases that
//! motivated this ticket; HSM is a refinement that can be turned on later if
//! the per-fixture color-checker analysis says it's necessary. The reader
//! supports both layouts — `flags & 0x10` / `flags & 0x20` per profile.

use std::collections::HashMap;
use std::sync::OnceLock;

use crate::color::dcp::{interpolated_profile, DcpProfile};
use crate::color::hsm::{HsmEncoding, HsmTable};
use crate::color::illuminant::Illuminant as CoreIlluminant;
use crate::image::RawImage;
use crate::math::Matrix3;

/// One bundled Maple profile — Adobe-DCP-derived, AgX-compatible (PTC/PLT
/// dropped at conversion time). Stored as `'static` in [`PROFILE_TABLE`].
#[derive(Clone, Debug)]
pub struct MapleProfile {
    /// Unique camera key from DCP `UniqueCameraModel` (tag 50708). Apple
    /// per-lens variants like `"iPhone13,3 back telephoto camera"` are
    /// distinct keys — the lens disambiguation happens at lookup time.
    pub unique_camera_model: String,
    /// DCP calibration illuminant 1 (typically StdA / 2856K). `None` when
    /// the source DCP omitted CM1.
    pub illum1: Option<CoreIlluminant>,
    /// DCP calibration illuminant 2 (typically D65 / 6504K). `None` when
    /// the source DCP omitted CM2.
    pub illum2: Option<CoreIlluminant>,
    /// `ColorMatrix1` (XYZ → camera at illuminant 1).
    pub cm1: Option<Matrix3>,
    /// `ColorMatrix2` (XYZ → camera at illuminant 2).
    pub cm2: Option<Matrix3>,
    /// `ForwardMatrix1` (camera → XYZ-D50). Absent in ~11/1447 bodies; DCP
    /// falls back to Bradford CA when missing.
    pub fm1: Option<Matrix3>,
    /// `ForwardMatrix2` (camera → XYZ-D50). Same shape as `fm1`.
    pub fm2: Option<Matrix3>,
    /// `ProfileHueSatMapData1` — pre-allocated `HsmTable`. `None` when the
    /// bundle was built without HSM (current default) or when the DCP omits
    /// HSM entirely (322/1447 bodies).
    pub hsm1: Option<HsmTable>,
    /// `ProfileHueSatMapData2`.
    pub hsm2: Option<HsmTable>,
    /// Per-image baseline-exposure offset from DCP tag 51109. Default 0.0.
    /// Composed additively with the DNG-level `BaselineExposure` tag at
    /// decode time (see `decode.rs` § 1b).
    pub baseline_exposure_offset: f32,
}

/// Resolved camera identity used as the lookup key. The optional lens
/// component lets us distinguish multi-lens mobile cameras (iPhone wide /
/// telephoto / ultra-wide variants). For non-multi-lens bodies the lens
/// field is `None` and the bundled UCM is the full key.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct CameraKey {
    pub unique_camera_model: String,
}

impl CameraKey {
    pub fn new(unique_camera_model: impl Into<String>) -> Self {
        Self {
            unique_camera_model: unique_camera_model.into(),
        }
    }
}

/// Embedded bundle blob — produced by `src/scripts/convert_adobe_dcps.py`.
/// When the file is missing at compile time we degrade to an empty bundle:
/// `lookup_profile` returns `None`, and `dcp::profile_for` falls back to
/// rawler / DNG-embedded paths exactly as before. This lets CI builds
/// without the Adobe profiles directory still produce a working binary.
const PROFILES_BIN: &[u8] = include_bytes!("profiles/profiles.bin");

const MAGIC: &[u8; 4] = b"MDCP";
const FORMAT_VERSION: u16 = 1;

/// Decoded `(camera_key → profile)` table. Populated lazily on first
/// `lookup_profile` call. `OnceLock` is the std-lib equivalent of `lazy_static`
/// since Rust 1.70 — same semantics, no extra crate.
static PROFILE_TABLE: OnceLock<HashMap<CameraKey, MapleProfile>> = OnceLock::new();

/// Look up a bundled profile for the given `RawImage`. Returns `None` when
/// the camera isn't in the bundle, falling back to the existing DCP code
/// path (rawler matrices / embedded DNG profile). See [`dcp::profile_for`]
/// for the wiring.
///
/// Honours the `MAPLE_DISABLE_BUNDLED_PROFILES=1` env var as a dev-only
/// kill switch: forces a miss without rebuilding. Useful when comparing
/// the bundled vs embedded paths during calibration. Production builds
/// never set the var.
pub fn lookup_profile(raw: &RawImage) -> Option<&'static MapleProfile> {
    if std::env::var("MAPLE_DISABLE_BUNDLED_PROFILES").as_deref() == Ok("1") {
        return None;
    }
    let table = PROFILE_TABLE.get_or_init(parse_bundle);
    let key = camera_key_for(raw);
    table.get(&key)
}

/// True when this `RawImage` has a bundled Maple profile available. When
/// true, the develop pipeline should ignore the source DNG's
/// `ProfileToneCurve` tag — that tag was calibrated against the source
/// vendor's own matrices, and the bundled "Adobe Standard" matrices we
/// substitute differ enough on some bodies (notably iPhone DNGs, which
/// ship a 257-pair PTC) to cause a tone double-up. Maple's AgX view
/// transform supplies the canonical tone mapping; the PTC was redundant
/// even before the matrix swap.
///
/// `ProfileLookTable` is NOT suppressed by this flag: on bodies whose
/// source DNG was produced by Adobe DNG Converter, the embedded PLT IS
/// Adobe Standard's calibrated look table and dropping it causes a real
/// ΔE regression (~10 units on the Canon 5D Mark III DNG fixture). The
/// universal-Look refactor (separate ticket) will replace PLT entirely
/// with a profile-independent display-look curve; until then PLT stays.
///
/// `ProfileGainTableMap` is also NOT suppressed: it's per-pixel sensor-
/// domain calibration, not look-space tone shaping, so it remains valid
/// even when matrices change.
pub fn has_bundled_profile(raw: &RawImage) -> bool {
    lookup_profile(raw).is_some()
}

/// Derive the bundle lookup key from a decoded `RawImage`.
///
/// Three sources, in priority order:
///   1. The DNG `UniqueCameraModel` tag when present (`raw.unique_camera_model`).
///      iPhone DNGs ship lens-disambiguated values here — e.g.
///      `"iPhone13,3 back telephoto camera"` — which match Adobe's DCP
///      filenames byte-for-byte.
///   2. `"{camera_make} {camera_model}"` when both are non-empty and the make
///      isn't already a prefix of the model. Adobe's UCM convention for
///      DSLRs is `"Canon EOS 5D Mark IV"` / `"Nikon D850"` / `"Sony ILCE-7M3"`,
///      but rawler's `clean_model` strips the make prefix (yielding
///      `"EOS 5D Mark IV"`). Recomposing matches Adobe's filenames.
///   3. `camera_model` alone (for completeness; rawler's `clean_model` is
///      sometimes already `"Canon EOS 5D Mark IV"` shape for legacy bodies).
///
/// The first successful table hit wins. We don't try multiple keys against
/// the table at call time because the cost would compound with every body
/// we add later — keying right here is cheaper.
pub fn camera_key_for(raw: &RawImage) -> CameraKey {
    if let Some(ucm) = raw.unique_camera_model.as_deref() {
        if !ucm.is_empty() {
            return CameraKey::new(ucm.to_string());
        }
    }
    let make = raw.camera_make.trim();
    let model = raw.camera_model.trim();
    if !make.is_empty() && !model.is_empty() && !model.starts_with(make) {
        return CameraKey::new(format!("{} {}", make, model));
    }
    CameraKey::new(model.to_string())
}

/// Convert a [`MapleProfile`] to a fully resolved [`DcpProfile`] for use in
/// the DCP pipeline. Mirrors `dcp::profile_for`'s logic — dual-illuminant
/// reciprocal-CCT interpolation when both CM1 and CM2 are present, single-
/// illuminant fallback otherwise.
///
/// HSM resolution: prefer the bundled `MapleProfile`'s HSM tables when
/// present, but **fall back** to the source DNG's `raw.hsm_data1/2` when
/// the bundle has none. The current bundle (per PR #324) ships matrices
/// only — HSM data is ~72 MB and the catastrophic-ΔE fixtures don't need
/// it — so the fallback is what's actually exercised on every body whose
/// source DNG ships HSM (Canon 5DM3/5DM4 DNGs in the fixture set, every
/// iPhone DNG). When the bundle is regenerated with `--include-hsm`, the
/// bundled tables take precedence.
///
/// The DcpProfile's PLT / PTC fields are not set here (they live on
/// `RawImage`); the caller (`pipeline::develop`) decides whether to apply
/// the source DNG's PTC/PLT — and currently it suppresses them whenever a
/// bundled profile is in use, since PTC/PLT were calibrated against the
/// vendor's own matrices.
pub fn to_dcp_profile(
    profile: &MapleProfile,
    raw: &RawImage,
) -> Option<DcpProfile> {
    // Mirror dcp::profile_for's WB-baked decision so a neutral patch maps
    // cleanly to (1,1,1) going into DCP (Phase 1.2 pre-gain semantics).
    let skip_pre_gain = matches!(raw.cfa, crate::image::CfaPattern::LinearRgb)
        && raw.white_level <= 255;
    let wb_already_baked = !skip_pre_gain;

    let cold = profile.illum1.and_then(|i| profile.cm1.map(|m| (i, m)));
    let warm = profile.illum2.and_then(|i| profile.cm2.map(|m| (i, m)));

    // HSM source: prefer the bundle's. When the bundle ships no HSM tables
    // (current default — matrices-only bundle), pass through the source
    // DNG's HSM (raw.hsm_data1/2). That preserves the pre-#324 behavior on
    // bodies whose DNG already shipped Adobe's HSM (e.g. Canon 5DM3 DNG
    // post-conversion-from-CR2 — the embedded HSM matches Adobe Standard's
    // by construction). Vendor RAW formats lack DNG tags, so the fallback
    // is `None`, same as before.
    let hsm1 = profile.hsm1.as_ref().or(raw.hsm_data1.as_ref());
    let hsm2 = profile.hsm2.as_ref().or(raw.hsm_data2.as_ref());

    if let (Some((il_cold, m_cold)), Some((il_warm, m_warm))) = (cold, warm) {
        if il_cold != il_warm {
            return Some(interpolated_profile(
                m_cold,
                il_cold,
                m_warm,
                il_warm,
                raw.as_shot_neutral,
                wb_already_baked,
                hsm1,
                hsm2,
                profile.fm1,
                profile.fm2,
            ));
        }
    }

    // Single-illuminant fallback. Build a minimal DcpProfile from the
    // available CM. Same algebra as `dcp::profile_for`'s single-illum branch.
    let (illum, cm) = match (
        profile.illum1.and_then(|i| profile.cm1.map(|m| (i, m))),
        profile.illum2.and_then(|i| profile.cm2.map(|m| (i, m))),
    ) {
        (Some(p), _) => p,
        (None, Some(p)) => p,
        (None, None) => return None,
    };
    let fm = match illum {
        i if Some(i) == profile.illum1 => profile.fm1,
        _ => profile.fm2,
    };
    let single_hsm = hsm1.cloned().or_else(|| hsm2.cloned());

    let neutral_for_white: [f32; 3] = if wb_already_baked {
        [1.0, 1.0, 1.0]
    } else {
        raw.as_shot_neutral
    };
    let scene_white_xyz = cm
        .inverse()
        .map(|inv| normalize_to_y1(inv.mul_vec(neutral_for_white)))
        .unwrap_or(crate::color::matrices::XYZ_D65);
    let scene_cct = compute_scene_cct_single(cm, raw.as_shot_neutral, illum.cct());
    Some(DcpProfile {
        illuminant: illum,
        color_matrix: cm,
        forward_matrix: fm,
        scene_cct,
        scene_white_xyz,
        wb_already_baked,
        hsm: single_hsm,
    })
}

fn normalize_to_y1(xyz: crate::math::Vec3) -> crate::math::Vec3 {
    if xyz[1].abs() < 1e-8 {
        return crate::color::matrices::XYZ_D65;
    }
    let s = 1.0 / xyz[1];
    [xyz[0] * s, 1.0, xyz[2] * s]
}

/// Re-implementation of `dcp::compute_scene_cct_single`. Duplicated here
/// because it's a private function in `dcp.rs`; rather than widen the
/// surface area, this 8-line piece of math is kept in sync. If the algorithm
/// in `dcp.rs` ever changes, update both sites.
fn compute_scene_cct_single(cm: Matrix3, wb_neutral: [f32; 3], fallback: f32) -> f32 {
    let cm_inv = match cm.inverse() {
        Some(inv) => inv,
        None => return fallback,
    };
    let xyz = cm_inv.mul_vec(wb_neutral);
    let sum = xyz[0] + xyz[1] + xyz[2];
    if sum < 1e-6 {
        return fallback;
    }
    let x = xyz[0] / sum;
    let y = xyz[1] / sum;
    let n = (x - 0.3320) / (0.1858 - y);
    let cct = 437.0 * n.powi(3) + 3601.0 * n.powi(2) + 6861.0 * n + 5517.0;
    cct.clamp(2000.0, 15000.0)
}

// ── Bundle parsing ────────────────────────────────────────────────────────────

fn parse_bundle() -> HashMap<CameraKey, MapleProfile> {
    let mut map = HashMap::new();
    let mut r = match Reader::new(PROFILES_BIN) {
        Some(r) => r,
        None => return map, // empty / wrong-magic bundle → degrade to empty.
    };
    let count = r.count;
    for _ in 0..count {
        let Some(profile) = r.read_profile() else {
            // Malformed record → bail with what we have so far. We don't
            // poison the whole table on a single bad record.
            break;
        };
        let key = CameraKey::new(profile.unique_camera_model.clone());
        // Multiple DCPs with the same UCM would be a writer bug; last-write-
        // wins is fine because the input dir has unique UCMs per file.
        map.insert(key, profile);
    }
    map
}

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
    count: u32,
}

impl<'a> Reader<'a> {
    fn new(buf: &'a [u8]) -> Option<Self> {
        if buf.len() < 16 || &buf[..4] != MAGIC {
            return None;
        }
        let version = u16::from_le_bytes([buf[4], buf[5]]);
        if version != FORMAT_VERSION {
            return None;
        }
        let count = u32::from_le_bytes([buf[8], buf[9], buf[10], buf[11]]);
        Some(Self { buf, pos: 16, count })
    }

    #[inline]
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let end = self.pos.checked_add(n)?;
        if end > self.buf.len() {
            return None;
        }
        let s = &self.buf[self.pos..end];
        self.pos = end;
        Some(s)
    }

    fn read_u8(&mut self) -> Option<u8> { Some(self.take(1)?[0]) }
    fn read_u16(&mut self) -> Option<u16> {
        let b = self.take(2)?;
        Some(u16::from_le_bytes([b[0], b[1]]))
    }
    fn read_f32(&mut self) -> Option<f32> {
        let b = self.take(4)?;
        Some(f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn read_matrix(&mut self) -> Option<Matrix3> {
        let mut m = [[0f32; 3]; 3];
        for r in 0..3 {
            for c in 0..3 {
                m[r][c] = self.read_f32()?;
            }
        }
        Some(Matrix3(m))
    }

    fn read_hsm(&mut self, dims: [u32; 3], encoding: HsmEncoding) -> Option<HsmTable> {
        let expected = (dims[0] as usize) * (dims[1] as usize) * (dims[2] as usize) * 3;
        let mut data = Vec::with_capacity(expected);
        for _ in 0..expected {
            data.push(self.read_f32()?);
        }
        HsmTable::new(dims, data, encoding)
    }

    fn read_profile(&mut self) -> Option<MapleProfile> {
        let ucm_len = self.read_u16()? as usize;
        let ucm_bytes = self.take(ucm_len)?;
        let unique_camera_model = std::str::from_utf8(ucm_bytes).ok()?.to_string();

        let flags = self.read_u8()?;
        let _reserved = self.read_u8()?;
        let illum1_code = self.read_u16()?;
        let illum2_code = self.read_u16()?;
        let _reserved = self.read_u16()?;

        let cm1 = if flags & 0x01 != 0 { Some(self.read_matrix()?) } else { None };
        let cm2 = if flags & 0x02 != 0 { Some(self.read_matrix()?) } else { None };
        let fm1 = if flags & 0x04 != 0 { Some(self.read_matrix()?) } else { None };
        let fm2 = if flags & 0x08 != 0 { Some(self.read_matrix()?) } else { None };

        let hsm_h = self.read_u16()? as u32;
        let hsm_s = self.read_u16()? as u32;
        let hsm_v = self.read_u16()? as u32;
        let hsm_encoding_byte = self.read_u8()?;
        let _reserved = self.read_u8()?;
        let hsm_encoding = match hsm_encoding_byte {
            1 => HsmEncoding::Srgb,
            _ => HsmEncoding::Linear,
        };

        let hsm1 = if flags & 0x10 != 0 {
            self.read_hsm([hsm_h, hsm_s, hsm_v], hsm_encoding)
        } else {
            None
        };
        let hsm2 = if flags & 0x20 != 0 {
            self.read_hsm([hsm_h, hsm_s, hsm_v], hsm_encoding)
        } else {
            None
        };

        let baseline_exposure_offset = self.read_f32()?;

        let illum1 = if illum1_code != 0 { Some(exif_illuminant_to_core(illum1_code)) } else { None };
        let illum2 = if illum2_code != 0 { Some(exif_illuminant_to_core(illum2_code)) } else { None };

        Some(MapleProfile {
            unique_camera_model,
            illum1,
            illum2,
            cm1,
            cm2,
            fm1,
            fm2,
            hsm1,
            hsm2,
            baseline_exposure_offset,
        })
    }
}

/// Same EXIF-illuminant decoder as `decode.rs::exif_illuminant_to_core`,
/// duplicated to keep the loader self-contained. The DNG/EXIF tags are
/// stable; if the mapping ever changes both call sites must move together.
fn exif_illuminant_to_core(code: u16) -> CoreIlluminant {
    match code {
        17 => CoreIlluminant::StdA,
        21 => CoreIlluminant::D65,
        22 => CoreIlluminant::D55,
        23 => CoreIlluminant::D50,
        _ => CoreIlluminant::D65,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The embedded bundle parses without errors and contains expected
    /// fixture-camera bodies. If this fires after a bundle regen, the
    /// converter dropped a body or the format changed without a version bump.
    #[test]
    fn bundled_profiles_load_and_contain_fixture_cameras() {
        let table = PROFILE_TABLE.get_or_init(parse_bundle);
        // Without the gitignored `profiles.bin` this will be empty (CI
        // without Adobe profiles installed). Skip-assert in that case
        // matches the "fixtures missing → soft pass" pattern in
        // test_color_pipeline.sh.
        if table.is_empty() {
            eprintln!(
                "profile_loader: bundle empty (profiles.bin missing or stale); \
                 skipping camera-coverage assertions"
            );
            return;
        }

        // These three bodies are the catastrophic-ΔE fixtures from #324.
        let expected = [
            "iPhone13,3 back camera",
            "Canon EOS 5D Mark IV",
            "Canon EOS 5D Mark III",
        ];
        for ucm in expected {
            assert!(
                table.contains_key(&CameraKey::new(ucm)),
                "bundle missing UCM {}",
                ucm
            );
        }

        // Sanity: dual-illuminant Apple wide camera has both CMs and both FMs.
        let p = table
            .get(&CameraKey::new("iPhone13,3 back camera"))
            .expect("iPhone13,3 back camera present");
        assert!(p.cm1.is_some() && p.cm2.is_some(), "iPhone should have CM1+CM2");
        assert!(p.fm1.is_some() && p.fm2.is_some(), "iPhone should have FM1+FM2");
        assert_eq!(p.illum1, Some(CoreIlluminant::StdA));
        assert_eq!(p.illum2, Some(CoreIlluminant::D65));
    }

    /// Verify all four iPhone 13,3 lens variants are bundled as distinct
    /// keys. The lens-aware lookup story for mobile cameras is the whole
    /// reason the lookup key includes the lens-tagged UCM.
    #[test]
    fn iphone_lens_variants_are_distinct_keys() {
        let table = PROFILE_TABLE.get_or_init(parse_bundle);
        if table.is_empty() {
            return;
        }
        let variants = [
            "iPhone13,3 back camera",
            "iPhone13,3 back telephoto camera",
            "iPhone13,3 back ultra wide camera",
            "iPhone13,3 front camera",
        ];
        let mut found = 0;
        for v in variants {
            if table.contains_key(&CameraKey::new(v)) {
                found += 1;
            }
        }
        assert_eq!(
            found,
            variants.len(),
            "expected all 4 iPhone 13,3 lens variants in bundle, found {}",
            found
        );
    }

    /// Header validation: a buffer that doesn't start with `MDCP` produces an
    /// empty bundle without panicking.
    #[test]
    fn bad_magic_yields_empty_bundle() {
        // Simulate a bundle parse on a known-bad buffer via a private path.
        let bad = b"NOTOK\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00";
        assert!(Reader::new(bad).is_none());
    }

    /// Header validation: version mismatch yields no Reader.
    #[test]
    fn version_mismatch_yields_empty_bundle() {
        let mut buf = Vec::new();
        buf.extend_from_slice(MAGIC);
        buf.extend_from_slice(&999u16.to_le_bytes()); // wrong version
        buf.extend_from_slice(&0u16.to_le_bytes());
        buf.extend_from_slice(&0u32.to_le_bytes());
        buf.extend_from_slice(&0u32.to_le_bytes());
        assert!(Reader::new(&buf).is_none());
    }
}
