#![cfg(test)]

use super::super::develop_sized::develop_scene_linear_sized_from_raw_with_quality;
use super::super::downsample::downsample_image_area;
use super::*;

/// `effective_quality_divisor` must return 1 for every CFA path
/// whose post-demosaic buffer is full-resolution at Preview
/// quality. That set is wider than just X-Trans: LinearRaw DNGs
/// (`CfaPattern::LinearRgb`) skip the mosaic path entirely via
/// `linearraw_to_camera_rgb` and likewise produce a full-res
/// buffer for every `RenderQuality` variant. Returning 2 for
/// LinearRgb Preview would mis-map any DNG-recommended crop
/// rectangle (`crop_to_default`) by a factor of 2.
#[test]
fn effective_quality_divisor_full_res_paths_return_one() {
    use crate::image::CfaPattern;
    // X-Trans: Preview routes to full-res xtrans_bilinear → 1.
    let xt = CfaPattern::XTrans([1u8; 36]);
    assert_eq!(effective_quality_divisor(RenderQuality::Preview, xt), 1);
    assert_eq!(effective_quality_divisor(RenderQuality::Full, xt), 1);
    assert_eq!(effective_quality_divisor(RenderQuality::Amaze, xt), 1);
    // LinearRaw: skips mosaic entirely → 1 at every quality.
    assert_eq!(
        effective_quality_divisor(RenderQuality::Preview, CfaPattern::LinearRgb),
        1,
        "LinearRgb Preview must use divisor=1 — the path is full-res, \
         a divisor of 2 mis-maps DefaultCrop coords"
    );
    assert_eq!(
        effective_quality_divisor(RenderQuality::Full, CfaPattern::LinearRgb),
        1
    );
    assert_eq!(
        effective_quality_divisor(RenderQuality::Amaze, CfaPattern::LinearRgb),
        1
    );
    // Bayer (the only path that *does* halve at Preview) keeps the
    // expected behaviour.
    assert_eq!(
        effective_quality_divisor(RenderQuality::Preview, CfaPattern::Rggb),
        2
    );
    assert_eq!(
        effective_quality_divisor(RenderQuality::Full, CfaPattern::Rggb),
        1
    );
}

/// Pin per-fixture full-quality output dimensions against the
/// DNG-recommended render rectangle (`raw.crop_rect` or, when that's
/// `None`, the full sensor). Regression test for ticket #375 — before
/// the crop stage, every fixture rendered at sensor dimensions, which
/// for Fuji X-Trans (test_0005 / test_0012) was 2× the declared image
/// area and for Canon DNG (test_0007) included a visible ~80-px black
/// border. After the fix, the full-image render path returns the
/// camera-recommended dims (oriented). `ignore`d without
/// `--features fixtures`; with the feature every listed fixture must be
/// present (fail-closed, #1082).
///
/// Expected dims = `raw.crop_rect` (or width × height when None),
/// with the orientation tag applied: portrait-shot Canon CR2
/// (test_0003, orientation 8) produces a portrait output.
#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn render_dims_match_crop_rect_per_fixture() {
    let fixtures: &[(&str, u32, u32, &str)] = &[
        // (filename, expected w, expected h, note)
        // test_0001 RW2 (Panasonic LX2): rawler crop 4224×2376
        ("test_0001.RAW", 4224, 2376, "Panasonic crop"),
        // test_0003 CR2 (Canon 5DS R, portrait): crop 8688×5792
        //   -> orientation 8 (Rotate270) -> swap -> 5792×8688
        ("test_0003.CR2", 5792, 8688, "Canon portrait crop + orient"),
        // test_0005 RAF (Fuji X-Trans): crop 8256×6192 (NOT 9216×6210)
        ("test_0005.RAF", 8256, 6192, "Fuji X-Trans crop"),
        // test_0007 DNG (Canon DNG): crop 5760×3840 (NOT 5920×3950)
        ("test_0007.DNG", 5760, 3840, "Canon DNG crop"),
        // test_0009 CR2 (Canon 5DM4): crop 6720×4480 (NOT 6880×4544)
        ("test_0009.CR2", 6720, 4480, "Canon 5DM4 crop"),
        // test_0012 raf (Fuji): same as test_0005
        ("test_0012.raf", 8256, 6192, "Fuji X-Trans crop (2nd)"),
        // test_0013 iPhone DNG: no crop, full 4032×3024, orientation 6 -> swap -> 3024×4032
        ("test_0013.DNG", 3024, 4032, "iPhone portrait, no crop tags"),
        // test_0017 Leica: crop 5976×3984
        ("test_0017.dng", 5976, 3984, "Leica DNG crop"),
    ];
    let model = AdjustmentModel::default();
    for (name, ew, eh, note) in fixtures {
        let path = crate::test_support::fixtures::require_raw(name);
        let bytes = std::fs::read(&path).expect("read raw");
        // Lowercase: decode_bytes uses `ext` to build a rawler hint
        // path; rawler format detection matches lowercase suffixes
        // (e.g. `RAF` vs `raf` can disambiguate Fuji decoders).
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_default();
        let raw = crate::decode::decode_bytes(&bytes, &ext).expect("decode");
        let (w, h, _) =
            crate::pipeline::render_from_raw_with_quality(&raw, &model, RenderQuality::Full)
                .expect("render");
        assert_eq!(
            (w, h),
            (*ew, *eh),
            "{} ({}): expected {}×{}, got {}×{}",
            name,
            note,
            ew,
            eh,
            w,
            h
        );
    }
}

/// M3 commutativity gate: render test_0017.dng via the original
/// late-downsample path (full-res develop, then
/// `downsample_image_area`) and the new early-downsample path
/// (`develop_scene_linear_sized_from_raw_with_quality` runs
/// downsample right after demosaic), then compare per-channel
/// f32 mean delta in scene-linear Rec.2020.
///
/// Budget: mean per-channel delta ≤ 0.005 in linear-light. The
/// expected dominant source of difference is the
/// non-commutativity of (downsample ∘ filter) vs
/// (filter ∘ downsample); for natural scenes with sharpening
/// disabled (sharpen_amount=0, nr_luminance=0, nr_color=25 with
/// radius 1 px, clarity=0, dehaze=0) this is dominated by the
/// nr_color blur and bounded by the downsample kernel's
/// low-pass character. The test explicitly disables sharpening
/// (the canonical default carries sharpen_amount=40 per #326)
/// because USM sharpening near the downsample-filter cutoff is
/// fundamentally non-commutative with downsampling and is not
/// what this commutativity gate is measuring.
///
/// `ignore`d without `--features fixtures` (#1082).
#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn early_vs_late_downsample_within_fp16_tolerance() {
    let path = crate::test_support::fixtures::require_raw("test_0017.dng");
    let bytes = std::fs::read(&path).expect("read raw");
    let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode");
    // Disable sharpening for this commutativity gate: USM sharpening's
    // non-commutativity with downsampling is well-known and is not what
    // this test is measuring.
    let model = AdjustmentModel {
        sharpen_amount: 0.0,
        ..AdjustmentModel::default()
    };
    let max_long_edge: u32 = 1500;

    // Late-downsample: full-res develop, then downsample.
    let mut late = develop_scene_linear_from_raw_with_quality(&raw, &model, RenderQuality::Preview)
        .expect("late develop");
    downsample_image_area(&mut late, max_long_edge);

    // Early-downsample: new helper runs downsample post-demosaic.
    let early = develop_scene_linear_sized_from_raw_with_quality(
        &raw,
        &model,
        RenderQuality::Preview,
        max_long_edge,
    )
    .expect("early develop");

    // Sizes must match — both end at <= max_long_edge on the long edge.
    assert_eq!(early.width, late.width, "width mismatch");
    assert_eq!(early.height, late.height, "height mismatch");
    assert_eq!(
        early.pixels.len(),
        late.pixels.len(),
        "pixel count mismatch"
    );

    let n = early.pixels.len();
    let mut sum_dr = 0.0f64;
    let mut sum_dg = 0.0f64;
    let mut sum_db = 0.0f64;
    let mut max_dr = 0.0f32;
    let mut max_dg = 0.0f32;
    let mut max_db = 0.0f32;
    for (a, b) in early.pixels.iter().zip(late.pixels.iter()) {
        let dr = (a[0] - b[0]).abs();
        let dg = (a[1] - b[1]).abs();
        let db = (a[2] - b[2]).abs();
        sum_dr += dr as f64;
        sum_dg += dg as f64;
        sum_db += db as f64;
        if dr > max_dr {
            max_dr = dr;
        }
        if dg > max_dg {
            max_dg = dg;
        }
        if db > max_db {
            max_db = db;
        }
    }
    let mean_dr = (sum_dr / n as f64) as f32;
    let mean_dg = (sum_dg / n as f64) as f32;
    let mean_db = (sum_db / n as f64) as f32;
    eprintln!(
        "early-vs-late: mean dR={:.5} dG={:.5} dB={:.5}  max dR={:.5} dG={:.5} dB={:.5}",
        mean_dr, mean_dg, mean_db, max_dr, max_dg, max_db,
    );

    // Mean per-channel delta budget. 0.005 in [0, ~5] scene-linear
    // headroom is ~0.1% of typical scene values. Held tight since the
    // `MAPLE_AGX_BASELINE_COMPENSATION_EV = 0.65` band-aid was removed
    // (commit `ba8e0ecb`); the calibration foundation (DNG WB pre-gain
    // bundle, with the per-body BE table since removed in #370) doesn't
    // inflate scene values, so the early-vs-late commutativity budget
    // stays tight.
    assert!(mean_dr < 0.005, "mean R delta {} > 0.005", mean_dr);
    assert!(mean_dg < 0.005, "mean G delta {} > 0.005", mean_dg);
    assert!(mean_db < 0.005, "mean B delta {} > 0.005", mean_db);
}

/// AMaZE should resolve finer detail than Hamilton-Adams at full
/// resolution. Renders the same Bayer DNG twice (once Full, once
/// Amaze) through the entire scene-linear chain, then for each
/// developed buffer:
///   * Computes the per-pixel green-channel gradient magnitude
///     (|dx| + |dy|) summed over the whole frame — the "high-frequency
///     energy". AMaZE's variance-driven H/V selection preserves edge
///     detail HA blurs over, so total HF energy should be
///     equal-or-greater under AMaZE.
///   * Confirms the global mean barely moves — AMaZE is a detail
///     refinement, not a tone change. The test budget allows at most
///     5% drift in mean luminance.
/// `ignore`d without `--features fixtures` (#1082).
#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn amaze_resolves_finer_detail_than_hamilton_adams() {
    let path = crate::test_support::fixtures::require_raw("test_0002.dng");
    let bytes = std::fs::read(&path).expect("read raw");
    let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode");
    let model = AdjustmentModel::default();

    let ha = develop_scene_linear_from_raw_with_quality(&raw, &model, RenderQuality::Full)
        .expect("HA develop");
    let amz = develop_scene_linear_from_raw_with_quality(&raw, &model, RenderQuality::Amaze)
        .expect("AMaZE develop");
    assert_eq!((ha.width, ha.height), (amz.width, amz.height));

    let w = ha.width as usize;
    let h = ha.height as usize;

    // Total green-channel mean — should hardly move between HA/AMaZE.
    let mean_g = |buf: &crate::image::Image| -> f64 {
        let s: f64 = buf.pixels.iter().map(|p| p[1] as f64).sum();
        s / buf.pixels.len() as f64
    };
    let m_ha = mean_g(&ha);
    let m_amz = mean_g(&amz);
    let mean_drift = ((m_amz - m_ha) / m_ha).abs();
    assert!(
        mean_drift < 0.05,
        "AMaZE shifted overall green mean by {:.3}% (HA mean = {:.4}, AMaZE = {:.4}); \
         expected ≤ 5%",
        mean_drift * 100.0,
        m_ha,
        m_amz
    );

    // High-frequency energy via the L1 gradient magnitude on the green
    // channel. We skip a 4-pixel border so AMaZE's edge-fallback
    // pixels (where it reverts to bilinear-difference) don't
    // dominate. Comparing a pure detail metric, not a per-pixel
    // ΔE — the goal is "AMaZE preserves more detail," not "AMaZE
    // shifts color."
    let hf_energy = |buf: &crate::image::Image| -> f64 {
        let mut sum = 0.0_f64;
        for y in 4..h - 4 {
            for x in 4..w - 4 {
                let i = y * w + x;
                let g = buf.pixels[i][1];
                let dx = (buf.pixels[i + 1][1] - buf.pixels[i - 1][1]).abs();
                let dy = (buf.pixels[i + w][1] - buf.pixels[i - w][1]).abs();
                let _ = g;
                sum += (dx + dy) as f64;
            }
        }
        sum
    };
    let hf_ha = hf_energy(&ha);
    let hf_amz = hf_energy(&amz);
    eprintln!(
        "amaze vs hamilton-adams: mean_g HA={:.4} AMaZE={:.4} (drift={:.3}%); \
               HF energy HA={:.0} AMaZE={:.0} (ratio={:.3}×)",
        m_ha,
        m_amz,
        mean_drift * 100.0,
        hf_ha,
        hf_amz,
        hf_amz / hf_ha
    );

    // AMaZE's HF energy must be at least as high as HA's. The 0.99
    // floor (1% slack) absorbs tiny per-pixel noise differences from
    // AMaZE's adaptive median bound on saturated edges, which can
    // very-slightly suppress one HA-only zipper. The expected
    // direction is hf_amz > hf_ha; in practice the ratio sits well
    // above 1.0 on natural fixtures.
    assert!(
        hf_amz / hf_ha >= 0.99,
        "AMaZE HF energy {:.0} below HA HF energy {:.0} (ratio {:.3} < 0.99) — \
         AMaZE should preserve at least as much green-channel detail as HA",
        hf_amz,
        hf_ha,
        hf_amz / hf_ha
    );
}
