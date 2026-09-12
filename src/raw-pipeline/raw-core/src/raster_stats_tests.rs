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
    // sharp measures 5.64 here via its own unclamped scale-9 kernel;
    // this file's clamped scale-1/offset-128 convolution is a different
    // (documented) computation, pinned to its own closed-form value.
    assert!(
        (stats.sharpness - 50.781_824_019_954_726).abs() < 1e-6,
        "sharpness was {}",
        stats.sharpness
    );
}
