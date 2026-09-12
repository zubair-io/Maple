use super::*;
use crate::raster_sharpen::SharpenOptions;

/// 8x4: the left half opaque `(200, 10, 10)`, the right half fully
/// transparent `(0, 250, 0)`. The fixture the PR-E review used to show what
/// a per-operation premultiply sandwich costs.
fn split_alpha() -> RasterImage {
    let data = (0..4u32)
        .flat_map(|_| {
            (0..8u32).flat_map(|x| {
                if x < 4 {
                    [200u8, 10, 10, 255]
                } else {
                    [0, 250, 0, 0]
                }
            })
        })
        .collect();
    RasterImage::new_rgba(8, 4, data)
}

fn row(img: &RasterImage, y: usize) -> Vec<[u8; 4]> {
    let w = img.width as usize;
    img.data[y * w * 4..(y + 1) * w * 4]
        .chunks_exact(4)
        .map(|px| [px[0], px[1], px[2], px[3]])
        .collect()
}

#[test]
fn a_transparent_neighbour_never_leaks_its_stored_colour() {
    // Measured on sharp 0.34.5, row y=1 of `sharpen()` over `split_alpha`.
    // The interesting pixel is x=4, the first fully transparent column:
    // sharp writes (200, 10, 10, 0), which is only reachable because the
    // convolution's negative accumulators (alpha −31.875, red −25.0) reach
    // the unpremultiply unclamped and cancel there. Before this wave Maple
    // wrote (0, 255, 0, 0) at x=4 and (225, 0, 11, 255) at x=3 — max diff
    // 255 against this row.
    let out = split_alpha().sharpen(&SharpenOptions::default()).unwrap();
    assert_eq!(
        row(&out, 1),
        vec![
            [200, 10, 10, 255],
            [200, 10, 10, 255],
            [200, 10, 10, 255],
            [200, 10, 10, 255],
            [200, 10, 10, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 0],
        ]
    );
}

#[test]
fn consecutive_filter_ops_share_one_sandwich() {
    // `median(3)` then `blur(1.5)` over the same fixture, measured on sharp
    // 0.34.5. sharp premultiplies once for the pair, so the median runs on
    // premultiplied bytes and no `u8` round trip happens between the two —
    // which is what `raster_recipe_exec`'s run grouping reproduces.
    let out = run_filter_chain(
        &split_alpha(),
        &[FilterOp::Median(3), FilterOp::Blur(Some(1.5))],
    )
    .unwrap();
    assert_eq!(
        row(&out, 1),
        vec![
            [200, 10, 10, 255],
            [200, 10, 10, 255],
            [200, 10, 10, 225],
            [200, 9, 9, 165],
            [198, 11, 11, 90],
            [195, 8, 8, 30],
            [0, 0, 0, 0],
            [0, 0, 0, 0],
        ]
    );
}

#[test]
fn a_blur_then_convolve_run_matches_sharp_on_an_alpha_ramp() {
    // 8x1 with both colour and alpha ramping, so every pixel sits at a
    // different partial alpha — the case a per-operation sandwich loses
    // levels on. Measured on sharp 0.34.5.
    let data = (0..8u32)
        .flat_map(|x| {
            [
                (20 + x * 30) as u8,
                (200 - x * 20) as u8,
                100,
                (32 + x * 32) as u8,
            ]
        })
        .collect();
    let src = RasterImage::new_rgba(8, 1, data);
    let box3 = [1.0; 9];
    let out = run_filter_chain(
        &src,
        &[
            FilterOp::Blur(Some(1.5)),
            FilterOp::Convolve {
                width: 3,
                height: 3,
                kernel: &box3,
                scale: 9.0,
                offset: 0.0,
            },
        ],
    )
    .unwrap();
    assert_eq!(
        row(&out, 0),
        vec![
            [53, 176, 97, 54],
            [73, 161, 97, 70],
            [98, 144, 98, 97],
            [124, 128, 98, 128],
            [146, 113, 99, 150],
            [164, 102, 99, 150],
            [176, 94, 99, 122],
            [185, 88, 99, 93],
        ]
    );
}

#[test]
fn only_an_image_with_alpha_is_premultiplied() {
    // The premultiply round trip costs a level on partial alpha even where
    // the filter itself is a no-op: a flat (80, 80, 80, 200) field comes
    // back 79 from sharp for `sharpen()`, `blur()` or `convolve()`, and 80
    // for `median()`, which does not trigger the sandwich. Three-channel
    // input has no alpha to premultiply against and stays at 80.
    let rgba = RasterImage::new_rgba(3, 3, (0..9).flat_map(|_| [80u8, 80, 80, 200]).collect());
    let sharpened =
        run_filter_chain(&rgba, &[FilterOp::Sharpen(SharpenOptions::default())]).unwrap();
    assert!(sharpened
        .data
        .chunks_exact(4)
        .all(|px| px == [79, 79, 79, 200]));

    let medianed = run_filter_chain(&rgba, &[FilterOp::Median(3)]).unwrap();
    assert!(medianed
        .data
        .chunks_exact(4)
        .all(|px| px == [80, 80, 80, 200]));

    let rgb = RasterImage::new_rgb(3, 3, vec![80; 27]);
    let sharpened =
        run_filter_chain(&rgb, &[FilterOp::Sharpen(SharpenOptions::default())]).unwrap();
    assert!(sharpened.data.iter().all(|&v| v == 80));
}
