#![cfg(test)]
//! Tile-vs-full parity tests for the HOST-THREADED develop-anchor
//! contracts — per-image scalars the caller measures once from a full
//! develop and threads into the tile chain: the #1725 decoded-WB anchor
//! and the #1167 auto-exposure gain. Split out of the sibling
//! `tests_render.rs` (which keeps the output-shape + stage-parity tests)
//! to stay under the file-size budget, following the same
//! `pipeline/develop/tests.rs` sibling pattern as the #1730 split.

use super::*;

/// Tile-vs-full parity with `papp:AutoExposure="On"` (#1167).
///
/// Before this ticket the tile chain never applied `auto_exposure` at all
/// (see `tile::develop`'s module doc) — a tile's own histogram isn't
/// representative of the whole scene, so it can't safely RECOMPUTE the
/// anchor gain per-tile. This test exercises the fix: measure the gain the
/// full-image develop's `auto_exposure` stage actually applied
/// (`develop_scene_linear_from_raw_with_quality_with_gain`), thread that
/// SAME scalar into the tile chain
/// (`render_scene_linear_tile_from_raw_with_quality_and_wb_anchor_and_ae_gain_f32`),
/// and assert the tile matches the full-chain crop. The AE multiply is a
/// per-pixel scalar op with no neighbour gather (unlike sharpen / nr_color's
/// separable blurs), so — same as the #1084 tone-curve and #1931 HSL parity
/// gates above — bit-equality is the expected result, not an aspiration.
/// `sharpen_amount` and `nr_color` are pinned to 0 for the same reason those
/// tests pin them: their row-sum accumulation is buffer-position dependent,
/// which is unrelated to what this gate measures.
#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn tile_matches_full_chain_with_auto_exposure_on() {
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
        auto_exposure: crate::xmp::AutoExposureMode::On,
        sharpen_amount: 0.0,
        nr_color: 0.0,
        ..AdjustmentModel::default()
    };

    let (full, ae_gain) = crate::pipeline::develop_scene_linear_from_raw_with_quality_with_gain(
        &raw,
        &model,
        RenderQuality::Full,
    )
    .expect("full develop with gain");

    // Self-check: the fixture must actually drive a non-trivial AE gain, or
    // this parity gate would pass trivially even if `ae_gain` were dropped on
    // the floor (e.g. threaded as a hardcoded 1.0 instead of the real value).
    assert!(
        (ae_gain - 1.0).abs() > 0.01,
        "test fixture's measured AE gain is too close to 1.0 to exercise this \
         gate: {ae_gain}"
    );

    let (src_x, src_y, side) = (1024u32, 1024u32, 512u32);
    let (tw, th, tile_f32) =
        render_scene_linear_tile_from_raw_with_quality_and_wb_anchor_and_ae_gain_f32(
            &raw,
            &model,
            TileRect {
                src_x,
                src_y,
                src_w: side,
                src_h: side,
                out_w: side,
                out_h: side,
            },
            RenderQuality::Full,
            None,
            ae_gain,
        )
        .expect("tile render with ae_gain");
    assert_eq!((tw, th), (side, side), "tile output dims");

    let fw = full.width as usize;
    let mut diff_lanes = 0usize;
    let mut max_abs_diff = 0.0f32;
    for ty in 0..side as usize {
        for tx in 0..side as usize {
            let fi = (src_y as usize + ty) * fw + (src_x as usize + tx);
            let fp = full.pixels[fi];
            for c in 0..3 {
                let expect = fp[c];
                let got = tile_f32[(ty * side as usize + tx) * 4 + c];
                if expect.to_bits() != got.to_bits() {
                    diff_lanes += 1;
                    let d = (expect - got).abs();
                    if d > max_abs_diff {
                        max_abs_diff = d;
                    }
                }
            }
        }
    }
    eprintln!(
        "tile-vs-full auto-exposure parity: {} differing lanes of {}, max abs diff {}",
        diff_lanes,
        (side * side * 3),
        max_abs_diff,
    );
    assert_eq!(
        diff_lanes, 0,
        "tile diverges from full chain with AutoExposure=On: {} lanes differ \
         (max abs diff {})",
        diff_lanes, max_abs_diff
    );
}

/// #1167 regression: `ae_gain = 1.0` through the new
/// `_and_wb_anchor_and_ae_gain_f32` entry must reproduce today's tile output
/// bit-for-bit — adding the AE-gain parameter must not perturb any existing
/// caller that doesn't pass a real gain. Compares directly against the
/// existing `_and_wb_anchor_f32` entry (which never threads AE at all), so a
/// regression here means the new code path diverges from the shipped one
/// even at the identity gain.
#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn tile_ae_gain_one_matches_existing_tile_output() {
    let path = crate::test_support::fixtures::require_raw("test_0002.dng");
    let bytes = std::fs::read(&path).expect("read raw");
    let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode");
    let model = AdjustmentModel::default();
    let rect = TileRect {
        src_x: 1024,
        src_y: 1024,
        src_w: 512,
        src_h: 512,
        out_w: 512,
        out_h: 512,
    };
    let (w0, h0, existing) = render_scene_linear_tile_from_raw_with_quality_and_wb_anchor_f32(
        &raw,
        &model,
        rect,
        RenderQuality::Full,
        None,
    )
    .expect("existing tile entry");
    let (w1, h1, with_gain_one) =
        render_scene_linear_tile_from_raw_with_quality_and_wb_anchor_and_ae_gain_f32(
            &raw,
            &model,
            rect,
            RenderQuality::Full,
            None,
            1.0,
        )
        .expect("ae_gain=1.0 tile entry");
    assert_eq!((w0, h0), (w1, h1), "dims must match");
    assert_eq!(
        existing, with_gain_one,
        "ae_gain=1.0 must reproduce today's tile output bit-for-bit"
    );
}

/// Acceptance test for the #1725 tile-refine WB contract fix (the
/// "horizontal band" symptom).
///
/// Simulates the app's unedited-open state: no XMP sidecar, so
/// `model.temperature`/`model.tint` are hydrated to the image's as-shot
/// `(cct, tint)` (the estimator's output — Fix A), exactly matching
/// `EditSession+Hydration.swift`'s `initialModel`. Renders the SAME
/// source region two ways:
///
/// 1. **Scene-chain path** (`pipeline::apply_scene_linear_chain`, the
///    Rust equivalent of the GPU-live per-tick FFI entry): decode the
///    region at the DEFAULT model (6500 K / 0 tint — matching
///    `RawImageCache`'s `xmpPath: nil` open / `sidecar=nil` decode),
///    pack to fp16, then run the chain with `model.temperature/tint =
///    (asShotCCT, asShotTint)` and `decoded_temp/tint = (asShotCCT,
///    asShotTint)` — the "unedited open" case where slider == as-shot.
/// 2. **Tile path** (`render_scene_linear_tile_from_raw_with_quality_and_wb_anchor`):
///    same source region, same `model.temperature/tint = (asShotCCT,
///    asShotTint)`, with `decoded_wb_anchor = Some((asShotCCT,
///    asShotTint))` — the SAME anchor the scene-chain path used.
///
/// Both paths should render (approximately) IDENTITY WB relative to the
/// 6500K-decoded buffer, so their channel ratios must match within 0.5%
/// — the acceptance bound the ticket specifies. Before this fix, the tile
/// path applied `model.temperature/tint` ABSOLUTELY via `resolve_wb`
/// instead of as a delta, so it would diverge from the scene-chain output
/// by the full as-shot WB matrix (measured up to ~23% per-channel in the
/// probe that diagnosed this ticket) — the visible band between the
/// tile-refined region and the live GPU frame.
#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn tile_wb_anchor_matches_scene_chain_on_unedited_open() {
    use crate::color::dcp::estimate_as_shot_cct_tint;
    use crate::pipeline::fp16::f16_bits_to_f32;

    let path = crate::test_support::fixtures::require_raw("test_0002.dng");
    let bytes = std::fs::read(&path).expect("read raw");
    let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode");

    // Fix A's estimator output — same call the app's cold-open hydration
    // would use for a fresh (no-sidecar) EditSession.
    let (as_shot_cct, as_shot_tint) =
        estimate_as_shot_cct_tint(&raw).expect("estimate as-shot cct/tint");

    // Unedited-open model: temperature/tint hydrated to as-shot, no other
    // sliders touched (matches `EditSession+Hydration.initialModel` with
    // `loadedModel == nil`).
    let model = AdjustmentModel {
        temperature: as_shot_cct,
        tint: as_shot_tint,
        ..AdjustmentModel::default()
    };

    let (src_x, src_y, side) = (1024u32, 1024u32, 512u32);

    // --- Path 1: scene-chain (GPU-live equivalent) ---
    // Decode at the DEFAULT model (6500K/0) — matches a fresh
    // `RawImageCache`/`sharedDecode` open with no sidecar.
    let decoded = crate::pipeline::develop_scene_linear_from_raw_with_quality(
        &raw,
        &AdjustmentModel::default(),
        RenderQuality::Full,
    )
    .expect("base decode at default WB");
    let dw = decoded.width as usize;
    let mut region_fp16: Vec<u16> = Vec::with_capacity((side * side * 4) as usize);
    for ty in 0..side as usize {
        for tx in 0..side as usize {
            let p = decoded.pixels[(src_y as usize + ty) * dw + (src_x as usize + tx)];
            region_fp16.push(f32_to_f16_bits(p[0]));
            region_fp16.push(f32_to_f16_bits(p[1]));
            region_fp16.push(f32_to_f16_bits(p[2]));
            region_fp16.push(f32_to_f16_bits(1.0));
        }
    }
    let chain_out = crate::pipeline::apply_scene_linear_chain(
        &region_fp16,
        side,
        side,
        &model,
        &crate::pipeline::ChainOptions {
            decoded_temp: as_shot_cct,
            decoded_tint: as_shot_tint,
            // skip_agx: stay in scene-linear, matching the tile path's output space
            skip_agx: true,
            noise_profile: raw.noise_profile.as_deref(),
            iso: raw.iso,
            ..crate::pipeline::ChainOptions::default()
        },
    )
    .expect("scene-chain apply");

    // --- Path 2: tile path with the SAME anchor ---
    let (tw, th, tile_fp16) = render_scene_linear_tile_from_raw_with_quality_and_wb_anchor(
        &raw,
        &model,
        TileRect {
            src_x,
            src_y,
            src_w: side,
            src_h: side,
            out_w: side,
            out_h: side,
        },
        RenderQuality::Full,
        Some((as_shot_cct, as_shot_tint)),
    )
    .expect("tile render with wb anchor");
    assert_eq!((tw, th), (side, side), "tile output dims");

    // Compare per-pixel channel RATIOS (not raw values — the two paths
    // start from independently-produced buffers of the same underlying
    // decode, so absolute-value bit-equality isn't the contract; the
    // acceptance bound is specifically about WB agreement). Skip
    // near-black pixels where a ratio is numerically unstable. Reuses the
    // crate's own `f16_bits_to_f32` (used by `apply_scene_linear_chain`
    // itself to unpack its input) rather than a second hand-rolled decoder.
    let n = (side * side) as usize;
    let mut max_rel_err = 0.0_f32;
    let mut compared = 0usize;
    for i in 0..n {
        let c = [
            f16_bits_to_f32(chain_out[i * 4]),
            f16_bits_to_f32(chain_out[i * 4 + 1]),
            f16_bits_to_f32(chain_out[i * 4 + 2]),
        ];
        let t = [
            f16_bits_to_f32(tile_fp16[i * 4]),
            f16_bits_to_f32(tile_fp16[i * 4 + 1]),
            f16_bits_to_f32(tile_fp16[i * 4 + 2]),
        ];
        // Use green as the reference channel for a ratio comparison
        // (channel RATIOS is what a WB mismatch perturbs; overall
        // brightness differences from other stages are not the target
        // of this test since both paths run the same no-op-default model
        // apart from WB).
        if c[1] < 0.02 || t[1] < 0.02 {
            continue; // near-black: ratio numerically unstable
        }
        compared += 1;
        for ch in [0usize, 2usize] {
            let rb_chain = c[ch] / c[1];
            let rb_tile = t[ch] / t[1];
            let rel_err = (rb_chain - rb_tile).abs() / rb_chain.abs().max(1e-6);
            if rel_err > max_rel_err {
                max_rel_err = rel_err;
            }
        }
    }
    assert!(
        compared > n / 2,
        "too few comparable pixels: {}/{}",
        compared,
        n
    );
    eprintln!(
        "tile-vs-scene-chain WB-anchor parity: max per-channel ratio rel err = {:.5} over {} pixels",
        max_rel_err, compared
    );
    assert!(
        max_rel_err <= 0.005,
        "tile path WB contract diverges from scene-chain by {:.3}% (want <=0.5%) — \
         the #1725 band regression",
        max_rel_err * 100.0
    );
}
