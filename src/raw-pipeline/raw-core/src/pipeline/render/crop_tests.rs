//! Crop / straighten integration tests for `pipeline::render` (ticket #277).
//!
//! Extracted from `tests.rs` to keep both files under the 600-LOC hard
//! budget (#772). `super` is `pipeline::render`.

#![cfg(test)]

use super::*;
use crate::test_support::fixtures::require_raw;

// -----------------------------------------------------------------------
// Crop / straighten integration (ticket #277)
// -----------------------------------------------------------------------

#[cfg_attr(not(feature = "fixtures"), ignore)]
#[test]
fn render_with_default_crop_matches_no_crop_path() {
    // Sanity gate: a default-`Crop::IDENTITY` render must be byte-equal
    // to a render run with crop disabled in the same way the
    // pre-#277 pipeline behaved. We assert identity of the bytes
    // produced by `render_from_raw` against itself with the explicit
    // identity crop spelled out — that's the parity-baseline contract.
    let path = require_raw("test_0002.dng");
    let bytes_in = std::fs::read(&path).expect("read raw");
    let raw = crate::decode::decode_bytes(&bytes_in, "dng").expect("decode");
    let model_default = AdjustmentModel::default();
    let mut model_explicit_identity = AdjustmentModel::default();
    model_explicit_identity.crop = crate::types::Crop::IDENTITY;

    let (w_a, h_a, a) = render_from_raw(&raw, &model_default).unwrap();
    let (w_b, h_b, b) = render_from_raw(&raw, &model_explicit_identity).unwrap();
    assert_eq!((w_a, h_a), (w_b, h_b));
    assert_eq!(
        a, b,
        "default crop must be byte-identity with explicit IDENTITY"
    );
}

#[cfg_attr(not(feature = "fixtures"), ignore)]
#[test]
fn render_with_axis_aligned_crop_clips_dimensions() {
    let path = require_raw("test_0002.dng");
    let bytes_in = std::fs::read(&path).expect("read raw");
    let raw = crate::decode::decode_bytes(&bytes_in, "dng").expect("decode");
    let mut model = AdjustmentModel::default();
    model.crop = crate::types::Crop {
        top: 0.1,
        left: 0.0,
        bottom: 0.9,
        right: 1.0,
        angle: 0.0,
    };
    let (w_full, h_full, _) = render_from_raw(&raw, &AdjustmentModel::default()).unwrap();
    let (w, h, bytes) = render_from_raw(&raw, &model).unwrap();
    // 80% of full height, full width.
    assert!(
        h < h_full,
        "crop should reduce height: full {}, cropped {}",
        h_full,
        h
    );
    assert_eq!(w, w_full, "crop spanning 0..1 in x should preserve width");
    assert_eq!(bytes.len() as u32, w * h * 3);
    // Image is plausible (not all zeros).
    let nonzero = bytes.iter().filter(|&&b| b != 0).count() as f32 / bytes.len() as f32;
    assert!(
        nonzero > 0.5,
        "cropped buffer too sparse: {:.1}%",
        nonzero * 100.0
    );
}

#[cfg_attr(not(feature = "fixtures"), ignore)]
#[test]
fn render_scene_linear_path_returns_full_frame_regardless_of_crop() {
    // CONTRACT (#1871): the scene-linear FFI path that Apple + Web consume
    // returns the FULL oriented frame even when `model.crop` is set. Crop
    // is host-owned on the live path by design — the hosts need overscan
    // for the interactive crop tool and apply the rect themselves:
    //   - Apple: `CropImageStage.swift` (#638 — "the crop is NOT in the
    //     Rust scene-linear core on Apple"), geometry fixed in #2118.
    //   - Web:   `image-canvas.crop.ts` (spec § 3.12 rotate-then-cut).
    // The display-encoded exports/CLI path DOES crop in core (#277) — see
    // `render_with_axis_aligned_crop_clips_dimensions` above. Wiring crop
    // into the scene-linear entries would double-crop both hosts.
    //
    // This test's previous incarnation
    // (`render_with_axis_aligned_crop_scene_linear_path_matches_dims`)
    // asserted the opposite — a contract written into the #277 test file
    // but never implemented on this path, red since birth and invisible to
    // cloud CI (fixture-gated). It now pins the real invariant so a future
    // core-side crop can't silently land and double-crop the hosts.
    let path = require_raw("test_0002.dng");
    let bytes_in = std::fs::read(&path).expect("read raw");
    let raw = crate::decode::decode_bytes(&bytes_in, "dng").expect("decode");
    let mut model = AdjustmentModel::default();
    model.crop = crate::types::Crop {
        top: 0.25,
        left: 0.25,
        bottom: 0.75,
        right: 0.75,
        angle: 0.0,
    };
    let (w_full, h_full, _) = render_scene_linear_from_raw_with_quality(
        &raw,
        &AdjustmentModel::default(),
        RenderQuality::Preview,
    )
    .unwrap();
    let (w, h, fp16) =
        render_scene_linear_from_raw_with_quality(&raw, &model, RenderQuality::Preview).unwrap();
    assert_eq!(
        (w, h),
        (w_full, h_full),
        "scene-linear path must return the full oriented frame (host-owned crop): \
         full {}x{}, with-crop {}x{}",
        w_full,
        h_full,
        w,
        h
    );
    assert_eq!(fp16.len() as u32, 4 * w * h, "fp16 length mismatch");
}
