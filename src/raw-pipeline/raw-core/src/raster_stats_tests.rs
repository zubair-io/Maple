use super::*;

#[test]
fn a_flat_image_has_zero_spread() {
    let img = RasterImage::new_rgb(4, 4, vec![100; 48]);
    let stats = compute_stats(&img).unwrap();
    assert_eq!(stats.channels.len(), 3);
    let red = &stats.channels[0];
    assert_eq!((red.min, red.max), (100, 100));
    assert_eq!(red.mean, 100.0);
    assert_eq!(red.stdev, 0.0);
    assert_eq!(red.sum, 1600.0);
    assert_eq!(red.squares_sum, 160_000.0);
    assert_eq!(
        stats.entropy, 0.0,
        "one histogram bin carries no information"
    );
    assert_eq!(stats.sharpness, 0.0, "a flat field has no edges");
}

#[test]
fn min_and_max_coordinates_point_at_real_pixels() {
    // 3x1: dark, mid, bright.
    let img = RasterImage::new_rgb(3, 1, vec![0, 0, 0, 128, 128, 128, 255, 255, 255]);
    let red = &compute_stats(&img).unwrap().channels[0];
    assert_eq!((red.min, red.min_x, red.min_y), (0, 0, 0));
    assert_eq!((red.max, red.max_x, red.max_y), (255, 2, 0));
    assert_eq!(red.mean, (0.0 + 128.0 + 255.0) / 3.0);
}

#[test]
fn the_sample_standard_deviation_matches_the_closed_form() {
    // Values 0, 10, 20, 30: mean 15, sample variance
    // ((225 + 25 + 25 + 225) / 3) = 166.667, stdev 12.9099. Confirmed
    // this is sharp's own convention (sample, not population) by
    // reading real sharp 0.34.5 output for an unrelated fixture in the
    // module doc: 95.150257112482 (sample) vs 94.40396906380579
    // (population) for the same 64-sample channel — sharp reports the
    // former.
    let img = RasterImage::new_rgb(4, 1, vec![0, 0, 0, 10, 10, 10, 20, 20, 20, 30, 30, 30]);
    let red = &compute_stats(&img).unwrap().channels[0];
    assert!(
        (red.stdev - 12.909_944).abs() < 1e-4,
        "stdev was {}",
        red.stdev
    );
}

#[test]
fn a_two_level_image_has_one_bit_of_entropy() {
    // Half black, half white -> H = -2 * 0.5 * log2(0.5) = 1.0 bit.
    let data = (0..16u32)
        .flat_map(|i| if i < 8 { [0u8, 0, 0] } else { [255, 255, 255] })
        .collect();
    let img = RasterImage::new_rgb(16, 1, data);
    assert!((compute_stats(&img).unwrap().entropy - 1.0).abs() < 1e-6);
}

/// Stand-in for `RasterImage::blur` (filters lane #3504, not on this
/// branch — see the module doc): a plain box blur, used only by the
/// test below to build a deliberately soft edge. `compute_stats` itself
/// never blurs anything.
fn box_blur(img: &RasterImage, radius: usize) -> RasterImage {
    let c = img.channels as usize;
    let (w, h) = (img.width as usize, img.height as usize);
    let data = (0..h)
        .flat_map(|y| {
            (0..w).flat_map(move |x| {
                (0..c).map(move |band| {
                    let lo = x.saturating_sub(radius);
                    let hi = (x + radius).min(w.saturating_sub(1));
                    let sum: u32 = (lo..=hi)
                        .map(|sx| img.data[(y * w + sx) * c + band] as u32)
                        .sum();
                    (sum / (hi - lo + 1) as u32) as u8
                })
            })
        })
        .collect();
    RasterImage {
        width: img.width,
        height: img.height,
        channels: img.channels,
        data,
        orientation: img.orientation,
    }
}

#[test]
fn a_sharp_edge_scores_higher_than_a_blurred_one() {
    let data = (0..32u32)
        .flat_map(|x| {
            let v = if x < 16 { 0u8 } else { 255 };
            [v, v, v]
        })
        .collect();
    let edge = RasterImage::new_rgb(32, 1, data);
    let soft = box_blur(&edge, 9);
    let sharp_score = compute_stats(&edge).unwrap().sharpness;
    let soft_score = compute_stats(&soft).unwrap().sharpness;
    assert!(
        sharp_score > soft_score,
        "{sharp_score} should beat {soft_score}"
    );
}

#[test]
fn the_dominant_colour_is_the_most_populated_histogram_cell() {
    // 12 red pixels and 4 blue ones.
    let data = (0..16u32)
        .flat_map(|i| {
            if i < 12 {
                [200u8, 16, 16]
            } else {
                [16, 16, 200]
            }
        })
        .collect();
    let img = RasterImage::new_rgb(16, 1, data);
    let dominant = compute_stats(&img).unwrap().dominant;
    assert!(
        dominant[0] > 150,
        "expected a red-dominant cell, got {dominant:?}"
    );
    assert!(dominant[2] < 64, "{dominant:?}");
}

#[test]
fn is_opaque_follows_the_alpha_channel() {
    assert!(
        compute_stats(&RasterImage::new_rgb(1, 1, vec![0, 0, 0]))
            .unwrap()
            .is_opaque
    );
    assert!(
        compute_stats(&RasterImage::new_rgba(1, 1, vec![0, 0, 0, 255]))
            .unwrap()
            .is_opaque
    );
    assert!(
        !compute_stats(&RasterImage::new_rgba(1, 1, vec![0, 0, 0, 200]))
            .unwrap()
            .is_opaque
    );
}

#[test]
fn an_rgba_image_reports_four_channels() {
    let img = RasterImage::new_rgba(2, 1, vec![1, 2, 3, 4, 5, 6, 7, 8]);
    let stats = compute_stats(&img).unwrap();
    assert_eq!(stats.channels.len(), 4);
    assert_eq!((stats.channels[3].min, stats.channels[3].max), (4, 8));
}

#[test]
fn an_empty_image_is_rejected_rather_than_dividing_by_zero() {
    let empty = RasterImage {
        width: 0,
        height: 0,
        channels: 3,
        data: Vec::new(),
        orientation: crate::image::ExifOrientation::Normal,
    };
    assert!(compute_stats(&empty).is_err());
}

/// An 8x8 fixture run through real `sharp().stats()` 0.34.5 (see the
/// task report for the exact script): three colour regions (a 2x2 blue
/// patch, a 2-column-wide dark strip, and a red-dominant majority).
/// `entropy` and `dominant` are pinned to sharp's measured output;
/// `sharpness` is pinned to this file's own closed-form computation
/// (not sharp's — see the module doc) as a regression guard, with an
/// ordering-only cross-check that it is positive.
#[test]
fn an_eight_by_eight_fixture_matches_measured_sharp_output() {
    let mut data = Vec::with_capacity(8 * 8 * 3);
    for y in 0..8u32 {
        for x in 0..8u32 {
            let px = if x < 2 && y < 2 {
                [20u8, 20, 200]
            } else if x < 4 {
                [10, 10, 10]
            } else {
                [200, 30, 30]
            };
            data.extend_from_slice(&px);
        }
    }
    let img = RasterImage::new_rgb(8, 8, data);
    let stats = compute_stats(&img).unwrap();

    // sharp 0.34.5 measured: channels[0] (red).
    let red = &stats.channels[0];
    assert_eq!((red.min, red.max), (10, 200));
    assert_eq!(red.sum, 6760.0);
    assert_eq!(red.squares_sum, 1_284_400.0);
    assert_eq!(red.mean, 105.625);
    assert!(
        (red.stdev - 95.150_257_112_482).abs() < 1e-6,
        "stdev was {}",
        red.stdev
    );

    assert!(stats.is_opaque);
    // sharp 0.34.5 measured: entropy 1.2717822194099426.
    assert!(
        (stats.entropy - 1.271_782_219_409_942_6).abs() < 1e-3,
        "entropy was {}",
        stats.entropy
    );
    // sharp 0.34.5 measured: dominant {r:200, g:24, b:24} (exact bin match).
    assert_eq!(stats.dominant, [200, 24, 24]);
    // sharp 0.34.5 measured: sharpness 5.642424922637657 (unclamped
    // 4-connected Laplacian, scale 9, sample stdev — see the module doc).
    assert!(
        (stats.sharpness - 5.642_424_922_637_657).abs() < 1e-6,
        "sharpness was {}",
        stats.sharpness
    );
}

/// A 32x32 image of 2x2-pixel checkerboard cells, grey values `0`/`255`.
/// The fix-round-1 review brief for this task asked for this fixture
/// pinned to `28.05176056457488`; running real sharp 0.34.5 directly
/// against this exact construction (and a wide sweep of other checkerboard
/// sizes and cell sizes, and both grey polarities) never produces that
/// number — see the module doc for the sweep. Real sharp measures
/// `54.0295479363077` for this exact fixture. This implementation's own
/// value, `54.02954672391646`, is what this test pins as a regression
/// guard — the ~1.2e-6 gap from sharp's number is `f32`-precision noise in
/// [`bw_luma`]'s sRGB round trip (sharp works in higher precision
/// internally), well below anything that matters for `sharpness`'s actual
/// use (ordering sharp images above blurred ones).
#[test]
fn a_thirty_two_by_thirty_two_checkerboard_matches_measured_sharp_output() {
    let cell = 2u32;
    let data = (0..32u32)
        .flat_map(|y| {
            (0..32u32).flat_map(move |x| {
                let v = if ((x / cell) + (y / cell)) % 2 == 0 {
                    255u8
                } else {
                    0u8
                };
                [v, v, v]
            })
        })
        .collect();
    let img = RasterImage::new_rgb(32, 32, data);
    let sharpness = compute_stats(&img).unwrap().sharpness;
    assert!(
        (sharpness - 54.029_546_723_916_46).abs() < 1e-6,
        "sharpness was {sharpness}"
    );
}

#[test]
fn a_solid_mid_grey_image_dominant_bin_is_seven() {
    let img = RasterImage::new_rgb(2, 2, vec![128; 12]);
    let dominant = compute_stats(&img).unwrap().dominant;
    assert_eq!(dominant, [120, 120, 120], "128 -> bin 7, centre 120");
}

#[test]
fn a_value_of_sixteen_maps_to_dominant_bin_zero() {
    // 16 is a multiple of 16 -- exactly the boundary the old `v >> 4`
    // formula got wrong ((16 - 1) / 16 = 0, not 16 >> 4 = 1).
    let img = RasterImage::new_rgb(2, 2, vec![16; 12]);
    let dominant = compute_stats(&img).unwrap().dominant;
    assert_eq!(dominant, [8, 8, 8], "16 -> bin 0, centre 8");
}

#[test]
fn dominant_tie_break_picks_the_lower_bin_regardless_of_raster_order() {
    // Four pixels at 20 (bin 1, centre 24) and four at 90 (bin 5, centre
    // 88) -- an exact count tie. libvips' `maxpos()` (and so sharp)
    // returns the FIRST maximum, i.e. the lower bin, no matter which one
    // appears first in the raster.
    let low_first: Vec<u8> = (0..8u32)
        .flat_map(|i| {
            let v = if i < 4 { 20u8 } else { 90 };
            [v, v, v]
        })
        .collect();
    let high_first: Vec<u8> = (0..8u32)
        .flat_map(|i| {
            let v = if i < 4 { 90u8 } else { 20 };
            [v, v, v]
        })
        .collect();
    for data in [low_first, high_first] {
        let img = RasterImage::new_rgb(8, 1, data);
        let dominant = compute_stats(&img).unwrap().dominant;
        assert_eq!(dominant, [24, 24, 24], "tie must resolve to the lower bin");
    }
}
