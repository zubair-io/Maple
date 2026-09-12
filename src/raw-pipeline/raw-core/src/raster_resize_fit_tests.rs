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
