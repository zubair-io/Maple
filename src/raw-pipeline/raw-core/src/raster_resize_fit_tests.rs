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
