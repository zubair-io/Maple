//! Hot/dead-pixel suppression tests (#1106, tone/zoom design spec § 10.6).

#![cfg(test)]

use super::*;

/// Canonical X-Trans tile (Fuji layout used by rawler for the X-T3):
/// 8 R / 20 G / 8 B per 6×6. Channel codes 0=R 1=G 2=B.
const XTRANS: [u8; 36] = [
    1, 0, 2, 1, 2, 0, //
    2, 1, 1, 0, 1, 1, //
    0, 1, 1, 2, 1, 1, //
    1, 2, 0, 1, 0, 2, //
    0, 1, 1, 2, 1, 1, //
    2, 1, 1, 0, 1, 1, //
];

/// Build a uniform mosaic at `value` for `cfa` (only the CFA channel of
/// each site is populated, like `linearize::sensor_linearize`).
fn uniform_mosaic(w: u32, h: u32, value: f32, cfa: CfaPattern) -> Image {
    let mut img = Image::new(w, h, ColorSpace::CameraNativeMosaic);
    for y in 0..h {
        for x in 0..w {
            let c = cfa.color_at(x, y) as usize;
            img.pixels[(y * w + x) as usize][c] = value;
        }
    }
    img
}

fn site(img: &Image, x: u32, y: u32, cfa: CfaPattern) -> f32 {
    img.pixels[(y * img.width + x) as usize][cfa.color_at(x, y) as usize]
}

fn set_site(img: &mut Image, x: u32, y: u32, cfa: CfaPattern, v: f32) {
    let w = img.width;
    img.pixels[(y * w + x) as usize][cfa.color_at(x, y) as usize] = v;
}

#[test]
fn off_is_bit_identical_skip() {
    let cfa = CfaPattern::Rggb;
    let mut img = uniform_mosaic(12, 12, 0.3, cfa);
    set_site(&mut img, 6, 6, cfa, 1.0); // an obvious hot pixel
    let before = img.pixels.clone();
    apply(&mut img, cfa, HotPixelSuppressionMode::Off);
    assert_eq!(img.pixels, before, "Off must be a bit-identical skip");
}

#[test]
fn uniform_field_is_bit_exact_identity_when_on() {
    // The grey-card gate: `v > 2v + 0.02` and `v < 0.25v` are impossible
    // on a uniform field, so nothing is flagged and nothing is rewritten.
    for cfa in [
        CfaPattern::Rggb,
        CfaPattern::Bggr,
        CfaPattern::Grbg,
        CfaPattern::Gbrg,
        CfaPattern::XTrans(XTRANS),
    ] {
        for &v in &[0.0f32, 0.001, 0.18, 1.0] {
            let mut img = uniform_mosaic(13, 13, v, cfa);
            let before = img.pixels.clone();
            apply(&mut img, cfa, HotPixelSuppressionMode::On);
            assert_eq!(img.pixels, before, "uniform {v} must be identity ({cfa:?})");
        }
    }
}

#[test]
fn hot_pixel_is_replaced_with_neighborhood_median() {
    for cfa in [CfaPattern::Rggb, CfaPattern::Gbrg] {
        let mut img = uniform_mosaic(12, 12, 0.2, cfa);
        set_site(&mut img, 6, 6, cfa, 0.95); // 0.95 > 2·0.2 + 0.02
        apply(&mut img, cfa, HotPixelSuppressionMode::On);
        assert_eq!(
            site(&img, 6, 6, cfa),
            0.2,
            "hot site must take the median ({cfa:?})"
        );
        // And nothing else moved.
        for y in 0..12 {
            for x in 0..12 {
                if (x, y) == (6, 6) {
                    continue;
                }
                assert_eq!(site(&img, x, y, cfa), 0.2, "({x},{y}) must be untouched");
            }
        }
    }
}

#[test]
fn dead_pixel_is_replaced() {
    let cfa = CfaPattern::Rggb;
    let mut img = uniform_mosaic(12, 12, 0.4, cfa);
    set_site(&mut img, 5, 7, cfa, 0.01); // 0.01 < 0.25·0.4
    apply(&mut img, cfa, HotPixelSuppressionMode::On);
    assert_eq!(
        site(&img, 5, 7, cfa),
        0.4,
        "stuck-low site must take the median"
    );
}

#[test]
fn stuck_low_in_true_black_is_not_flagged() {
    // min(neighbors) = 0 → threshold 0 → v < 0 impossible. A black frame
    // with one black pixel stays bit-identical.
    let cfa = CfaPattern::Bggr;
    let mut img = uniform_mosaic(10, 10, 0.0, cfa);
    let before = img.pixels.clone();
    apply(&mut img, cfa, HotPixelSuppressionMode::On);
    assert_eq!(img.pixels, before);
}

#[test]
fn specular_highlight_cluster_is_preserved() {
    // A genuine specular covers several same-color sites — max(neighbors)
    // tracks it, so the conservative threshold must NOT flag it. Paint a
    // 5×5 block at 1.0 over a 0.1 background; the block's interior sites
    // all see same-color neighbors at 1.0.
    let cfa = CfaPattern::Rggb;
    let mut img = uniform_mosaic(16, 16, 0.1, cfa);
    for y in 5..10 {
        for x in 5..10 {
            set_site(&mut img, x, y, cfa, 1.0);
        }
    }
    let center_before = site(&img, 7, 7, cfa);
    apply(&mut img, cfa, HotPixelSuppressionMode::On);
    assert_eq!(
        site(&img, 7, 7, cfa),
        center_before,
        "interior of a specular cluster must be preserved"
    );
}

#[test]
fn smooth_gradient_is_untouched() {
    let cfa = CfaPattern::Grbg;
    let w = 24u32;
    let h = 16u32;
    let mut img = Image::new(w, h, ColorSpace::CameraNativeMosaic);
    for y in 0..h {
        for x in 0..w {
            let c = cfa.color_at(x, y) as usize;
            img.pixels[(y * w + x) as usize][c] = 0.05 + 0.9 * (x as f32) / (w as f32 - 1.0);
        }
    }
    let before = img.pixels.clone();
    apply(&mut img, cfa, HotPixelSuppressionMode::On);
    assert_eq!(img.pixels, before, "a smooth ramp must not be modified");
}

#[test]
fn xtrans_hot_pixel_is_replaced() {
    let cfa = CfaPattern::XTrans(XTRANS);
    let mut img = uniform_mosaic(18, 18, 0.25, cfa);
    set_site(&mut img, 9, 9, cfa, 1.0); // > 2·0.25 + 0.02
    apply(&mut img, cfa, HotPixelSuppressionMode::On);
    assert_eq!(
        site(&img, 9, 9, cfa),
        0.25,
        "X-Trans hot site must take the median"
    );
}

#[test]
fn every_phase_has_at_least_eight_same_color_neighbors() {
    // Bayer 5×5: exactly 8 same-color neighbors for R/B sites and 12 for
    // G (green occupies every (x+y)-odd site, so all 12 parity-preserving
    // offsets in the window hit green); X-Trans 7×7: ≥ 8 for every one of
    // the 36 phases. This pins the window-radius choice.
    for cfa in [
        CfaPattern::Rggb,
        CfaPattern::Bggr,
        CfaPattern::Grbg,
        CfaPattern::Gbrg,
    ] {
        let (period, _, table) = same_color_offsets(cfa);
        assert_eq!(period, 2);
        for cy in 0..2u32 {
            for cx in 0..2u32 {
                let cell = (cy as usize) * 2 + cx as usize;
                let expected = if cfa.color_at(cx, cy) == 1 { 12 } else { 8 };
                assert_eq!(
                    table[cell].len(),
                    expected,
                    "Bayer phase ({cx},{cy}) of {cfa:?} should have {expected}"
                );
            }
        }
    }
    let (_, _, table) = same_color_offsets(CfaPattern::XTrans(XTRANS));
    for (cell, offs) in table.iter().enumerate() {
        assert!(
            offs.len() >= 8,
            "X-Trans phase {cell} has only {}",
            offs.len()
        );
    }
}

#[test]
fn corner_sites_with_clipped_window_are_safe() {
    // Corners lose most of the window to the border; the stage must
    // neither panic nor mis-flag there.
    let cfa = CfaPattern::Rggb;
    let mut img = uniform_mosaic(6, 6, 0.3, cfa);
    set_site(&mut img, 0, 0, cfa, 1.0); // hot corner
    apply(&mut img, cfa, HotPixelSuppressionMode::On);
    assert_eq!(
        site(&img, 0, 0, cfa),
        0.3,
        "hot corner must still be replaced"
    );
}

#[test]
fn deterministic_across_thread_counts() {
    let cfa = CfaPattern::Rggb;
    // Noisy-ish content with several defects.
    let base = {
        let mut img = uniform_mosaic(40, 30, 0.2, cfa);
        set_site(&mut img, 3, 3, cfa, 1.0);
        set_site(&mut img, 20, 11, cfa, 0.9);
        set_site(&mut img, 33, 22, cfa, 0.001);
        img
    };
    let run = |threads: usize| -> Vec<[f32; 3]> {
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .build()
            .expect("build pool");
        let mut img = Image {
            width: base.width,
            height: base.height,
            pixels: base.pixels.clone(),
            space: base.space,
        };
        pool.install(|| apply(&mut img, cfa, HotPixelSuppressionMode::On));
        img.pixels
    };
    assert_eq!(
        run(1),
        run(8),
        "output must be byte-identical across thread counts"
    );
}

#[test]
fn median_midpoint_for_even_counts() {
    let mut v = [0.1f32, 0.3, 0.2, 0.4];
    assert_eq!(median_in_place(&mut v), 0.25);
    let mut v = [0.5f32, 0.1, 0.3];
    assert_eq!(median_in_place(&mut v), 0.3);
}
