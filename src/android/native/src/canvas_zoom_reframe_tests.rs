//! The zoom carried across a change that is not a gesture (#5748): a viewport
//! change (rotation, a fold posture), the image extent changing under a crop
//! or straighten, and a gesture cancelled before it ended. The image point at
//! the viewport centre stays there as far as the pan limit allows.

use super::*;

const VIEWPORT: (f64, f64) = (1000.0, 750.0);
const ROTATED: (f64, f64) = (750.0, 1000.0);

fn call(
    state: &mut [f64; STATE_LEN],
    op: u32,
    args: [f64; 4],
    viewport: (f64, f64),
    image: (f64, f64),
) -> i32 {
    let [a, b, c, d] = args;
    // SAFETY: `state` is a live, exclusively borrowed STATE_LEN array.
    unsafe {
        maple_android_canvas_zoom(
            state.as_mut_ptr(),
            op,
            a,
            b,
            c,
            d,
            viewport.0,
            viewport.1,
            image.0,
            image.1,
        )
    }
}

fn effective_scale(state: &[f64; STATE_LEN], viewport: (f64, f64), image: (f64, f64)) -> f64 {
    Geometry::new(viewport.0, viewport.1, image.0, image.1)
        .context()
        .effective_scale(decode(state).pixel_scale)
}

/// The image pixel (from the image's top-left) drawn at the viewport centre.
fn centre_point(state: &[f64; STATE_LEN], viewport: (f64, f64), image: (f64, f64)) -> Point {
    let scale = effective_scale(state, viewport, image);
    let pan = decode(state).pan_offset;
    Point::new(
        image.0 / 2.0 - pan.width / scale,
        image.1 / 2.0 - pan.height / scale,
    )
}

fn assert_close(actual: f64, expected: f64, label: &str) {
    assert!(
        (actual - expected).abs() <= 1e-9 * expected.abs().max(1.0),
        "{label}: {actual} != {expected}"
    );
}

fn assert_point(actual: Point, expected: Point, label: &str) {
    assert_close(actual.x, expected.x, &format!("{label} (x)"));
    assert_close(actual.y, expected.y, &format!("{label} (y)"));
}

/// 100% with the image dragged off-centre by `pan`.
fn at_actual_size(pan: (f64, f64), image: (f64, f64)) -> [f64; STATE_LEN] {
    let mut state = [0.0; STATE_LEN];
    call(
        &mut state,
        OP_DOUBLE_TAP,
        [500.0, 375.0, 0.0, 0.0],
        VIEWPORT,
        image,
    );
    call(
        &mut state,
        OP_DRAG_CHANGED,
        [pan.0, pan.1, 0.0, 0.0],
        VIEWPORT,
        image,
    );
    call(&mut state, OP_DRAG_ENDED, [0.0; 4], VIEWPORT, image);
    state
}

#[test]
fn a_rotation_at_100_percent_keeps_the_scale_and_the_centred_point() {
    let image = (4000.0, 3000.0);
    let mut state = at_actual_size((-300.0, 200.0), image);
    let before = centre_point(&state, VIEWPORT, image);
    call(&mut state, OP_RECLAMP, [0.0; 4], ROTATED, image);
    assert_eq!(decode(&state).pixel_scale, 1.0);
    assert_point(centre_point(&state, ROTATED, image), before, "centre");
}

#[test]
fn a_rotation_at_fill_re_resolves_fill_and_keeps_the_centred_point() {
    let image = (2000.0, 1000.0);
    let mut state = [0.0; STATE_LEN];
    call(&mut state, OP_ADVANCE_STOP, [0.0; 4], VIEWPORT, image);
    call(
        &mut state,
        OP_DRAG_CHANGED,
        [100.0, 0.0, 0.0, 0.0],
        VIEWPORT,
        image,
    );
    call(&mut state, OP_DRAG_ENDED, [0.0; 4], VIEWPORT, image);
    assert!(decode(&state).fills_viewport);
    let before = centre_point(&state, VIEWPORT, image);
    call(&mut state, OP_RECLAMP, [0.0; 4], ROTATED, image);
    let model = decode(&state);
    assert!(model.fills_viewport);
    assert_close(model.pixel_scale, 1.0, "fill of a 750x1000 viewport");
    assert_point(centre_point(&state, ROTATED, image), before, "centre");
    assert_close(
        model.base_pan.width,
        model.pan_offset.width,
        "committed pan",
    );
}

#[test]
fn a_rotation_and_back_returns_to_the_same_view() {
    let image = (2000.0, 1000.0);
    let mut state = [0.0; STATE_LEN];
    call(&mut state, OP_ADVANCE_STOP, [0.0; 4], VIEWPORT, image);
    call(
        &mut state,
        OP_DRAG_CHANGED,
        [-150.0, 0.0, 0.0, 0.0],
        VIEWPORT,
        image,
    );
    call(&mut state, OP_DRAG_ENDED, [0.0; 4], VIEWPORT, image);
    let before = decode(&state);
    call(&mut state, OP_RECLAMP, [0.0; 4], ROTATED, image);
    call(&mut state, OP_RECLAMP, [0.0; 4], VIEWPORT, image);
    let after = decode(&state);
    assert_close(after.pixel_scale, before.pixel_scale, "scale");
    assert_close(after.pan_offset.width, before.pan_offset.width, "pan");
}

#[test]
fn a_rotation_lifts_a_free_scale_below_the_new_floor() {
    let image = (4000.0, 1000.0);
    let mut state = [0.0; STATE_LEN];
    call(
        &mut state,
        OP_PINCH_CHANGED,
        [1.0, 500.0, 375.0, 0.0],
        VIEWPORT,
        image,
    );
    call(
        &mut state,
        OP_PINCH_CHANGED,
        [1.2, 500.0, 375.0, 0.0],
        VIEWPORT,
        image,
    );
    call(
        &mut state,
        OP_PINCH_ENDED,
        [1.2, 0.0, 0.0, 0.0],
        VIEWPORT,
        image,
    );
    let wide = (4000.0, 750.0);
    call(&mut state, OP_RECLAMP, [0.0; 4], wide, image);
    let floor = Geometry::new(wide.0, wide.1, image.0, image.1)
        .context()
        .min_scale();
    assert_close(decode(&state).pixel_scale, floor, "the new floor");
}

/// `crs:CropRight` 1.0 → 0.8 while at 100%: the new image is the left
/// 3200 px of the old one.
#[test]
fn a_crop_keeps_100_percent_and_the_centred_image_point() {
    let image = (4000.0, 3000.0);
    let cropped = (3200.0, 3000.0);
    let mut state = at_actual_size((-200.0, 100.0), image);
    let before = centre_point(&state, VIEWPORT, image);
    call(
        &mut state,
        OP_REFRAME_IMAGE,
        [0.0, 0.0, cropped.0, cropped.1],
        VIEWPORT,
        cropped,
    );
    assert_eq!(decode(&state).pixel_scale, 1.0);
    assert_point(
        centre_point(&state, VIEWPORT, cropped),
        before,
        "the same source pixel stays centred",
    );
}

#[test]
fn undoing_a_crop_returns_to_the_view_before_it() {
    let image = (4000.0, 3000.0);
    let cropped = (3000.0, 2000.0);
    let mut state = at_actual_size((150.0, -120.0), image);
    let before = decode(&state);
    call(
        &mut state,
        OP_REFRAME_IMAGE,
        [500.0, 400.0, cropped.0, cropped.1],
        VIEWPORT,
        cropped,
    );
    call(
        &mut state,
        OP_REFRAME_IMAGE,
        [-500.0, -400.0, image.0, image.1],
        VIEWPORT,
        image,
    );
    let after = decode(&state);
    assert!(after.is_zoomed_in(), "the undo keeps the zoom");
    assert_close(after.pixel_scale, before.pixel_scale, "scale");
    assert_close(after.pan_offset.width, before.pan_offset.width, "pan x");
    assert_close(after.pan_offset.height, before.pan_offset.height, "pan y");
}

#[test]
fn a_crop_keeps_a_free_scale_on_screen_and_re_resolves_fill() {
    let image = (4000.0, 3000.0);
    let cropped = (2000.0, 3000.0);
    let mut free = [0.0; STATE_LEN];
    call(
        &mut free,
        OP_PINCH_CHANGED,
        [1.0, 500.0, 375.0, 0.0],
        VIEWPORT,
        image,
    );
    call(
        &mut free,
        OP_PINCH_CHANGED,
        [3.0, 500.0, 375.0, 0.0],
        VIEWPORT,
        image,
    );
    call(
        &mut free,
        OP_PINCH_ENDED,
        [3.0, 0.0, 0.0, 0.0],
        VIEWPORT,
        image,
    );
    let scale = decode(&free).pixel_scale;
    call(
        &mut free,
        OP_REFRAME_IMAGE,
        [1000.0, 0.0, cropped.0, cropped.1],
        VIEWPORT,
        cropped,
    );
    assert_close(decode(&free).pixel_scale, scale, "same pixels, same scale");

    let wide = (4000.0, 2000.0);
    let square = (2000.0, 2000.0);
    let mut fill = [0.0; STATE_LEN];
    call(&mut fill, OP_ADVANCE_STOP, [0.0; 4], VIEWPORT, wide);
    assert!(decode(&fill).fills_viewport);
    call(
        &mut fill,
        OP_REFRAME_IMAGE,
        [1000.0, 0.0, square.0, square.1],
        VIEWPORT,
        square,
    );
    let model = decode(&fill);
    assert!(model.fills_viewport);
    assert_close(model.pixel_scale, 0.5, "fill of the cropped extent");
}

#[test]
fn a_resampled_extent_keeps_the_content_size_on_screen() {
    let image = (4000.0, 3000.0);
    let half = (2000.0, 1500.0);
    let mut state = at_actual_size((0.0, 0.0), image);
    call(
        &mut state,
        OP_PINCH_CHANGED,
        [1.0, 500.0, 375.0, 0.0],
        VIEWPORT,
        image,
    );
    call(
        &mut state,
        OP_PINCH_ENDED,
        [1.0, 0.0, 0.0, 0.0],
        VIEWPORT,
        image,
    );
    call(
        &mut state,
        OP_PINCH_CHANGED,
        [1.0, 500.0, 375.0, 0.0],
        VIEWPORT,
        image,
    );
    call(
        &mut state,
        OP_PINCH_CHANGED,
        [0.8, 500.0, 375.0, 0.0],
        VIEWPORT,
        image,
    );
    call(
        &mut state,
        OP_PINCH_ENDED,
        [0.8, 0.0, 0.0, 0.0],
        VIEWPORT,
        image,
    );
    let on_screen = effective_scale(&state, VIEWPORT, image) * image.0;
    call(
        &mut state,
        OP_REFRAME_IMAGE,
        [0.0, 0.0, image.0, image.1],
        VIEWPORT,
        half,
    );
    assert_close(
        effective_scale(&state, VIEWPORT, half) * half.0,
        on_screen,
        "on-screen width",
    );
}

#[test]
fn reframing_at_fit_changes_nothing() {
    let image = (4000.0, 3000.0);
    let mut state = [0.0; STATE_LEN];
    call(&mut state, OP_RECLAMP, [0.0; 4], VIEWPORT, image);
    call(
        &mut state,
        OP_REFRAME_IMAGE,
        [0.0, 0.0, 3200.0, 3000.0],
        VIEWPORT,
        (3200.0, 3000.0),
    );
    assert_eq!(decode(&state), CanvasZoomModel::default());
}

#[test]
fn reframing_with_an_unusable_extent_only_reclamps() {
    let image = (4000.0, 3000.0);
    for extent in [
        [0.0, 0.0, 0.0, 3000.0],
        [f64::NAN, 0.0, 4000.0, 3000.0],
        [0.0, 0.0, -4000.0, 3000.0],
        [0.0, f64::INFINITY, 4000.0, 3000.0],
    ] {
        let mut state = at_actual_size((-300.0, 200.0), image);
        let before = decode(&state);
        assert_eq!(
            call(&mut state, OP_REFRAME_IMAGE, extent, VIEWPORT, image),
            1
        );
        assert_eq!(decode(&state), before, "{extent:?}");
    }
}

#[test]
fn reframing_mid_drag_continues_without_a_jump() {
    let image = (4000.0, 3000.0);
    let cropped = (3200.0, 3000.0);
    let mut state = [0.0; STATE_LEN];
    call(
        &mut state,
        OP_DOUBLE_TAP,
        [500.0, 375.0, 0.0, 0.0],
        VIEWPORT,
        image,
    );
    call(
        &mut state,
        OP_DRAG_CHANGED,
        [-100.0, 0.0, 0.0, 0.0],
        VIEWPORT,
        image,
    );
    call(
        &mut state,
        OP_REFRAME_IMAGE,
        [0.0, 0.0, cropped.0, cropped.1],
        VIEWPORT,
        cropped,
    );
    let reframed = decode(&state).pan_offset.width;
    call(
        &mut state,
        OP_DRAG_CHANGED,
        [-100.0, 0.0, 0.0, 0.0],
        VIEWPORT,
        cropped,
    );
    assert_close(decode(&state).pan_offset.width, reframed, "no jump");
    call(
        &mut state,
        OP_DRAG_CHANGED,
        [-110.0, 0.0, 0.0, 0.0],
        VIEWPORT,
        cropped,
    );
    assert_close(
        decode(&state).pan_offset.width,
        reframed - 10.0,
        "then follows the finger",
    );
}

/// Review on #5753: a crop changed mid-pinch below fit pulled the pinch into
/// the resting range, which below fit is the centre, so the photo jumped.
#[test]
fn a_crop_mid_pinch_below_fit_keeps_the_photo_where_it_is() {
    let image = (4000.0, 3000.0);
    let cropped = (3200.0, 3000.0);
    let mut state = [0.0; STATE_LEN];
    for (magnification, x, y) in [(1.0, 300.0, 200.0), (0.7, 260.0, 190.0)] {
        call(
            &mut state,
            OP_PINCH_CHANGED,
            [magnification, x, y, 0.0],
            VIEWPORT,
            image,
        );
    }
    let scale = effective_scale(&state, VIEWPORT, image);
    let before = centre_point(&state, VIEWPORT, image);
    call(
        &mut state,
        OP_REFRAME_IMAGE,
        [0.0, 0.0, cropped.0, cropped.1],
        VIEWPORT,
        cropped,
    );
    assert_close(effective_scale(&state, VIEWPORT, cropped), scale, "scale");
    assert_point(
        centre_point(&state, VIEWPORT, cropped),
        before,
        "the same source pixel stays centred",
    );
    assert!(decode(&state).pinch_start_scale.is_some());
}

#[test]
fn settling_ends_a_pinch_that_never_ended() {
    let image = (4000.0, 3000.0);
    let mut state = [0.0; STATE_LEN];
    call(
        &mut state,
        OP_PINCH_CHANGED,
        [1.0, 500.0, 375.0, 0.0],
        VIEWPORT,
        image,
    );
    call(
        &mut state,
        OP_PINCH_CHANGED,
        [3.0, 500.0, 375.0, 0.0],
        VIEWPORT,
        image,
    );
    let pinched = decode(&state).pixel_scale;
    call(&mut state, OP_SETTLE, [0.0; 4], VIEWPORT, image);
    let settled = decode(&state);
    assert_eq!(settled.pinch_start_scale, None);
    assert_close(
        settled.pixel_scale,
        pinched,
        "the pinch commits where it was",
    );
    assert_eq!(settled.pinch_last_magnification, 0.0);
    call(
        &mut state,
        OP_PINCH_CHANGED,
        [1.0, 200.0, 200.0, 0.0],
        VIEWPORT,
        image,
    );
    call(
        &mut state,
        OP_PINCH_CHANGED,
        [1.0, 200.0, 200.0, 0.0],
        VIEWPORT,
        image,
    );
    assert_close(
        decode(&state).pixel_scale,
        pinched,
        "a new pinch starts from the settled zoom",
    );
}

#[test]
fn settling_ends_a_drag_that_never_ended() {
    let image = (4000.0, 3000.0);
    let mut state = [0.0; STATE_LEN];
    call(
        &mut state,
        OP_DOUBLE_TAP,
        [500.0, 375.0, 0.0, 0.0],
        VIEWPORT,
        image,
    );
    call(
        &mut state,
        OP_DRAG_CHANGED,
        [-100.0, 40.0, 0.0, 0.0],
        VIEWPORT,
        image,
    );
    call(&mut state, OP_SETTLE, [0.0; 4], VIEWPORT, image);
    let settled = decode(&state);
    assert_eq!(settled.base_pan, settled.pan_offset);
    assert_eq!(settled.drag_last_translation, None);
    call(
        &mut state,
        OP_DRAG_CHANGED,
        [10.0, 0.0, 0.0, 0.0],
        VIEWPORT,
        image,
    );
    assert_close(
        decode(&state).pan_offset.width,
        settled.pan_offset.width + 10.0,
        "a new drag starts from the settled pan",
    );
}

#[test]
fn settling_with_nothing_live_changes_nothing() {
    let image = (4000.0, 3000.0);
    let mut state = at_actual_size((-300.0, 200.0), image);
    let before = state;
    call(&mut state, OP_SETTLE, [0.0; 4], VIEWPORT, image);
    assert_eq!(state, before);
}

#[test]
fn a_lowered_cap_keeps_a_resting_free_scale_across_a_resize_and_a_crop() {
    let image = (300.0, 100.0);
    let large = (2000.0, 1600.0);
    let small = (1000.0, 800.0);
    let mut state = [0.0; STATE_LEN];
    for magnification in [1.0, 2.1] {
        let args = [magnification, 1000.0, 800.0, 0.0];
        call(&mut state, OP_PINCH_CHANGED, args, large, image);
    }
    let release = [2.1, 0.0, 0.0, 0.0];
    call(&mut state, OP_PINCH_ENDED, release, large, image);
    let before = effective_scale(&state, large, image);
    assert_close(before, 14.0, "free scale above 800%");
    call(&mut state, OP_RECLAMP, [0.0; 4], small, image);
    assert_close(effective_scale(&state, small, image), before, "scale");
    let crop = (299.0, 100.0);
    let extent = [0.0, 0.0, 299.0, 100.0];
    call(&mut state, OP_REFRAME_IMAGE, extent, small, crop);
    assert_close(effective_scale(&state, small, crop), before, "cropped");
}
