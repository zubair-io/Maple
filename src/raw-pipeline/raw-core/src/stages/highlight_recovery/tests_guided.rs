use super::*;

const NEUTRAL_DAYLIGHT: [f32; 3] = [0.5, 1.0, 0.7];
const WARM: [f32; 3] = [0.9, 0.7, 0.3];
const COOL: [f32; 3] = [0.3, 0.9, 0.9];
const WARM_CLIPPED: [f32; 3] = [1.8, 1.0, 0.6];

fn recover(img: &mut Image) {
    apply(
        img,
        HighlightRecoveryMode::ChromaticAdaptation,
        NEUTRAL_DAYLIGHT,
        0.0,
    );
}

#[test]
fn large_blown_region_recovers_chromaticity_from_distant_witnesses() {
    // 15×15 G-clipped block in a warm field: the center pixel's 7×7 window
    // is fully clipped (tier 1 finds nothing), but its cell's gather reaches
    // the warm surround at full confidence. The block is chromaticity-
    // consistent with the surround (same R/B, true G = 1.4), so the
    // reconstruction must recover the true value — not the pre-#1690
    // neutral fallback (G = 1.8).
    let mut img = Image::new(41, 41, ColorSpace::CameraNativeLinearRgb);
    img.pixels.fill(WARM);
    for y in 13..28 {
        for x in 13..28 {
            img.pixels[y * 41 + x] = WARM_CLIPPED;
        }
    }
    recover(&mut img);
    let p = img.pixels[20 * 41 + 20];
    assert_eq!(p[0], 1.8);
    assert_eq!(p[2], 0.6);
    assert!(
        p[1] < 1.8,
        "must improve on the neutral fallback, got {p:?}"
    );
    assert!(
        (p[1] - 1.4).abs() < 1e-4,
        "G should recover the true 1.4, got {}",
        p[1]
    );
    let out_rg = p[0] / p[1];
    assert!(
        (out_rg - 1.2857).abs() < 0.01,
        "R/G should match the warm surround (1.286), got {out_rg}"
    );
}

#[test]
fn hue_edge_downweights_foreign_witnesses() {
    // Split surround: warm left, cool right, warm-like clipped block on the
    // boundary. The cool witnesses must contribute ~nothing: the result must
    // sit with the all-warm control, far from the all-cool one.
    let surround = |x: usize, warm: [f32; 3], cool: [f32; 3]| {
        if x < 15 {
            warm
        } else {
            cool
        }
    };
    let mut test = Image::new(31, 31, ColorSpace::CameraNativeLinearRgb);
    let mut all_warm = Image::new(31, 31, ColorSpace::CameraNativeLinearRgb);
    let mut all_cool = Image::new(31, 31, ColorSpace::CameraNativeLinearRgb);
    let warm_bg = [0.9, 0.45, 0.3];
    let cool_bg = [0.3, 0.9, 0.9];
    for y in 0..31 {
        for x in 0..31 {
            let in_block = (11..20).contains(&x) && (11..20).contains(&y);
            test.pixels[y * 31 + x] = if in_block {
                WARM_CLIPPED
            } else {
                surround(x, warm_bg, cool_bg)
            };
            all_warm.pixels[y * 31 + x] = if in_block { WARM_CLIPPED } else { warm_bg };
            all_cool.pixels[y * 31 + x] = if in_block { WARM_CLIPPED } else { cool_bg };
        }
    }
    recover(&mut test);
    recover(&mut all_warm);
    recover(&mut all_cool);
    let g = test.pixels[15 * 31 + 15][1];
    let g_warm = all_warm.pixels[15 * 31 + 15][1];
    let g_cool = all_cool.pixels[15 * 31 + 15][1];
    assert_eq!(test.pixels[15 * 31 + 15][0], 1.8);
    assert_eq!(test.pixels[15 * 31 + 15][2], 0.6);
    assert!(
        g < g_cool - 0.2,
        "cool witnesses leaked in: test G = {g}, all-cool G = {g_cool}"
    );
    assert!(
        g > g_warm && g < 1.5,
        "expected warm-dominated pull-down, got {g} (warm control {g_warm})"
    );
}

#[test]
fn warm_scene_fallback_preserves_cast_without_local_support() {
    // 101×101 clipped block: the center pixel's widest ring (95 px) still
    // lands fully inside the block, so tier 3 fires. The fallback must blend
    // toward the warm scene median (G = 1.6), not the neutral 1.8.
    let mut img = Image::new(131, 131, ColorSpace::CameraNativeLinearRgb);
    img.pixels.fill(WARM);
    for y in 15..116 {
        for x in 15..116 {
            img.pixels[y * 131 + x] = WARM_CLIPPED;
        }
    }
    recover(&mut img);
    let p = img.pixels[65 * 131 + 65];
    assert_eq!(p[0], 1.8);
    assert_eq!(p[2], 0.6);
    assert!(
        (p[1] - 1.6).abs() < 1e-4,
        "tier-3 fallback should be ≈ 1.6, got {}",
        p[1]
    );
    let out_rg = p[0] / p[1];
    assert!(
        out_rg > 1.0 && out_rg < 1.286,
        "warmth partially preserved, got R/G = {out_rg}"
    );
}

#[test]
fn scene_median_samples_the_whole_region_not_the_top() {
    // 640x640 at stride 8 holds 6400 grid candidates: a raster-ordered cap
    // stops after the top ~51 sampled rows, so a warm top third reads as
    // the whole scene. Even decimation keeps samples from every row, and
    // with warm on top and cool below the median must follow the cool
    // majority on every channel.
    let (w, h) = (640usize, 640usize);
    let mut img = Image::new(w as u32, h as u32, ColorSpace::CameraNativeLinearRgb);
    for y in 0..h {
        for x in 0..w {
            img.pixels[y * w + x] = if y < h / 3 { WARM } else { COOL };
        }
    }
    let mask = vec![0u8; w * h];
    let median =
        scene_median(&img, &mask, 0, 0, w as i32, h as i32).expect("unclipped samples exist");
    assert_eq!(
        median, COOL,
        "top-biased scene prior: median {median:?} follows the warm top third"
    );
}

#[test]
fn scene_median_keeps_sparse_evidence_in_a_large_clipped_region() {
    // A 640x640 region clipped everywhere except one row at y = 8: the
    // stride-8 grid sees that row, so the prior must come from it rather
    // than collapse to `None` (neutral).
    let (w, h) = (640usize, 640usize);
    let mut img = Image::new(w as u32, h as u32, ColorSpace::CameraNativeLinearRgb);
    img.pixels.fill(WARM_CLIPPED);
    let mut mask = vec![1u8; w * h];
    for x in 0..w {
        img.pixels[8 * w + x] = COOL;
        mask[8 * w + x] = 0;
    }
    assert_eq!(
        scene_median(&img, &mask, 0, 0, w as i32, h as i32),
        Some(COOL)
    );
}

#[test]
fn fully_blown_frame_keeps_the_exact_neutral_fallback() {
    // No unclipped pixel anywhere: no witnesses, no scene prior. The output
    // must be bit-exact today's neutral fallback.
    let mut img = Image::new(5, 5, ColorSpace::CameraNativeLinearRgb);
    img.pixels.fill(WARM_CLIPPED);
    recover(&mut img);
    for p in &img.pixels {
        assert_eq!(*p, [1.8, 1.8, 0.6]);
    }
}

#[test]
fn tier1_ignores_distant_content_and_scene_prior() {
    // 48 warm witnesses inside the 7×7 window, cool field beyond it. Tier 1
    // must resolve exactly as pre-#1690, deaf to the rings and the scene.
    let mut img = Image::new(21, 21, ColorSpace::CameraNativeLinearRgb);
    img.pixels.fill([0.3, 0.9, 0.9]);
    for y in 7..14 {
        for x in 7..14 {
            img.pixels[y * 21 + x] = [0.9, 0.45, 0.3];
        }
    }
    img.pixels[10 * 21 + 10] = WARM_CLIPPED;
    recover(&mut img);
    let p = img.pixels[10 * 21 + 10];
    let expected = 1.8 + 48.0 / 49.0 * (0.9 - 1.8);
    assert!(
        (p[1] - expected).abs() < 1e-6,
        "tier-1 drifted: G = {}, expected {expected}",
        p[1]
    );
}

#[test]
fn chroma_weight_matches_on_chromaticity_not_level() {
    // Same chromaticity at triple the level: weight ~1 (a bright highlight
    // draws on its dimmer surround).
    let w = chroma_weight([0.9, 0.45, 0.3], 0.6, [1.8, 1.0, 0.6], 1.2, 0b010, 2);
    assert!((w - 1.0).abs() < 1e-6, "same-chroma weight = {w}");
    // Across a hue edge: weight ~0 (squared inverse: 1/(1+35·2)² ≈ 2e-4).
    let w = chroma_weight([0.3, 0.9, 0.9], 0.6, [1.8, 1.0, 0.6], 1.2, 0b010, 2);
    assert!(w < 1e-3, "cross-edge weight = {w}");
    // Single known channel: unweighted.
    let w = chroma_weight([0.1, 0.2, 0.3], 0.1, [2.0, 1.0, 0.1], 0.1, 0b011, 1);
    assert_eq!(w, 1.0);
}

#[test]
fn skip_grid_proves_empty_windows() {
    // 64×64 all clipped except pixel (0,0): only cell (0,0) and its
    // dilation ring may contain a witness.
    let mut mask = vec![0b111u8; 64 * 64];
    mask[0] = 0;
    let grid = SkipGrid::build(&mask, 64, 64);
    assert!(grid.may_have_witness(5, 5));
    assert!(grid.may_have_witness(20, 20));
    assert!(!grid.may_have_witness(63, 63));
    assert!(!grid.may_have_witness(40, 8));
}

/// Tier-2/3 perf companion to `tests::perf_chromatic_adaptation_2mp_under_4ms`:
/// the same 2 MP viewport, but the clipped pixels form one large partially
/// clipped block so the guided tiers actually fire. Cost scales with clip
/// count — the pre-existing tier-1 scans dominate (measured: ~2/3 of the
/// total is tier-1 work that predates #1690) — so this carries its own
/// budget: 12 ms at ~6 ms measured, the same ~2× headroom ratio as the
/// sparse test, which keeps guarding the reference workload at 4 ms.
/// Skipped in debug.
#[test]
#[cfg(not(debug_assertions))]
#[ignore = "reference-machine benchmark; run explicitly with --release --ignored"]
fn perf_large_blown_block_2mp_release() {
    let (w, h) = (1600u32, 1250u32);
    let mut img = Image::new(w, h, ColorSpace::CameraNativeLinearRgb);
    img.pixels.fill(WARM);
    for y in 425..825 {
        for x in 600..1000 {
            img.pixels[(y * w + x) as usize] = WARM_CLIPPED;
        }
    }
    let t0 = std::time::Instant::now();
    recover(&mut img);
    let elapsed = t0.elapsed();
    eprintln!("highlight_recovery tiers 2-3 on 2 MP + 400×400 block: {elapsed:?}");
    assert!(
        elapsed < std::time::Duration::from_millis(12),
        "perf budget exceeded: {elapsed:?} > 12 ms"
    );
}
