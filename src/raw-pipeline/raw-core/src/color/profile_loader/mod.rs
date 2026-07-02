//! Runtime loader for Maple's bundled third-party-derived DCP profiles.
//!
//! The upstream tooling ships 1,403+ high-quality externally-calibrated
//! DCPs under its `CameraRaw/CameraProfiles/` directory. The
//! `src/scripts/convert_dcps.py` tool re-encodes that data into a
//! single binary at `profiles/profiles.bin`, included into the crate via
//! [`include_bytes!`].
//!
//! Why bundled at all: rawler's per-camera matrices (its dcraw-lineage
//! defaults) are catastrophically wrong on some bodies — iPhone 12 Pro, the
//! Canon 5DM3/5DM4 family — producing 20+ ΔE biases on standard fixtures.
//! The externally-calibrated DCPs fix the matrices. See ticket #324.
//!
//! Under ticket #345 (bundle-canonical color) the bundle is the SOLE
//! source of color math: rawler decodes pixels + EXIF, the bundle
//! supplies CM/FM/HSM, and when the bundle has no entry for a body the
//! `dcp` layer returns an identity-CM `Fallback` profile rather than
//! silently substituting rawler's dcraw-lineage matrices. Coverage gaps
//! are tracked in `COVERAGE.md` next to the bundle binary.
//!
//! Lookup key is the DNG `UniqueCameraModel` string (tag 50708). For
//! multi-lens mobile bodies, the lens identifier is already baked into the
//! UCM by the vendor — Apple ships per-lens UCMs like `iPhone13,3 back
//! camera`, `iPhone13,3 back telephoto camera`, `iPhone13,3 back ultra wide
//! camera`, and the upstream tooling ships one DCP per lens-tagged UCM.
//! We bundle all variants as distinct entries (see
//! `iphone_lens_variants_are_distinct_keys` test below) and the runtime
//! picks the right one by matching the captured DNG's UCM byte-for-byte.
//! No separate `lens_id` column is needed — the DNG-spec UCM is the
//! discriminator the vendor and the upstream tooling already share.
//!
//! ## Bundle format
//!
//! Little-endian throughout. Header (16 bytes) followed by N variable-length
//! profile records. See `src/scripts/convert_dcps.py` module-docstring
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
mod parser_v3;
#[cfg(test)]
mod tests_v3;
mod types;
mod writer;

use std::collections::HashMap;
use std::sync::OnceLock;

use crate::color::dcp::{interpolated_profile, single_illuminant_profile, DcpProfile};
use crate::color::ucm_mapping;
use crate::image::RawImage;

pub use types::{CameraKey, IndexRecord, MapleProfile, PoolDirEntry, ProfileIndex};
pub use writer::{encode_v3, EncodedV3, EncoderProfile};

// Re-exports for the maple-cli transcode subcommand and the v3 roundtrip
// tests: the v3 index parser and per-entry pool resolver. Both are
// delivery-agnostic (operate on byte slices) so #828 can layer async
// range-fetch + IndexedDB on top without touching the format.
pub use parser_v3::{inflate_pool_entry, parse_index, resolve_from_pool};

/// Repack a **v1** inline `profiles.bin` (matrices, HSM inline per record)
/// into the **v3 split** layout (#829, PR #831): dedup HSM into a pooled,
/// per-entry-zlib pool region + an uncompressed index region with the offset
/// directory. Matrix and HSM bytes are copied verbatim (no float round-trip),
/// so the resolved profile data is byte-identical across the repack.
///
/// Returns `None` when `v1_bytes` is not a valid v1 bundle (bad magic, wrong
/// version, or a truncated record). Powers the maple-cli `transcode-dcp`
/// subcommand and the v3 roundtrip tests.
pub fn transcode_v1_to_v3(v1_bytes: &[u8]) -> Option<EncodedV3> {
    let records = parser::extract_v1_records(v1_bytes)?;
    Some(writer::encode_v3(&records))
}

/// Embedded bundle blob — produced by `src/scripts/convert_dcps.py`.
/// `include_bytes!` is a compile-time macro: the file MUST exist at
/// `profiles/profiles.bin` for the crate to build. The bundle is committed
/// to the repo (currently ~256 KB, well under any practical limit), so
/// every developer / CI runner gets it via `git clone`. Regenerate by
/// re-running the converter against an upstream reference renderer install.
///
/// Runtime graceful degradation: when `parser::parse_bundle` fails to
/// validate the header (e.g. bumped `FORMAT_VERSION`, corrupted bytes) it
/// returns an empty `HashMap` — `lookup_profile` then returns `None` and
/// `dcp::profile_for_with_source` falls through to either the embedded-
/// DNG matrices ([`crate::color::dcp::ProfileSource::EmbeddedFull`] or
/// [`crate::color::dcp::ProfileSource::EmbeddedCmOnly`]) or the
/// synthetic D65→Rec.2020 path
/// ([`crate::color::dcp::ProfileSource::RawlerFallback`]) per #424/#460.
/// So a stale or missing bundle never breaks decoding, and color quality
/// degrades gracefully (embedded matrices first, synthetic only when
/// neither side provides a usable — non-identity, non-placeholder —
/// calibration matrix) rather than collapsing to identity.
pub(crate) const PROFILES_BIN: &[u8] = include_bytes!("../profiles/profiles.bin");

pub(crate) const MAGIC: &[u8; 4] = b"MDCP";

/// On-disk bundle layouts (the u16 at header offset 4).
///
///   * `1` — **inline matrices-only** (v1): 16-byte header then N uncompressed
///     records, each carrying its HSM table(s) inline. The historical, and
///     still SHIPPED, `profiles.bin` (~263 KB, matrices only — HSM flags
///     clear). [`parser::parse_bundle`] reads it.
///   * `3` — **v3 split** (ticket #829, PR #831): an uncompressed index region
///     (header + pool offset directory + records that reference HSM by pool
///     index) and a separately-addressable pool region of per-entry zlib
///     streams. The lazy-fetch-friendly foundation for #828. The abandoned
///     whole-stream v2 (=2) is intentionally skipped — it cannot support
///     per-body fetch and never shipped. [`parser_v3`] reads it.
pub(crate) const FORMAT_VERSION: u16 = 1;
pub(crate) const FORMAT_VERSION_V3: u16 = 3;

/// Decoded `(camera_key → profile)` table. Populated lazily on first
/// `lookup_profile` call. `OnceLock` is the std-lib equivalent of `lazy_static`
/// since Rust 1.70 — same semantics, no extra crate.
static PROFILE_TABLE: OnceLock<HashMap<CameraKey, MapleProfile>> = OnceLock::new();

/// Look up a bundled profile for the given `RawImage`.
///
/// Returns `None` only in two cases:
///   1. The camera isn't in the bundle (no UCM hit, and no UCM-mapping
///      alias matched either — see [`ucm_mapping`]).
///   2. `MAPLE_DISABLE_BUNDLED_PROFILES=1` is set (escape hatch for
///      diagnostics — exercises the identity-fallback path in
///      [`crate::color::dcp::profile_for_with_source`]).
///
/// Per ticket #345 (bundle-canonical color), the previous two gates
/// (`PLT-present` and `matrices-match-source`) were removed. Those gates
/// existed to hedge against source-mixing between rawler's `ColorMatrix`
/// and the bundle's `ForwardMatrix` — under bundle-canonical, both come
/// from the same authoring source so the source-mixing artifact they
/// hedged against no longer applies. With the gates gone, the bundled
/// lookup hit set expands from 1/16 fixtures (iPhone-only) to every
/// body whose UCM the bundle covers (15/16 in the current fixture set
/// after the UCM alias table lands; test_0004 / Hasselblad H5D-40 is
/// the only color-renderable miss — see [`ucm_mapping`] +
/// `profiles/COVERAGE.md`).
pub fn lookup_profile(raw: &RawImage) -> Option<&'static MapleProfile> {
    if std::env::var("MAPLE_DISABLE_BUNDLED_PROFILES").as_deref() == Ok("1") {
        return None;
    }
    let table = PROFILE_TABLE.get_or_init(|| parser::parse_bundle(PROFILES_BIN));
    let key = camera_key_for(raw);
    if let Some(profile) = table.get(&key) {
        return Some(profile);
    }
    // UCM-naming-mismatch fallback (#345 step 3). Some rawler-reported
    // UCMs differ from the bundle's authoring UCM by vendor naming
    // convention only (Hasselblad medium-format, DJI Mavic 3 Pro's
    // Hasselblad sensor, etc.). The alias table maps the source string
    // to the bundle's string deterministically — no fuzzy matching.
    if let Some(alias) = ucm_mapping::map_to_bundle_ucm(raw, &key.unique_camera_model) {
        if let Some(profile) = table.get(&CameraKey::new(alias)) {
            return Some(profile);
        }
    }
    None
}

/// True when this `RawImage` has a bundled Maple profile available. When
/// true, the develop pipeline should ignore the source DNG's
/// `ProfileToneCurve` tag — that tag was calibrated against the source
/// vendor's own matrices, and the bundled externally-calibrated matrices
/// we substitute differ enough on some bodies (notably iPhone DNGs,
/// which ship a 257-pair PTC) to cause a tone double-up. Maple's AgX
/// view transform supplies the canonical tone mapping; the PTC was
/// redundant even before the matrix swap.
///
/// `ProfileLookTable` is NOT suppressed by this flag: on bodies whose
/// source DNG was produced by an external DNG converter, the embedded
/// PLT IS the external standard profile's calibrated look table and
/// dropping it causes a real ΔE regression (~10 units on the Canon 5D
/// Mark III DNG fixture). The universal-Look refactor (separate
/// ticket) will replace PLT entirely with a profile-independent
/// display-look curve; until then PLT stays.
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
/// present, but **fall back** to the source DNG's `raw.hsm_data` (keyed
/// by `CalibrationIlluminant`) when the bundle has none. The current
/// bundle (per PR #324) ships matrices only — HSM data is ~72 MB and the
/// catastrophic-ΔE fixtures don't need it — so the fallback is what's
/// actually exercised on every body whose source DNG ships HSM (Canon
/// 5DM3/5DM4 DNGs in the fixture set, every iPhone DNG). When the bundle
/// is regenerated with `--include-hsm`, the bundled tables take precedence.
///
/// The DcpProfile's PLT / PTC fields are not set here (they live on
/// `RawImage`); the caller (`pipeline::develop`) decides whether to apply
/// the source DNG's PTC/PLT — and currently it suppresses them whenever a
/// bundled profile is in use, since PTC/PLT were calibrated against the
/// vendor's own matrices.
pub fn to_dcp_profile(profile: &MapleProfile, raw: &RawImage) -> Option<DcpProfile> {
    // Mirror dcp::profile_for's WB-baked decision so a neutral patch maps
    // cleanly to (1,1,1) going into DCP (Phase 1.2 pre-gain semantics).
    let skip_pre_gain =
        matches!(raw.cfa, crate::image::CfaPattern::LinearRgb) && raw.white_level <= 255;
    let wb_already_baked = !skip_pre_gain;

    let cold = profile.illum1.and_then(|i| profile.cm1.map(|m| (i, m)));
    let warm = profile.illum2.and_then(|i| profile.cm2.map(|m| (i, m)));

    // HSM source: prefer the bundle's (paired with the bundle's illum1/illum2
    // by construction). When the bundle ships no HSM tables (current default
    // — matrices-only bundle), pass through the source DNG's HSM. Looking
    // each side up by its specific illuminant (`raw.hsm_data.get(&il_cold)`
    // / `get(&il_warm)`) preserves the pre-#324 behaviour on bodies whose
    // DNG already shipped Adobe's HSM (e.g. Canon 5DM3 DNG post-conversion-
    // from-CR2) and stays correct on DNGs that list `CalibrationIlluminant1`
    // warmer than `CalibrationIlluminant2`. Vendor RAW formats lack DNG
    // tags, so the fallback is `None`, same as before.
    if let (Some((il_cold, m_cold)), Some((il_warm, m_warm))) = (cold, warm) {
        if il_cold != il_warm {
            let hsm_cold = profile.hsm1.as_ref().or_else(|| raw.hsm_data.get(&il_cold));
            let hsm_warm = profile.hsm2.as_ref().or_else(|| raw.hsm_data.get(&il_warm));
            return Some(interpolated_profile(
                m_cold,
                il_cold,
                m_warm,
                il_warm,
                raw.as_shot_neutral,
                wb_already_baked,
                hsm_cold,
                hsm_warm,
                profile.fm1,
                profile.fm2,
                raw.plt.clone(),
                None, // PTC is suppressed for BundleConfident
            ));
        }
    }

    // Single-illuminant fallback. Build a minimal DcpProfile from the
    // available CM via the shared `single_illuminant_profile` helper —
    // same algebra as `dcp::profile_for`'s single-illum branch.
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
    // Prefer bundle HSM keyed to the picked illuminant; fall through to the
    // bundle's other slot, then to any source-DNG HSM keyed to this
    // illuminant, then to any remaining source-DNG HSM.
    let single_hsm = profile
        .hsm1
        .clone()
        .or_else(|| profile.hsm2.clone())
        .or_else(|| raw.hsm_data.get(&illum).cloned())
        .or_else(|| raw.hsm_data.values().next().cloned());
    Some(single_illuminant_profile(
        cm,
        illum,
        fm,
        single_hsm,
        raw.as_shot_neutral,
        wb_already_baked,
        raw.plt.clone(),
        None, // PTC is suppressed for BundleConfident
    ))
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
        // `profiles.bin` is COMMITTED and `include_bytes!`-embedded (the
        // crate would not even compile without it), so an empty table —
        // `parser::parse_bundle` returns an empty map on a corrupted header
        // or version mismatch — is a corrupt artifact, not a missing
        // fixture. Fail loudly rather than skip-pass (#1082); mirrors
        // `shipped_bundle_has_no_duplicate_ucms` in parser.rs.
        assert!(
            !table.is_empty(),
            "embedded profiles.bin parsed to an empty table — corrupt bundle \
             (header/version mismatch)"
        );

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
        assert!(
            p.cm1.is_some() && p.cm2.is_some(),
            "iPhone should have CM1+CM2"
        );
        assert!(
            p.fm1.is_some() && p.fm2.is_some(),
            "iPhone should have FM1+FM2"
        );
        assert_eq!(p.illum1, Some(CoreIlluminant::StdA));
        assert_eq!(p.illum2, Some(CoreIlluminant::D65));
    }

    /// Verify all four iPhone 13,3 lens variants are bundled as distinct
    /// keys. The lens-aware lookup story for mobile cameras is the whole
    /// reason the lookup key includes the lens-tagged UCM.
    #[test]
    fn iphone_lens_variants_are_distinct_keys() {
        let table = PROFILE_TABLE.get_or_init(|| parser::parse_bundle(PROFILES_BIN));
        // Embedded bundle — empty means corrupt, not absent. See
        // `bundled_profiles_load_and_contain_fixture_cameras` (#1082).
        assert!(
            !table.is_empty(),
            "embedded profiles.bin parsed to an empty table"
        );
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

    /// Regression sanity for #370: at least one bundled body carries a
    /// non-zero `baseline_exposure_offset`. The per-body BE fudge table
    /// in `camera_calibration` was deleted in #370; the replacement is
    /// the offset that ships inside each DCP record. If every offset is
    /// zero, the wiring in `decode.rs` is correct but the production
    /// data is missing — likely a regression in `convert_dcps.py`.
    #[test]
    fn bundle_ships_at_least_one_body_with_nonzero_be_offset() {
        let table = PROFILE_TABLE.get_or_init(|| parser::parse_bundle(PROFILES_BIN));
        // Embedded bundle — empty means corrupt, not absent. See
        // `bundled_profiles_load_and_contain_fixture_cameras` (#1082).
        assert!(
            !table.is_empty(),
            "embedded profiles.bin parsed to an empty table"
        );
        let any_with_be = table.values().any(|p| p.baseline_exposure_offset != 0.0);
        assert!(
            any_with_be,
            "bundle has no body with a non-zero baseline_exposure_offset — \
             regression in convert_dcps.py?"
        );
    }
}
