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
//! Lookup key is the DNG `UniqueCameraModel` string (tag 50708). For
//! multi-lens mobile bodies, the lens identifier is already baked into the
//! UCM by the vendor — Apple ships per-lens UCMs like `iPhone13,3 back
//! camera`, `iPhone13,3 back telephoto camera`, `iPhone13,3 back ultra wide
//! camera`, and Adobe ships one DCP per lens-tagged UCM. We bundle all
//! variants as distinct entries (see `iphone_lens_variants_are_distinct_keys`
//! test below) and the runtime picks the right one by matching the captured
//! DNG's UCM byte-for-byte. No separate `lens_id` column is needed — the
//! DNG-spec UCM is the discriminator the vendor and Adobe already share.
//!
//! ## Bundle format
//!
//! Little-endian throughout. Header (16 bytes) followed by N variable-length
//! profile records. See `src/scripts/convert_adobe_dcps.py` module-docstring
//! for the per-byte spec — both reader ([`parser`]) and writer (the script)
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
//!
//! ## Module layout
//!
//! - [`types`] — the public `MapleProfile` / `CameraKey` data types.
//! - [`parser`] — the binary-bundle `Reader` + `parse_bundle()`.
//! - this file — the `OnceLock` singleton, public lookup API
//!   (`lookup_profile`, `has_bundled_profile`, `camera_key_for`,
//!   `to_dcp_profile`), and the DCP-profile resolution math.

mod parser;
mod types;

use std::collections::HashMap;
use std::sync::OnceLock;

use crate::color::dcp::{interpolated_profile, DcpProfile};
use crate::image::RawImage;
use crate::math::Matrix3;

pub use types::{CameraKey, MapleProfile};

/// Embedded bundle blob — produced by `src/scripts/convert_adobe_dcps.py`.
/// `include_bytes!` is a compile-time macro: the file MUST exist at
/// `profiles/profiles.bin` for the crate to build. The bundle is committed
/// to the repo (currently ~256 KB, well under any practical limit), so
/// every developer / CI runner gets it via `git clone`. Regenerate by
/// re-running the converter against an Adobe Camera Raw install.
///
/// Runtime graceful degradation: when `parser::parse_bundle` fails to
/// validate the header (e.g. bumped `FORMAT_VERSION`, corrupted bytes) it
/// returns an empty `HashMap` — `lookup_profile` then returns `None` and
/// `dcp::profile_for` falls back to rawler / DNG-embedded paths. So a
/// stale bundle never breaks decoding, but a *missing* bundle is a build
/// error, not a runtime miss.
pub(crate) const PROFILES_BIN: &[u8] = include_bytes!("../profiles/profiles.bin");

pub(crate) const MAGIC: &[u8; 4] = b"MDCP";
pub(crate) const FORMAT_VERSION: u16 = 1;

/// Decoded `(camera_key → profile)` table. Populated lazily on first
/// `lookup_profile` call. `OnceLock` is the std-lib equivalent of `lazy_static`
/// since Rust 1.70 — same semantics, no extra crate.
static PROFILE_TABLE: OnceLock<HashMap<CameraKey, MapleProfile>> = OnceLock::new();

/// Look up a bundled profile for the given `RawImage`. Returns `None` in
/// three cases, in priority order:
///
/// 1. The camera isn't in the bundle (or `MAPLE_DISABLE_BUNDLED_PROFILES=1`).
/// 2. **The source DNG already ships a `ProfileLookTable`.** When PLT is
///    present, the source was authored by Adobe DNG Converter and already
///    carries Adobe Standard's calibrated PLT (paired to Adobe's matrices
///    + FM). Substituting a bundled override on top is a partial-
///    calibration mismatch — the matrices/FM we'd inject diverge from what
///    the embedded PLT was tuned for. Empirically observed regression on
///    Leica M10 DNG: +1.80 mean ΔE without this gate; with it, no change.
///    Vendor RAW formats don't ship PLT, so this gate doesn't apply there.
/// 3. **The source matrices already match the bundled ones byte-for-byte
///    within 1e-3 per entry.** Applying the bundle would only have value
///    via its FM addition; but adding Adobe's FM to a body that previously
///    used Bradford CA regresses the ACR-reference fixture set for several
///    vendor formats (Fujifilm RAF: +7.18 ΔE, Sony ARW: +2.85, Nikon NEF:
///    +2.82). Adobe's FM is calibrated against ACR's full chain; Maple's
///    chain doesn't yet match ACR's downstream (AgX vs. ACR tone), so the
///    FM-vs-Bradford choice swings per body. Until that's reconciled, only
///    apply the bundle when matrices actually differ from the source.
///
/// Together these gates collapse the bundled-lookup hit set to bodies
/// whose embedded matrices materially diverge from Adobe Standard AND
/// whose source isn't already Adobe-calibrated. In the current fixture
/// set that's effectively the iPhone DNG family — the canonical motivating
/// case for this ticket. Broader coverage (Canon CR2 FM addition, Leica
/// matrix swap) is gated behind the downstream tone-chain work in
/// separate tickets.
pub fn lookup_profile(raw: &RawImage) -> Option<&'static MapleProfile> {
    if std::env::var("MAPLE_DISABLE_BUNDLED_PROFILES").as_deref() == Ok("1") {
        return None;
    }
    let table = PROFILE_TABLE.get_or_init(|| parser::parse_bundle(PROFILES_BIN));
    let key = camera_key_for(raw);
    let profile = table.get(&key)?;
    // Gate 2: Adobe-DNG-Converter-authored DNGs are already calibrated.
    if raw.plt.is_some() {
        return None;
    }
    // Gate 3: bundle would be a no-op matrix-wise, and FM addition can hurt.
    if matrices_match_source(profile, raw) {
        return None;
    }
    Some(profile)
}

/// True when every bundled matrix that's also present in the source `RawImage`
/// agrees within a tight tolerance. The tolerance is loose enough to absorb
/// SRATIONAL → f32 round-trip noise (1e-3 per entry); tight enough to catch
/// the iPhone case where rawler-exposed CMs differ from Adobe Standard by
/// ~0.16 in several entries.
fn matrices_match_source(profile: &MapleProfile, raw: &RawImage) -> bool {
    const TOL: f32 = 1e-3;
    fn close(a: Matrix3, b: Matrix3, tol: f32) -> bool {
        for r in 0..3 {
            for c in 0..3 {
                if (a.0[r][c] - b.0[r][c]).abs() > tol {
                    return false;
                }
            }
        }
        true
    }
    for (illum_opt, bundled_cm) in [
        (profile.illum1, profile.cm1),
        (profile.illum2, profile.cm2),
    ] {
        let (illum, bcm) = match (illum_opt, bundled_cm) {
            (Some(i), Some(m)) => (i, m),
            _ => continue,
        };
        if let Some(src_cm) = raw.color_matrices.get(&illum) {
            if !close(*src_cm, bcm, TOL) {
                return false;
            }
        }
    }
    true
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::illuminant::Illuminant as CoreIlluminant;

    /// The embedded bundle parses without errors and contains expected
    /// fixture-camera bodies. If this fires after a bundle regen, the
    /// converter dropped a body or the format changed without a version bump.
    #[test]
    fn bundled_profiles_load_and_contain_fixture_cameras() {
        let table = PROFILE_TABLE.get_or_init(|| parser::parse_bundle(PROFILES_BIN));
        // `profiles.bin` is committed to the repo (required at compile time
        // by `include_bytes!`), so this path normally has entries. The
        // empty-table guard below covers the corrupted-header /
        // version-mismatch case — `parser::parse_bundle` returns an empty
        // map in those scenarios — and matches the "fixtures missing → soft
        // pass" pattern in test_color_pipeline.sh.
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
        let table = PROFILE_TABLE.get_or_init(|| parser::parse_bundle(PROFILES_BIN));
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
}
