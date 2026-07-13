#![cfg(test)]
//! Tests for the tile-rendering entry — output shape, fp16 packing, and
//! tile-vs-full-chain parity (including the #1725 WB-anchor acceptance
//! test). Split out of the sibling `tests.rs` (which retains the
//! rejection-guard tests) so both files stay under the file-size budget
//! (PR #1730), following the same `pipeline/develop/tests.rs` sibling
//! pattern.

use super::*;

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
        TileRect {
            src_x: src_x,
            src_y: src_y,
            src_w: src_w,
            src_h: src_h,
            out_w: out_w,
            out_h: out_h,
        },
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
        TileRect {
            src_x: 1025,
            src_y: 1025,
            src_w: 512,
            src_h: 512,
            out_w: 256,
            out_h: 256,
        },
        RenderQuality::Full,
    )
    .expect("odd coords tile");
    let (w_even, h_even, _) = render_scene_linear_tile_from_raw_with_quality(
        &raw,
        &model,
        TileRect {
            src_x: 1024,
            src_y: 1024,
            src_w: 512,
            src_h: 512,
            out_w: 256,
            out_h: 256,
        },
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
        TileRect {
            src_x: src_x,
            src_y: src_y,
            src_w: side,
            src_h: side,
            out_w: side,
            out_h: side,
        },
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

/// #1931: the HSL 8-band stage was silently omitted from the tile develop
/// chain, so a deep-zoom tile with any non-default HSL adjustment diverged
/// from the full-resolution render. Same tile-vs-full bit-parity gate as
/// `tile_matches_full_chain_with_non_default_tone_curve`, driven by a
/// non-default HSL model. HSL is a pointwise Oklab op (no neighbour gather),
/// so bit-equality is the contract. Fixture-gated identically.
#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn tile_matches_full_chain_with_non_default_hsl() {
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
        // Non-default across three bands and all three channel kinds.
        hue_adjustment_blue: -30.0,
        saturation_adjustment_red: 50.0,
        luminance_adjustment_green: 40.0,
        ..AdjustmentModel::default()
    };

    // Self-check: the HSL model must actually perturb pixels, or this parity
    // gate would pass trivially if `hsl` were dropped from BOTH chains.
    {
        let mut probe =
            crate::image::Image::new(3, 1, crate::image::ColorSpace::SceneLinearRec2020);
        probe.pixels[0] = [0.5, 0.1, 0.1]; // red band
        probe.pixels[1] = [0.1, 0.5, 0.1]; // green band
        probe.pixels[2] = [0.1, 0.1, 0.5]; // blue band
        let before = probe.pixels.clone();
        crate::stages::hsl::apply(
            &mut probe,
            &[0.0, 0.0, 0.0, 0.0, 0.0, -30.0, 0.0, 0.0],
            &[50.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            &[0.0, 0.0, 0.0, 40.0, 0.0, 0.0, 0.0, 0.0],
        );
        assert_ne!(probe.pixels, before, "test model's HSL must be non-identity");
    }

    let (src_x, src_y, side) = (1024u32, 1024u32, 512u32);
    let (tw, th, tile_fp16) = render_scene_linear_tile_from_raw_with_quality(
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
    )
    .expect("tile render");
    assert_eq!((tw, th), (side, side), "tile output dims");

    let full = crate::pipeline::develop_scene_linear_from_raw_with_quality(
        &raw,
        &model,
        RenderQuality::Full,
    )
    .expect("full develop");

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
        "tile-vs-full HSL parity: {} differing lanes of {}, max fp16 bit distance {}",
        diff_lanes,
        (side * side * 3),
        max_bit_dist,
    );
    assert_eq!(
        diff_lanes, 0,
        "tile diverges from full chain with a non-default HSL adjustment: \
         {} lanes differ (max fp16 bit distance {})",
        diff_lanes, max_bit_dist
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
