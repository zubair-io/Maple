//! Fit-arithmetic parity tests for `resize_raster` (#3502).
//!
//! Every expected number in this file was measured against the installed
//! sharp 0.34.5 / libvips 8.17.3 on the same synthetic source, not derived
//! from reading sharp's C++. A nested module of `raster_resize_tests` so it
//! reuses that module's `wide()` / `opts()` fixtures while both files stay
//! inside the repo's file-size budget.

use super::*;

/// `{ width: 10, fit: 'contain' }` on 40x20 -> 10x5, measured.
#[test]
fn a_single_axis_contain_applies_the_given_axis_factor_to_both() {
    let by_width = resize_raster(&wide(), &opts(10, 0, ResizeFit::Contain)).unwrap();
    assert_eq!((by_width.width, by_width.height), (10, 5));

    // `{ height: 10 }` -> 20x10, measured.
    let by_height = resize_raster(&wide(), &opts(0, 10, ResizeFit::Contain)).unwrap();
    assert_eq!((by_height.width, by_height.height), (20, 10));
}

/// The same rule for `cover`: `{ width: 10 }` -> 10x5 and `{ height: 5 }` ->
/// 10x5 on 40x20, measured. Neither crops — the free axis is resolved from
/// the resized size, so the box is already exact.
#[test]
fn a_single_axis_cover_applies_the_given_axis_factor_to_both() {
    let by_width = resize_raster(&wide(), &opts(10, 0, ResizeFit::Cover)).unwrap();
    assert_eq!((by_width.width, by_width.height), (10, 5));

    let by_height = resize_raster(&wide(), &opts(0, 5, ResizeFit::Cover)).unwrap();
    assert_eq!((by_height.width, by_height.height), (10, 5));
}

/// `inside` and `outside` already applied one factor to both axes, and must
/// not have moved: `{ width: 10, fit: 'inside' }` -> 10x5 and
/// `{ height: 10, fit: 'outside' }` -> 20x10 on 40x20, measured.
#[test]
fn single_axis_inside_and_outside_are_unmoved() {
    let inside = resize_raster(&wide(), &opts(10, 0, ResizeFit::Inside)).unwrap();
    assert_eq!((inside.width, inside.height), (10, 5));

    let outside = resize_raster(&wide(), &opts(0, 10, ResizeFit::Outside)).unwrap();
    assert_eq!((outside.width, outside.height), (20, 10));
}

/// `fill` is the one canvas that does NOT copy the factor across: it keeps
/// the unrequested axis at the source size. Measured: `{ width: 10 }` ->
/// 10x20 and `{ height: 10 }` -> 40x10 on 40x20.
#[test]
fn a_single_axis_fill_leaves_the_other_axis_at_the_source_size() {
    let by_width = resize_raster(&wide(), &opts(10, 0, ResizeFit::Fill)).unwrap();
    assert_eq!((by_width.width, by_width.height), (10, 20));

    let by_height = resize_raster(&wide(), &opts(0, 10, ResizeFit::Fill)).unwrap();
    assert_eq!((by_height.width, by_height.height), (40, 10));
}

/// `fill` is subject to `withoutEnlargement` and `withoutReduction` too, and
/// per axis — it is the one canvas where the two axes carry different shrink
/// factors, so one can be clamped while the other is not. Measured against
/// sharp 0.34.5 / libvips 8.17.3 on a 40x20 source:
///
///   * `{ 100, 100, withoutReduction }`   -> 100x100 (both axes enlarge, so
///     neither is a reduction and neither clamp bites)
///   * `{ 100, 100, withoutEnlargement }` -> 40x20   (both held back)
///   * `{ 10, 10, withoutReduction }`     -> 40x20   (both held back)
///   * `{ 100, 10, withoutEnlargement }`  -> 40x10   (width held, height
///     reduced)
///   * `{ 10, 100, withoutEnlargement }`  -> 10x20   (height held, width
///     reduced)
///   * `{ 100, 10, withoutReduction }`    -> 100x20  (height held, width
///     enlarged)
#[test]
fn fill_honours_both_clamps_per_axis() {
    let fill = |w, h, woe, wor| {
        let out = resize_raster(
            &wide(),
            &ResizeOptions {
                without_enlargement: woe,
                without_reduction: wor,
                ..opts(w, h, ResizeFit::Fill)
            },
        )
        .unwrap();
        (out.width, out.height)
    };
    assert_eq!(fill(100, 100, false, true), (100, 100));
    assert_eq!(fill(100, 100, true, false), (40, 20));
    assert_eq!(fill(10, 10, false, true), (40, 20));
    assert_eq!(fill(100, 10, true, false), (40, 10));
    assert_eq!(fill(10, 100, true, false), (10, 20));
    assert_eq!(fill(100, 10, false, true), (100, 20));
}

/// The derived axis is rounded half-UP on `dim * (1 / shrink)`, which is
/// how libvips sizes a resize. Measured against sharp 0.34.5 / libvips
/// 8.17.3, a 40x20 source into an NxN `inside` box:
///
///   N  | 3   6   7   9   11   12   13   17   19   23   31
///   -> | 3x2 6x3 7x4 9x5 11x6 12x6 13x6 17x9 19x10 23x12 31x16
///
/// Three of those pin the arithmetic rather than just the result. N = 13 is
/// the case that rules out dividing by the shrink (`20 / (40 / 13)` is
/// exactly 6.5 and rounds to 7; the reciprocal form is 6.4999999999999991
/// and rounds to 6). N = 9 and N = 17 are the cases that rule out
/// ties-to-even (an exact 4.5 and 8.5, which sharp resolves upward).
#[test]
fn the_derived_axis_rounds_the_way_libvips_sizes_a_resize() {
    let inside = |n| {
        let out = resize_raster(&wide(), &opts(n, n, ResizeFit::Inside)).unwrap();
        (out.width, out.height)
    };
    assert_eq!(inside(3), (3, 2));
    assert_eq!(inside(6), (6, 3));
    assert_eq!(inside(7), (7, 4));
    assert_eq!(inside(9), (9, 5), "an exact 4.5 rounds up, not to even");
    assert_eq!(inside(11), (11, 6));
    assert_eq!(inside(12), (12, 6));
    assert_eq!(inside(13), (13, 6), "6.5 via the reciprocal rounds to 6");
    assert_eq!(inside(17), (17, 9), "an exact 8.5 rounds up, not to even");
    assert_eq!(inside(19), (19, 10));
    assert_eq!(inside(23), (23, 12));
    assert_eq!(inside(31), (31, 16));
}

/// The one place this still parts company with sharp, pinned so it is
/// visible rather than folklore. libvips resizes in two stages — an integer
/// `vips_shrink` then a residual `vips_reduce` — and rounds at each, so at
/// heavy downscales its derived axis lands a pixel below any single-step
/// rounding. Measured: sharp renders a 400x200 source into an `inside`
/// 13x13 box at 13x6; the closed form here gives 13x7.
///
/// If a future change ports `vips_resize`'s staging, this test is the one
/// to update — the assertion below is OUR number, not sharp's.
#[test]
fn a_heavy_downscale_still_differs_from_libvips_two_stage_rounding() {
    let src = RasterImage::new_rgb(400, 200, vec![7; 400 * 200 * 3]);
    let out = resize_raster(&src, &opts(13, 13, ResizeFit::Inside)).unwrap();
    assert_eq!(
        (out.width, out.height),
        (13, 7),
        "sharp answers 13x6 here — see scaled_dim's KNOWN GAP note"
    );
}

/// Red names the source column (`x * 6 + 3`), green the source row
/// (`y * 12 + 5`), so an output pixel says where it came from. Neither
/// channel can be 0, which keeps them distinct from `opts`' blue
/// background.
fn grid(w: u32, h: u32) -> RasterImage {
    let data = (0..h)
        .flat_map(|y| (0..w).flat_map(move |x| [(x * 6 + 3) as u8, (y * 12 + 5) as u8, 0]))
        .collect();
    RasterImage::new_rgb(w, h, data)
}

/// `contain` with `withoutReduction` on a source larger than the box. The
/// clamp pins the scale at 1, so the image cannot shrink into the box — and
/// sharp does not give up and return the source untouched. It sizes the
/// letterbox canvas as `max(resized, target)`, which here is the source's
/// own 40x20, and embeds the image at a NEGATIVE offset of (-15, -5): the
/// centre region shows through at the top-left and the trailing edges
/// become background.
///
/// Measured against sharp 0.34.5 / libvips 8.17.3 on a 40x20 source with
/// `{ 10, 10, contain, withoutReduction }`: output 40x20, 3 channels; row 0
/// reads source columns 15..=39 followed by 15 background columns; column 0
/// reads source rows 5..=19 followed by 5 background rows.
#[test]
fn contain_with_an_upward_clamped_scale_embeds_at_a_negative_offset() {
    let out = resize_raster(
        &grid(40, 20),
        &ResizeOptions {
            without_reduction: true,
            ..opts(10, 10, ResizeFit::Contain)
        },
    )
    .unwrap();
    assert_eq!((out.width, out.height, out.channels), (40, 20, 3));
    let px = |x: u32, y: u32| {
        let i = ((y * out.width + x) * out.channels as u32) as usize;
        [out.data[i], out.data[i + 1], out.data[i + 2]]
    };

    for x in 0..25u32 {
        assert_eq!(
            px(x, 0)[0],
            ((x + 15) * 6 + 3) as u8,
            "output column {x} must be source column {}",
            x + 15
        );
    }
    for x in 25..40u32 {
        assert_eq!(
            px(x, 0),
            [0, 0, 255],
            "output column {x} must be background"
        );
    }
    for y in 0..15u32 {
        assert_eq!(
            px(0, y)[1],
            ((y + 5) * 12 + 5) as u8,
            "output row {y} must be source row {}",
            y + 5
        );
    }
    for y in 15..20u32 {
        assert_eq!(px(0, y), [0, 0, 255], "output row {y} must be background");
    }
}

/// The ordinary letterbox is untouched by the negative-offset handling:
/// 40x20 into a `contain` 10x10 box scales to 10x5 and pads 2 rows above
/// and 3 below, and the canvas is the requested box.
#[test]
fn an_ordinary_contain_letterbox_still_pads_both_edges() {
    let out = resize_raster(&grid(40, 20), &opts(10, 10, ResizeFit::Contain)).unwrap();
    assert_eq!((out.width, out.height), (10, 10));
    let px = |x: u32, y: u32| {
        let i = ((y * out.width + x) * out.channels as u32) as usize;
        [out.data[i], out.data[i + 1], out.data[i + 2]]
    };
    assert_eq!(px(5, 1), [0, 0, 255], "last row of the top band");
    assert_ne!(px(5, 2), [0, 0, 255], "first image row");
    assert_ne!(px(5, 6), [0, 0, 255], "last image row");
    assert_eq!(px(5, 7), [0, 0, 255], "first row of the bottom band");
}
