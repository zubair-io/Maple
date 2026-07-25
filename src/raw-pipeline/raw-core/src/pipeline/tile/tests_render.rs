#![cfg(test)]
//! Tests for the tile-rendering entry — output shape, fp16 packing, and
//! tile-vs-full-chain stage parity. Split out of the sibling `tests.rs`
//! (which retains the rejection-guard tests) so both files stay under the
//! file-size budget (PR #1730), following the same
//! `pipeline/develop/tests.rs` sibling pattern. The host-threaded
//! develop-anchor contract tests (#1725 WB anchor, #1167 AE gain) live in
//! the further sibling `tests_render_anchors.rs`.

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

/// #1945: the f32 tile entry shares the exact develop/geometry with the fp16
/// entry (both wrap `develop_tile_oriented_f32`) and differs only in the final
/// pack precision. Round-tripping the f32 output through `f32_to_f16_bits` must
/// reproduce the fp16 entry bit-for-bit, proving the f32 path carries strictly
/// more precision (no downcast) than — and is otherwise identical to — the
/// shipped fp16 path.
#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn f32_tile_matches_fp16_tile_after_downcast() {
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
    let (fw, fh, fp16) =
        render_scene_linear_tile_from_raw_with_quality(&raw, &model, rect, RenderQuality::Full)
            .expect("fp16 tile");
    let (w, h, f32) =
        render_scene_linear_tile_from_raw_with_quality_f32(&raw, &model, rect, RenderQuality::Full)
            .expect("f32 tile");
    assert_eq!((w, h), (fw, fh), "f32 and fp16 tile dims must match");
    assert_eq!(f32.len(), fp16.len(), "same lane count");
    for (i, (&f, &packed)) in f32.iter().zip(fp16.iter()).enumerate() {
        assert_eq!(
            f32_to_f16_bits(f),
            packed,
            "lane {i}: f32 downcast {} != fp16 {}",
            f32_to_f16_bits(f),
            packed
        );
    }
    // Sanity: the f32 buffer actually carries sub-fp16 precision on at least
    // one lane (i.e. it is NOT just fp16 values widened), else the alignment
    // would be pointless. Alpha lanes are exactly 1.0, so scan RGB only.
    use crate::pipeline::fp16::f16_bits_to_f32;
    let carries_extra_precision = f32
        .iter()
        .enumerate()
        .any(|(i, &v)| i % 4 != 3 && f16_bits_to_f32(f32_to_f16_bits(v)) != v);
    assert!(
        carries_extra_precision,
        "f32 tile should carry precision beyond fp16 on some RGB lane"
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
            &[0.0; 8],
            false,
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
