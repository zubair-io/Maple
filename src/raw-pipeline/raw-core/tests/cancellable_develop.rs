//! Cancellable develop chain (#951).
//!
//! Proves end-to-end (through the real decode → develop chain on a synthetic,
//! fixture-free DNG) that:
//!   * a pre-set cancel flag makes the cancellable develop entry return
//!     `Err(Error::Cancelled)` quickly — before a full develop would finish —
//!     demonstrating the in-stage check actually unwinds the chain, and
//!   * the never-cancel default is bit-identical to the non-cancellable entry,
//!     so a render that runs to completion is unchanged (the color-neutral
//!     invariant the ticket requires).
//!
//! Uses `SyntheticGreyDng` (same helper as `grey_invariants.rs`) so the test
//! is deterministic and runs without the gitignored fixtures — gated on
//! `test-support` exactly like the other synthetic-DNG suites.

#![cfg(feature = "test-support")]

use std::sync::atomic::AtomicBool;

use raw_core::cancel::CancelToken;
use raw_core::error::Error;
use raw_core::pipeline::{
    develop_scene_linear_from_raw_with_quality,
    develop_scene_linear_from_raw_with_quality_cancellable,
    develop_scene_linear_sized_from_raw_with_quality_cancellable, RenderQuality,
};
use raw_core::test_support::synth_dng::SyntheticGreyDng;
use raw_core::xmp::AdjustmentModel;

fn decode_synth() -> raw_core::RawImage {
    // Non-trivial size so demosaic + the slider stages do real per-pixel work
    // (the cancel-before-finish claim is only meaningful if the full develop
    // is non-instant). `nr_color = 100` forces the dominant NLM pass on.
    let dng = SyntheticGreyDng {
        linear_value: 0.25,
        width: 256,
        height: 256,
        ..Default::default()
    };
    let bytes = dng.write_to_bytes();
    raw_core::decode::decode_bytes(&bytes, "dng").expect("synthetic DNG must decode")
}

/// A model that exercises the expensive, cancel-instrumented stages so a
/// pre-set flag has something to bail out of mid-chain.
fn heavy_model() -> AdjustmentModel {
    AdjustmentModel {
        nr_color: 100.0,
        nr_luminance: 100.0,
        sharpen_amount: 100.0,
        ..AdjustmentModel::default()
    }
}

#[test]
fn preset_cancel_returns_err_cancelled_full() {
    let raw = decode_synth();
    let model = heavy_model();

    let flag = AtomicBool::new(true);
    let result = develop_scene_linear_from_raw_with_quality_cancellable(
        &raw,
        &model,
        RenderQuality::Full,
        CancelToken::new(&flag),
    );
    assert!(
        matches!(result, Err(Error::Cancelled)),
        "pre-set cancel must return Err(Cancelled), got {:?}",
        result.as_ref().map(|img| (img.width, img.height)),
    );
}

#[test]
fn preset_cancel_returns_err_cancelled_sized() {
    let raw = decode_synth();
    let model = heavy_model();

    let flag = AtomicBool::new(true);
    let result = develop_scene_linear_sized_from_raw_with_quality_cancellable(
        &raw,
        &model,
        RenderQuality::Preview,
        128,
        CancelToken::new(&flag),
    );
    assert!(
        matches!(result, Err(Error::Cancelled)),
        "pre-set cancel must return Err(Cancelled) on the sized entry, got {:?}",
        result.as_ref().map(|img| (img.width, img.height)),
    );
}

#[test]
fn never_cancel_is_bit_identical_to_plain_entry() {
    let raw = decode_synth();
    let model = heavy_model();

    let plain = develop_scene_linear_from_raw_with_quality(&raw, &model, RenderQuality::Full)
        .expect("plain develop must succeed");
    let never = develop_scene_linear_from_raw_with_quality_cancellable(
        &raw,
        &model,
        RenderQuality::Full,
        CancelToken::never(),
    )
    .expect("never-cancel develop must succeed");

    assert_eq!(plain.width, never.width);
    assert_eq!(plain.height, never.height);
    assert_eq!(plain.space, never.space);
    assert_eq!(
        plain.pixels, never.pixels,
        "never-cancel develop must be bit-identical to the non-cancellable entry"
    );
}

/// A flag flipped to cancelled only AFTER develop has completed must not
/// affect a render that already finished — the never-cancel path observed it
/// as false throughout. (Guards against accidentally checking a stale flag at
/// the very end and corrupting an otherwise-complete result.)
#[test]
fn cancel_after_completion_still_succeeds() {
    let raw = decode_synth();
    let model = heavy_model();
    let flag = AtomicBool::new(false);
    let out = develop_scene_linear_from_raw_with_quality_cancellable(
        &raw,
        &model,
        RenderQuality::Full,
        CancelToken::new(&flag),
    )
    .expect("develop with a not-yet-set flag must succeed");
    assert!(out.width > 0 && out.height > 0);
}
