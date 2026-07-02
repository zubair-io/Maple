#![cfg(test)]
//! Tests for the tile-rendering entry — rejection guards, output shape,
//! and tile-vs-full-chain parity. Split out of `super::mod` so the tile
//! entry stays under the file-size budget (#114), following the
//! `pipeline/develop/tests.rs` sibling pattern.

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
        1024,
        1024,
        512,
        512,
        512,
        512,
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
        1024,
        1024,
        512,
        512,
        512,
        512,
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
        1024,
        1024,
        512,
        512,
        512,
        512,
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
        1024,
        1024,
        512,
        512,
        512,
        512,
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
        1024,
        1024,
        512,
        512,
        512,
        512,
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
        1024,
        1024,
        512,
        512,
        512,
        512,
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
        0,
        0,
        512,
        512,
        512,
        256,
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
        0,
        0,
        1024,
        512,
        256,
        128,
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
        0,
        0,
        513,
        512,
        257,
        256,
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
        0,
        0,
        512,
        512,
        1024,
        512,
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
        0,
        0,
        512,
        512,
        512,
        1024,
        RenderQuality::Full,
    );
    assert!(r_h.is_err(), "out_h > src_h must error");
}

/// Tile entry: renders a 512×512 source-pixel rectangle out of the
/// largest available DNG fixture. Verifies (a) returned size matches
/// `out_w` × `out_h`, (b) alpha lane is `0x3c00` (1.0) everywhere,
/// (c) at least 10% of the buffer is non-alpha, non-zero (real
/// pixels not borders). Fixture-gated — `test_0002.dng` is gitignored:
/// `ignore`d without `--features fixtures`, fail-closed with it (#1082).
#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn render_scene_linear_tile_returns_oriented_fp16_rgba_at_target_size() {
    let path = crate::test_support::fixtures::require_raw("test_0002.dng");
    let bytes = std::fs::read(&path).expect("read raw");
    let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode");
    let model = AdjustmentModel::default();
    let (src_x, src_y, src_w, src_h) = (1024u32, 1024u32, 512u32, 512u32);
    let (out_w, out_h) = (512u32, 512u32);
    let (w, h, fp16) = render_scene_linear_tile_from_raw_with_quality(
        &raw,
        &model,
        src_x,
        src_y,
        src_w,
        src_h,
        out_w,
        out_h,
        RenderQuality::Full,
    )
    .expect("tile render");
    assert_eq!(w, out_w, "tile width");
    assert_eq!(h, out_h, "tile height");
    assert_eq!(fp16.len() as u32, 4 * w * h);
    let alpha_ok = fp16.chunks_exact(4).filter(|c| c[3] == 0x3c00).count();
    assert_eq!(alpha_ok, (w * h) as usize, "all alpha lanes = 1.0");
    let nonzero = fp16.iter().filter(|&&v| v != 0 && v != 0x3c00).count();
    assert!(
        nonzero > (fp16.len() / 10),
        "tile mostly zero: {} non-zero non-alpha lanes",
        nonzero
    );
}

/// Tile entry rounds source coordinates down to even multiples of 2
/// for Bayer-phase correctness on `demosaic::half_res`. Pass odd
/// coords; verify the rendered tile matches the requested
/// out_w/out_h. Pixel-equality not asserted — the coord rounding is
/// a defensive snap that does not perturb `out_w`/`out_h`.
#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn render_scene_linear_tile_rounds_source_coords_to_even() {
    let path = crate::test_support::fixtures::require_raw("test_0002.dng");
    let bytes = std::fs::read(&path).expect("read raw");
    let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode");
    let model = AdjustmentModel::default();
    let (w_odd, h_odd, _) = render_scene_linear_tile_from_raw_with_quality(
        &raw,
        &model,
        1025,
        1025,
        512,
        512,
        256,
        256,
        RenderQuality::Full,
    )
    .expect("odd coords tile");
    let (w_even, h_even, _) = render_scene_linear_tile_from_raw_with_quality(
        &raw,
        &model,
        1024,
        1024,
        512,
        512,
        256,
        256,
        RenderQuality::Full,
    )
    .expect("even coords tile");
    assert_eq!((w_odd, h_odd), (256, 256));
    assert_eq!((w_even, h_even), (256, 256));
}

/// Tile-vs-full-chain parity with a non-default tone curve (#1084).
///
/// Before #1084 the tile chain silently omitted `tone_curves`, so any
/// image with a parametric region slider or a point curve rendered
/// deep-zoom tiles that visibly diverged from the preview. This gate
/// renders a 512×512 interior region both ways and asserts the
/// fp16-packed results agree bit-for-bit:
///
/// * the model carries both an active parametric slider and a
///   non-identity luma point curve, covering both `tone_curves`
///   sub-paths;
/// * the model is restricted to the pointwise/stencil-exact stages:
///   `auto_exposure: Off` (the stage is omitted on the tile path —
///   #1167), `sharpen_amount: 0` and `nr_color: 0` (their separable
///   blurs accumulate row sums whose f32 rounding is buffer-position
///   dependent — not what this gate measures). Everything that remains
///   (linearize, demosaic — 2 px stencil ≪ `TILE_OVERLAP_PX`, WB
///   pre-gain, highlight recovery — 7×7 window, DCP, WB, scene tone
///   controls, the tone curve) computes each output pixel from
///   identical inputs in identical operation order on both paths, so
///   bit-equality is the expected result, not an aspiration.
///
/// Fixture-gated like the other tile tests (`test_0002.dng` is
/// gitignored; `ignore`d without `--features fixtures`, fail-closed
/// with it — #1082). The fixture facts the coordinate mapping relies on are
/// asserted, not assumed: no DefaultCrop (the full chain crops before
/// the color stages, which would shift coordinates), no
/// ProfileGainTableMap (spatially-varying gain is evaluated in
/// buffer-normalized coordinates), and Normal orientation (the tile
/// entry orients its output; the develop helper does not).
#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn tile_matches_full_chain_with_non_default_tone_curve() {
    use crate::types::adjustment::ToneCurve;

    let path = crate::test_support::fixtures::require_raw("test_0002.dng");
    let bytes = std::fs::read(&path).expect("read raw");
    let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode");
    assert!(
        raw.crop_rect.is_none(),
        "fixture grew a DefaultCrop — update this test's coordinate mapping"
    );
    assert!(
        raw.profile_gain_table_map.is_none(),
        "fixture grew a ProfileGainTableMap — update this test's stage set"
    );
    assert_eq!(
        raw.orientation,
        crate::image::ExifOrientation::Normal,
        "fixture orientation changed — update this test's coordinate mapping"
    );

    let model = AdjustmentModel {
        auto_exposure: crate::xmp::AutoExposureMode::Off,
        sharpen_amount: 0.0,
        nr_color: 0.0,
        parametric_shadows: 30.0,
        tone_curve_luma: ToneCurve::new(vec![
            (0.0, 0.0),
            (0.25, 0.18),
            (0.5, 0.62),
            (0.75, 0.85),
            (1.0, 1.0),
        ]),
        ..AdjustmentModel::default()
    };

    // Self-check: the curve must actually perturb pixels, or this parity
    // gate would pass trivially if `tone_curves` were dropped from BOTH
    // chains.
    {
        let mut probe =
            crate::image::Image::new(2, 1, crate::image::ColorSpace::SceneLinearRec2020);
        probe.pixels[0] = [0.18, 0.18, 0.18];
        probe.pixels[1] = [1.0, 1.0, 1.0];
        let before = probe.pixels.clone();
        crate::stages::tone_curves::apply(&mut probe, &model);
        assert_ne!(
            probe.pixels, before,
            "test model's tone curve must be non-identity"
        );
    }

    let (src_x, src_y, side) = (1024u32, 1024u32, 512u32);
    let (tw, th, tile_fp16) = render_scene_linear_tile_from_raw_with_quality(
        &raw,
        &model,
        src_x,
        src_y,
        side,
        side,
        side,
        side,
        RenderQuality::Full,
    )
    .expect("tile render");
    assert_eq!((tw, th), (side, side), "tile output dims");

    let full = crate::pipeline::develop_scene_linear_from_raw_with_quality(
        &raw,
        &model,
        RenderQuality::Full,
    )
    .expect("full develop");

    // Compare every tile lane against the same full-chain pixel after
    // fp16 packing (the tile output format). Bit-exact is the contract —
    // see the doc comment; the per-lane bit distance is reported so a
    // future divergence is diagnosable from the failure output alone.
    let fw = full.width as usize;
    let mut diff_lanes = 0usize;
    let mut max_bit_dist: u32 = 0;
    for ty in 0..side as usize {
        for tx in 0..side as usize {
            let fi = (src_y as usize + ty) * fw + (src_x as usize + tx);
            let fp = full.pixels[fi];
            for c in 0..3 {
                let expect = f32_to_f16_bits(fp[c]);
                let got = tile_fp16[(ty * side as usize + tx) * 4 + c];
                if expect != got {
                    diff_lanes += 1;
                    let dist = (expect as i32 - got as i32).unsigned_abs();
                    if dist > max_bit_dist {
                        max_bit_dist = dist;
                    }
                }
            }
        }
    }
    eprintln!(
        "tile-vs-full tone-curve parity: {} differing lanes of {}, max fp16 bit distance {}",
        diff_lanes,
        (side * side * 3),
        max_bit_dist,
    );
    assert_eq!(
        diff_lanes, 0,
        "tile diverges from full chain with a non-default tone curve: \
         {} lanes differ (max fp16 bit distance {})",
        diff_lanes, max_bit_dist
    );
}
