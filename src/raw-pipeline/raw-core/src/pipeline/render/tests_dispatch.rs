//! T6 Auto Profile dispatch tests for `pipeline::render`.
//!
//! Split out of `tests.rs` to keep both files under the 600-LOC hard budget.
//! Tests the `Profile::Auto` vs `Profile::Neutral` routing through
//! `render_from_raw_with_quality_and_source`.

#![cfg(test)]

use super::*;
use crate::synthetic_input::neutral_ramp;
use crate::test_support::fixtures::require_raw;

/// Auto-Profile-aware variant of `render_path` — feeds the RAW path through
/// to `render_from_raw_with_quality_and_source` so `Profile::Auto` (#537) can
/// fit a curve from the embedded JPEG. Used by the T6 dispatch tests.
fn render_path_with_auto(
    path: &std::path::Path,
    model: &AdjustmentModel,
) -> Result<(u32, u32, Vec<u8>)> {
    let bytes = std::fs::read(path).map_err(|e| crate::error::Error::Io {
        path: path.to_path_buf(),
        source: e,
    })?;
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let raw = crate::decode::decode_bytes(&bytes, ext)?;
    render_from_raw_with_quality_and_source(
        &raw,
        model,
        RenderQuality::Full,
        Some(RawInput::Path(path)),
    )
}

// --- T6: Auto Profile dispatch ---
//
// `render_from_raw_with_quality_and_source` runs AgX + sRGB encode
// UNCONDITIONALLY (#550). `Profile::Auto` (with a source) then layers a
// per-channel curve on top in f32 sRGB-encoded display space via
// `auto_profile::fit_curve_from_raw_display` / `fit_curve_from_bytes_display`
// + `apply_curve`; the curve is a no-op (= AgX-Neutral output) for
// `Profile::Neutral`, any sourceless Auto, or a failed fit. Synthetic
// paths ignore `model.profile` (no RAW source to fit against).

/// FNV-1a 64-bit. Deterministic, no deps, sufficient for golden-byte
/// regression detection on the Neutral synthetic-render path.
fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// Synthetic `render_from_scene_linear` ignores `model.profile` by design
/// (no RAW path → can't fit Auto Profile). Output must therefore equal
/// the pre-T6 baseline byte-for-byte. The hash below was captured against
/// the implementation immediately after the T6 dispatch landed; any
/// regression in the Neutral / synthetic path will trip this gate.
#[test]
fn t6_synthetic_neutral_ramp_byte_golden() {
    use crate::view::look::Look;
    let ramp = neutral_ramp(64, 4);
    // `Look::Neutral` keeps the empirical Look LUT out of the picture so
    // any drift in the Look layer doesn't show up here. T6 owns the view
    // transform branch, not the Look layer.
    let model = AdjustmentModel {
        look: Look::Neutral,
        profile: crate::types::adjustment::Profile::Neutral,
        ..AdjustmentModel::default()
    };
    let (_, _, bytes) =
        render_from_scene_linear(ramp, &model).expect("synthetic neutral ramp render");
    let hash = fnv1a64(&bytes);
    // Golden captured 2026-05-26 (T6 dispatch landed). The synthetic path
    // is `model.profile`-insensitive — Neutral and Auto produce the same
    // bytes here — but the hash is the Neutral one for stability.
    assert_eq!(
        hash, 956442847563387073_u64,
        "synthetic Neutral byte hash regressed — render_from_scene_linear \
         was supposed to be unaffected by T6 dispatch (Auto Profile #537)"
    );
}

/// Synthetic path is `Profile`-insensitive: `Auto` and `Neutral` produce
/// the same bytes because there's no RAW path to fit against.
#[test]
fn t6_synthetic_auto_equals_neutral() {
    use crate::view::look::Look;
    let model_auto = AdjustmentModel {
        look: Look::Neutral,
        profile: crate::types::adjustment::Profile::Auto,
        ..AdjustmentModel::default()
    };
    let model_neutral = AdjustmentModel {
        look: Look::Neutral,
        profile: crate::types::adjustment::Profile::Neutral,
        ..AdjustmentModel::default()
    };
    let (_, _, bytes_a) = render_from_scene_linear(neutral_ramp(64, 4), &model_auto).unwrap();
    let (_, _, bytes_n) = render_from_scene_linear(neutral_ramp(64, 4), &model_neutral).unwrap();
    assert_eq!(
        bytes_a, bytes_n,
        "synthetic Auto and Neutral should be byte-identical — synthetic \
         input has no embedded JPEG, so Auto Profile is unreachable"
    );
}

/// Auto Profile takes a different view path from Neutral on a real RAW
/// (test_0017 has a usable embedded JPEG per T1's preview tests). Bytes
/// must differ; if they don't, the dispatch is silently routing through
/// the same view tail.
#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn t6_auto_profile_differs_from_neutral_on_test_0017() {
    use crate::view::look::Look;
    let path = require_raw("test_0017.dng");
    // Force `Look::Neutral` on both renders — Look is the same on either
    // branch, so excluding it isolates the dispatch under test.
    let auto = AdjustmentModel {
        look: Look::Neutral,
        profile: crate::types::adjustment::Profile::Auto,
        ..AdjustmentModel::default()
    };
    let neutral = AdjustmentModel {
        look: Look::Neutral,
        profile: crate::types::adjustment::Profile::Neutral,
        ..AdjustmentModel::default()
    };
    let (_, _, a) = render_path_with_auto(&path, &auto).expect("auto render");
    let (_, _, n) = render_path_with_auto(&path, &neutral).expect("neutral render");
    assert_eq!(a.len(), n.len(), "render dimensions disagree");
    let diffs: usize = a.iter().zip(n.iter()).filter(|(x, y)| x != y).count();
    assert!(
        diffs > a.len() / 100,
        "Auto and Neutral renders are nearly identical ({} / {} bytes \
         differ) — Profile dispatch is probably not wired",
        diffs,
        a.len()
    );
}

/// Sourceless call with `Profile::Auto` falls back to AgX-Neutral — the
/// resulting bytes must equal an explicit `Profile::Neutral` render.
#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn t6_auto_without_path_equals_neutral() {
    use crate::view::look::Look;
    let path = require_raw("test_0002.dng");
    let bytes = std::fs::read(&path).expect("read raw");
    let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode");
    let auto = AdjustmentModel {
        look: Look::Neutral,
        profile: crate::types::adjustment::Profile::Auto,
        ..AdjustmentModel::default()
    };
    let neutral = AdjustmentModel {
        look: Look::Neutral,
        profile: crate::types::adjustment::Profile::Neutral,
        ..AdjustmentModel::default()
    };
    let (_, _, a) = render_from_raw_with_quality_and_source(&raw, &auto, RenderQuality::Full, None)
        .expect("auto render w/o source");
    let (_, _, n) =
        render_from_raw_with_quality_and_source(&raw, &neutral, RenderQuality::Full, None)
            .expect("neutral render w/o source");
    assert_eq!(
        a, n,
        "Profile::Auto with `raw_source = None` must fall back to AgX and \
         match Profile::Neutral byte-for-byte"
    );
}
