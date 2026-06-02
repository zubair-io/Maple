//! Auto-Profile Path/Bytes render-parity test (#867).
//!
//! Split out from `tests.rs` to keep each file under the 600-LOC budget
//! (#482). The end-to-end gate proving `RawInput::Path` (maple-cli / Apple
//! FFI reference) and `RawInput::Bytes` (raw-wasm web canvas) render
//! byte-identically under `Profile::Auto`. Moved verbatim.

#![cfg(test)]

use super::*;

/// #867 — `RawInput::Path` (maple-cli / Apple FFI, the parity-gate reference)
/// and `RawInput::Bytes` (raw-wasm `render_bytes`, the web canvas) must produce
/// byte-IDENTICAL renders for the same RAW + model under `Profile::Auto`. The
/// two entries fit the Auto curve through different sourcing helpers
/// (`fit_curve_from_raw_display` extracts the embedded JPEG from a path with an
/// exiftool fallback; `fit_curve_from_bytes_display` extracts from the in-memory
/// bytes via rawler only). On every fixture rawler can decode (test_0017
/// included — its preview extracts byte-for-byte identically on both helpers),
/// the developed scene buffer, the extracted preview, and therefore the fitted
/// `ProfileCurve` and final pixels are identical.
///
/// This is the END-TO-END companion to `auto_profile::tests::fit_bytes_matches_
/// fit_path` (#555), which only proves the fit functions agree given identical
/// synthetic source pixels. This gate additionally proves the *render* entries
/// feed those functions identical inputs — guarding the exact divergence #867
/// raised at the entry-point boundary, not just inside the fit helper.
#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn auto_profile_path_and_bytes_render_byte_identical_867() {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/raws/test_0017.dng");
    if !path.exists() {
        return;
    }
    let bytes = std::fs::read(&path).expect("read raw bytes");
    let ext = "dng";
    let raw = crate::decode::decode_bytes(&bytes, ext).expect("decode");
    // Default model = `Profile::Auto` — the cold-open default both entries use.
    let model = AdjustmentModel::default();
    assert_eq!(model.profile, crate::types::adjustment::Profile::Auto);

    let (wp, hp, from_path) = render_from_raw_with_quality_and_source(
        &raw,
        &model,
        RenderQuality::Full,
        Some(RawInput::Path(&path)),
    )
    .expect("path render");
    // `CacheKey::from_path` and `CacheKey::from_bytes` are distinct keys, so the
    // path render's cached curve cannot mask a real divergence in the bytes fit.
    let (wb, hb, from_bytes) = render_from_raw_with_quality_and_source(
        &raw,
        &model,
        RenderQuality::Full,
        Some(RawInput::Bytes { bytes: &bytes, ext }),
    )
    .expect("bytes render");

    assert_eq!((wp, hp), (wb, hb), "Path/Bytes render dimensions disagree");
    assert_eq!(
        from_path, from_bytes,
        "Auto Profile render diverges between RawInput::Path and RawInput::Bytes \
         (#867) — the web canvas (Bytes) and maple-cli/Apple reference (Path) \
         must be byte-identical for the same RAW"
    );
}
