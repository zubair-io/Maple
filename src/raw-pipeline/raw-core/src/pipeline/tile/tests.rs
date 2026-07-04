#![cfg(test)]
//! Tests for the tile-rendering entry — rejection guards (dehaze,
//! vignette, deep denoise, local adjustments, capture sharpening,
//! mismatched aspect, upscale). Split out of `super::mod` so the tile
//! entry stays under the file-size budget (#114), following the
//! `pipeline/develop/tests.rs` sibling pattern. Output-shape and
//! tile-vs-full-chain parity tests are further split into the sibling
//! `tests_render.rs` (PR #1730 — this file crossed the 600-LOC hard cap
//! on its own).

use super::*;

/// Build a fake `RawImage` for the rejection / out>src error-path tests.
/// Decode + DCP + every chained stage need a real RAW + DCP profile,
/// so these helpers only feed paths that error before any of that
/// runs.
fn fake_raw(w: u32, h: u32) -> RawImage {
    RawImage {
        width: w,
        height: h,
        cfa: crate::image::CfaPattern::Rggb,
        black_level: [0, 0, 0, 0],
        white_level: 1023,
        raw_data: vec![0u16; (w as usize) * (h as usize)],
        as_shot_neutral: [1.0, 1.0, 1.0],
        as_shot_cct: None,
        camera_make: "Test".into(),
        camera_model: "Test".into(),
        unique_camera_model: None,
        color_matrices: std::collections::HashMap::new(),
        forward_matrices: std::collections::HashMap::new(),
        orientation: crate::image::ExifOrientation::Normal,
        baseline_exposure: 0.0,
        hsm_data: std::collections::HashMap::new(),
        plt: None,
        profile_tone_curve: None,
        profile_gain_table_map: None,
        crop_rect: None,
        iso: 100,
        noise_profile: None,
        opcode_list3: None,
        aperture: None,
        focal_length: None,
    }
}

/// Tile entry rejects `model.dehaze != 0` with a "dehaze" error. The
/// rejection happens before any decode / DCP work, so a synthetic
/// `RawImage` (no DCP profile) is sufficient to exercise the path.
#[test]
fn render_scene_linear_tile_rejects_active_dehaze() {
    let raw = fake_raw(2048, 2048);
    let model = AdjustmentModel {
        dehaze: 50.0,
        ..Default::default()
    };
    let r = render_scene_linear_tile_from_raw_with_quality(
        &raw,
        &model,
        TileRect {
            src_x: 1024,
            src_y: 1024,
            src_w: 512,
            src_h: 512,
            out_w: 512,
            out_h: 512,
        },
        RenderQuality::Full,
    );
    assert!(r.is_err(), "tile path must error when dehaze != 0");
    let msg = format!("{}", r.unwrap_err());
    assert!(
        msg.contains("dehaze"),
        "error must mention dehaze, got: {}",
        msg
    );
}

/// Tile entry rejects `model.vignette_amount != 0` with a "vignette"
/// error (#1109) — the stage's radial gain is anchored to the full
/// frame and the tile entry does not thread the tile window through
/// yet (#11). Same fake-RawImage rationale as the dehaze test.
#[test]
fn render_scene_linear_tile_rejects_active_vignette() {
    let raw = fake_raw(2048, 2048);
    let model = AdjustmentModel {
        vignette_amount: -40.0,
        ..Default::default()
    };
    let r = render_scene_linear_tile_from_raw_with_quality(
        &raw,
        &model,
        TileRect {
            src_x: 1024,
            src_y: 1024,
            src_w: 512,
            src_h: 512,
            out_w: 512,
            out_h: 512,
        },
        RenderQuality::Full,
    );
    assert!(r.is_err(), "tile path must error when vignette_amount != 0");
    let msg = format!("{}", r.unwrap_err());
    assert!(
        msg.contains("vignette"),
        "error must mention vignette, got: {}",
        msg
    );
}

/// Tile entry rejects `model.deep_denoise != 0` with a "deep denoise"
/// error (#1105) — the BM3D reference-patch grid is frame-anchored, so
/// per-tile grids would seam at tile borders. The FFI file/bytes tile
/// entries pre-check this; the core gate covers the handle-based FFI
/// entry and maple-cli too. Same fake-RawImage rationale as the dehaze
/// test.
#[test]
fn render_scene_linear_tile_rejects_active_deep_denoise() {
    let raw = fake_raw(2048, 2048);
    let model = AdjustmentModel {
        deep_denoise: 50.0,
        ..Default::default()
    };
    let r = render_scene_linear_tile_from_raw_with_quality(
        &raw,
        &model,
        TileRect {
            src_x: 1024,
            src_y: 1024,
            src_w: 512,
            src_h: 512,
            out_w: 512,
            out_h: 512,
        },
        RenderQuality::Full,
    );
    assert!(r.is_err(), "tile path must error when deep_denoise != 0");
    let msg = format!("{}", r.unwrap_err());
    assert!(
        msg.contains("deep denoise"),
        "error must mention deep denoise, got: {}",
        msg
    );
}

/// Tile entry rejects a model carrying a non-identity local adjustment
/// (#1084) — mask weights evaluate in full-image-normalized coordinates,
/// which a padded crop cannot reproduce. Same loud-rejection contract
/// (and same `Error::Pipeline` class) as the dehaze gate above; the host
/// falls back to the full-image refine. Rejection fires before any
/// decode / DCP work, so the synthetic `RawImage` suffices.
#[test]
fn render_scene_linear_tile_rejects_active_local_adjustments() {
    use crate::types::{LocalAdjustment, PartialAdjustments, Point2};

    let raw = fake_raw(2048, 2048);
    let layer = LocalAdjustment::linear(
        Point2::new(0.0, 0.0),
        Point2::new(1.0, 1.0),
        PartialAdjustments {
            exposure: Some(1.0),
            ..Default::default()
        },
    );
    let model = AdjustmentModel {
        local_adjustments: vec![layer],
        ..Default::default()
    };
    let r = render_scene_linear_tile_from_raw_with_quality(
        &raw,
        &model,
        TileRect {
            src_x: 1024,
            src_y: 1024,
            src_w: 512,
            src_h: 512,
            out_w: 512,
            out_h: 512,
        },
        RenderQuality::Full,
    );
    assert!(
        r.is_err(),
        "tile path must error when a local adjustment is active"
    );
    let msg = format!("{}", r.unwrap_err());
    assert!(
        msg.contains("local adjustments"),
        "error must mention local adjustments, got: {}",
        msg
    );

    // An all-identity layer (every `PartialAdjustments` field `None`) is
    // skipped by `local_adjustments::apply`, so the gate must NOT trip —
    // the tile path stays available for models the full chain would no-op
    // on. (`fake_raw` has no DCP profile, so the render may still fail
    // further down; only assert the failure is not the local-adjustments
    // rejection.)
    let identity_layer = LocalAdjustment::linear(
        Point2::new(0.0, 0.0),
        Point2::new(1.0, 1.0),
        PartialAdjustments::default(),
    );
    let model_identity = AdjustmentModel {
        local_adjustments: vec![identity_layer],
        ..Default::default()
    };
    let r_identity = render_scene_linear_tile_from_raw_with_quality(
        &raw,
        &model_identity,
        TileRect {
            src_x: 1024,
            src_y: 1024,
            src_w: 512,
            src_h: 512,
            out_w: 512,
            out_h: 512,
        },
        RenderQuality::Full,
    );
    if let Err(e) = r_identity {
        let msg = format!("{}", e);
        assert!(
            !msg.contains("local adjustments"),
            "identity layer must not trip the local-adjustments gate: {}",
            msg
        );
    }
}

/// Tile entry rejects a model with an active capture-sharpening amount
/// (#1084) — the iterated Richardson–Lucy stencil reaches past
/// `TILE_OVERLAP_PX` at the σ = 8 helper clamp. Same loud-rejection
/// contract as dehaze. The gate reuses the full chain's engage predicate
/// (`capture_sharpening_params_from_model`), so `amount = 0` (the
/// default, exercised by every other test here) keeps the tile path
/// available.
#[test]
fn render_scene_linear_tile_rejects_active_capture_sharpening() {
    let raw = fake_raw(2048, 2048);
    let model = AdjustmentModel {
        capture_sharpening_amount: 50.0,
        ..Default::default()
    };
    let r = render_scene_linear_tile_from_raw_with_quality(
        &raw,
        &model,
        TileRect {
            src_x: 1024,
            src_y: 1024,
            src_w: 512,
            src_h: 512,
            out_w: 512,
            out_h: 512,
        },
        RenderQuality::Full,
    );
    assert!(
        r.is_err(),
        "tile path must error when capture sharpening is active"
    );
    let msg = format!("{}", r.unwrap_err());
    assert!(
        msg.contains("capture sharpening"),
        "error must mention capture sharpening, got: {}",
        msg
    );
}

/// Tile entry rejects mismatched-aspect requests. The trim →
/// downsample chain drives a single long-edge scale, so honouring
/// `(out_w, out_h)` with a non-matching aspect would silently
/// produce a fit-within square instead of the requested rect. We
/// reject loudly with a "matching aspect" message; the FFI surface
/// maps that to rc=12. Same fake-RawImage rationale as the dehaze
/// test (rejection fires before any decode work).
#[test]
fn render_scene_linear_tile_rejects_mismatched_aspect() {
    let raw = fake_raw(2048, 2048);
    let model = AdjustmentModel::default();
    // src 512×512 (1:1), out 512×256 (2:1) — strict mismatch.
    let r = render_scene_linear_tile_from_raw_with_quality(
        &raw,
        &model,
        TileRect {
            src_x: 0,
            src_y: 0,
            src_w: 512,
            src_h: 512,
            out_w: 512,
            out_h: 256,
        },
        RenderQuality::Full,
    );
    assert!(r.is_err(), "tile path must error on mismatched aspect");
    let msg = format!("{}", r.unwrap_err());
    assert!(
        msg.contains("matching aspect"),
        "error must mention matching aspect, got: {}",
        msg
    );

    // src 1024×512 (2:1), out 256×128 (2:1) — matches; should NOT
    // error on the aspect check. (May still error elsewhere because
    // `fake_raw` has no DCP profile, so just confirm the message is
    // not the aspect one.)
    let r_ok_aspect = render_scene_linear_tile_from_raw_with_quality(
        &raw,
        &model,
        TileRect {
            src_x: 0,
            src_y: 0,
            src_w: 1024,
            src_h: 512,
            out_w: 256,
            out_h: 128,
        },
        RenderQuality::Full,
    );
    if let Err(e) = r_ok_aspect {
        let msg = format!("{}", e);
        assert!(
            !msg.contains("matching aspect"),
            "matching-aspect request must not trip the aspect guard: {}",
            msg
        );
    }

    // Equal cross-product within the integer-rounding tolerance
    // (one row/column of `src_w.max(src_h)`) — should pass.
    // src 513×512, out 257×256: cross diff = |513*256 - 512*257| = 256 <= 513.
    let r_tol = render_scene_linear_tile_from_raw_with_quality(
        &raw,
        &model,
        TileRect {
            src_x: 0,
            src_y: 0,
            src_w: 513,
            src_h: 512,
            out_w: 257,
            out_h: 256,
        },
        RenderQuality::Full,
    );
    if let Err(e) = r_tol {
        let msg = format!("{}", e);
        assert!(
            !msg.contains("matching aspect"),
            "near-aspect within tolerance must not trip guard: {}",
            msg
        );
    }
}

/// Tile entry rejects upscale requests (`out_w > src_w` or
/// `out_h > src_h`). Same fake-RawImage rationale as the dehaze test.
#[test]
fn render_scene_linear_tile_rejects_upscale() {
    let raw = fake_raw(2048, 2048);
    let model = AdjustmentModel::default();
    let r_w = render_scene_linear_tile_from_raw_with_quality(
        &raw,
        &model,
        TileRect {
            src_x: 0,
            src_y: 0,
            src_w: 512,
            src_h: 512,
            out_w: 1024,
            out_h: 512,
        },
        RenderQuality::Full,
    );
    assert!(r_w.is_err(), "out_w > src_w must error");
    let msg = format!("{}", r_w.unwrap_err());
    assert!(
        msg.contains("upscale") || msg.contains("downscale"),
        "error must mention up/downscale, got: {}",
        msg
    );

    let r_h = render_scene_linear_tile_from_raw_with_quality(
        &raw,
        &model,
        TileRect {
            src_x: 0,
            src_y: 0,
            src_w: 512,
            src_h: 512,
            out_w: 512,
            out_h: 1024,
        },
        RenderQuality::Full,
    );
    assert!(r_h.is_err(), "out_h > src_h must error");
}
