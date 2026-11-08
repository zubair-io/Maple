use super::tests::{read, zoom};
use super::*;

#[test]
fn delayed_original_keeps_a_one_to_one_double_tap_and_its_anchor() {
    let placeholder = (2048.0, 1365.0);
    let original = (6000.0, 4000.0);
    let mut state = [0.0; STATE_LEN];
    zoom(
        &mut state,
        OP_DOUBLE_TAP,
        [750.0, 375.0, 0.0, 0.0],
        placeholder,
    );
    zoom(
        &mut state,
        OP_ADOPT_IMAGE,
        [placeholder.0, placeholder.1, 750.0, 375.0],
        original,
    );
    let model = decode(&state);
    assert_eq!(model.pixel_scale, 1.0);
    assert!((model.pan_offset.width + 1250.0).abs() < 1e-9);
    let source_x = (750.0 - 500.0 - model.pan_offset.width) / model.pixel_scale + 3000.0;
    assert!(
        (source_x - 4500.0).abs() < 1e-9,
        "the tapped point stays under the tap"
    );
}

#[test]
fn delayed_original_keeps_a_free_pinch_relative_to_fit() {
    let placeholder = (2048.0, 1365.0);
    let original = (6000.0, 4000.0);
    let mut state = [0.0; STATE_LEN];
    zoom(
        &mut state,
        OP_PINCH_CHANGED,
        [1.0, 750.0, 375.0, 0.0],
        placeholder,
    );
    zoom(
        &mut state,
        OP_PINCH_CHANGED,
        [2.0, 750.0, 375.0, 0.0],
        placeholder,
    );
    zoom(
        &mut state,
        OP_PINCH_ENDED,
        [2.0, 0.0, 0.0, 0.0],
        placeholder,
    );
    zoom(
        &mut state,
        OP_ADOPT_IMAGE,
        [placeholder.0, placeholder.1, 750.0, 375.0],
        original,
    );
    let over_fit =
        read(&state, QUERY_EFFECTIVE_SCALE, original) / read(&state, QUERY_FIT_SCALE, original);
    assert!((over_fit - 2.0).abs() < 1e-9);
    assert!((decode(&state).pan_offset.width + 250.0).abs() < 1e-9);
}

#[test]
fn adopting_at_fit_changes_nothing() {
    let mut state = [0.0; STATE_LEN];
    zoom(
        &mut state,
        OP_ADOPT_IMAGE,
        [2048.0, 1365.0, 750.0, 375.0],
        (6000.0, 4000.0),
    );
    assert_eq!(state[..GEOMETRY_SLOT], [0.0; GEOMETRY_SLOT]);
}

#[test]
fn adopting_mid_pinch_continues_the_pinch_relative_to_fit() {
    let placeholder = (2048.0, 1365.0);
    let original = (6000.0, 4000.0);
    let mut state = [0.0; STATE_LEN];
    zoom(
        &mut state,
        OP_PINCH_CHANGED,
        [1.0, 500.0, 375.0, 0.0],
        placeholder,
    );
    zoom(
        &mut state,
        OP_PINCH_CHANGED,
        [1.5, 500.0, 375.0, 0.0],
        placeholder,
    );
    zoom(
        &mut state,
        OP_ADOPT_IMAGE,
        [placeholder.0, placeholder.1, 500.0, 375.0],
        original,
    );
    zoom(
        &mut state,
        OP_PINCH_CHANGED,
        [2.0, 500.0, 375.0, 0.0],
        original,
    );
    let over_fit =
        read(&state, QUERY_EFFECTIVE_SCALE, original) / read(&state, QUERY_FIT_SCALE, original);
    assert!((over_fit - 2.0).abs() < 1e-9, "{over_fit}");
}

#[test]
fn adopting_mid_pinch_at_100_percent_keeps_the_adopted_zoom_on_the_next_frame() {
    let placeholder = (2048.0, 1365.0);
    let original = (6000.0, 4000.0);
    let centroid = [1.0, 700.0, 300.0, 0.0];
    let mut state = [0.0; STATE_LEN];
    zoom(
        &mut state,
        OP_DOUBLE_TAP,
        [750.0, 375.0, 0.0, 0.0],
        placeholder,
    );
    zoom(&mut state, OP_PINCH_CHANGED, centroid, placeholder);
    zoom(
        &mut state,
        OP_ADOPT_IMAGE,
        [placeholder.0, placeholder.1, 700.0, 300.0],
        original,
    );
    let adopted = decode(&state);
    assert_eq!(adopted.pixel_scale, 1.0);
    zoom(&mut state, OP_PINCH_CHANGED, centroid, original);
    let next_frame = decode(&state);
    assert!(
        (next_frame.pixel_scale - 1.0).abs() < 1e-9,
        "{}",
        next_frame.pixel_scale
    );
    assert!((next_frame.pan_offset.width - adopted.pan_offset.width).abs() < 1e-9);
    assert!((next_frame.pan_offset.height - adopted.pan_offset.height).abs() < 1e-9);
    zoom(&mut state, OP_PINCH_ENDED, [1.0, 0.0, 0.0, 0.0], original);
    assert!((decode(&state).pixel_scale - 1.0).abs() < 1e-9);
}

/// Pinches at `magnification` on the placeholder, adopts the original, and
/// returns the adopted scale and the scale of an identical frame after it.
fn adopt_mid_pinch(start_at_100: bool, magnification: f64) -> (f64, f64) {
    let placeholder = (2048.0, 1365.0);
    let original = (6000.0, 4000.0);
    let mut state = [0.0; STATE_LEN];
    if start_at_100 {
        zoom(
            &mut state,
            OP_DOUBLE_TAP,
            [500.0, 375.0, 0.0, 0.0],
            placeholder,
        );
    }
    zoom(
        &mut state,
        OP_PINCH_CHANGED,
        [1.0, 500.0, 375.0, 0.0],
        placeholder,
    );
    zoom(
        &mut state,
        OP_PINCH_CHANGED,
        [magnification, 500.0, 375.0, 0.0],
        placeholder,
    );
    zoom(
        &mut state,
        OP_ADOPT_IMAGE,
        [placeholder.0, placeholder.1, 500.0, 375.0],
        original,
    );
    let adopted = read(&state, QUERY_EFFECTIVE_SCALE, original);
    zoom(
        &mut state,
        OP_PINCH_CHANGED,
        [magnification, 500.0, 375.0, 0.0],
        original,
    );
    (adopted, read(&state, QUERY_EFFECTIVE_SCALE, original))
}

#[test]
fn adopting_a_pinch_held_at_the_cap_does_not_jump_on_the_next_frame() {
    let (adopted, next_frame) = adopt_mid_pinch(true, 10.0);
    let fit_ratio = (1000.0 / 6000.0) / (1000.0 / 2048.0);
    assert!(
        (adopted - raw_core::canvas::MAX_PIXEL_SCALE * fit_ratio).abs() < 1e-9,
        "{adopted}"
    );
    assert!(
        (next_frame - adopted).abs() < 1e-9,
        "{adopted} → {next_frame}"
    );
}

#[test]
fn adopting_a_pinch_held_at_the_floor_does_not_jump_on_the_next_frame() {
    let (adopted, next_frame) = adopt_mid_pinch(false, 0.1);
    let floor = 0.5 * 1000.0 / 6000.0;
    assert!((adopted - floor).abs() < 1e-9, "{adopted}");
    assert!(
        (next_frame - adopted).abs() < 1e-9,
        "{adopted} → {next_frame}"
    );
}

#[test]
fn the_pinch_magnification_survives_a_reclamp_and_clears_when_the_pinch_ends() {
    let image = (2000.0, 1000.0);
    let mut state = [0.0; STATE_LEN];
    zoom(
        &mut state,
        OP_PINCH_CHANGED,
        [1.0, 500.0, 375.0, 0.0],
        image,
    );
    zoom(
        &mut state,
        OP_PINCH_CHANGED,
        [3.0, 500.0, 375.0, 0.0],
        image,
    );
    assert_eq!(decode(&state).pinch_last_magnification, 3.0);
    zoom(&mut state, OP_RECLAMP, [0.0; 4], image);
    assert_eq!(decode(&state).pinch_last_magnification, 3.0);
    zoom(&mut state, OP_PINCH_ENDED, [3.0, 0.0, 0.0, 0.0], image);
    assert_eq!(decode(&state).pinch_last_magnification, 0.0);
}

#[test]
fn adopting_mid_drag_keeps_the_drag_offset() {
    let placeholder = (2048.0, 1365.0);
    let original = (6000.0, 4000.0);
    let mut state = [0.0; STATE_LEN];
    zoom(
        &mut state,
        OP_DOUBLE_TAP,
        [500.0, 375.0, 0.0, 0.0],
        placeholder,
    );
    zoom(
        &mut state,
        OP_DRAG_CHANGED,
        [40.0, 30.0, 0.0, 0.0],
        placeholder,
    );
    zoom(
        &mut state,
        OP_ADOPT_IMAGE,
        [placeholder.0, placeholder.1, 500.0, 375.0],
        original,
    );
    let adopted = decode(&state).pan_offset;
    zoom(
        &mut state,
        OP_DRAG_CHANGED,
        [50.0, 30.0, 0.0, 0.0],
        original,
    );
    assert_eq!(
        decode(&state).pan_offset,
        Size::new(adopted.width + 10.0, adopted.height),
        "the next drag frame moves by its own delta, without a jump"
    );
}

#[test]
fn adopting_at_fill_re_resolves_fill_for_the_new_extent() {
    let mut state = [0.0; STATE_LEN];
    zoom(&mut state, OP_ADVANCE_STOP, [0.0; 4], (2000.0, 1000.0));
    zoom(
        &mut state,
        OP_ADOPT_IMAGE,
        [2000.0, 1000.0, 500.0, 375.0],
        (6000.0, 4000.0),
    );
    assert!(decode(&state).fills_viewport);
    let fill = read(&state, QUERY_EFFECTIVE_SCALE, (6000.0, 4000.0));
    assert!((fill - 750.0 / 4000.0).abs() < 1e-9, "{fill}");
}

fn drag(state: &mut [f64; STATE_LEN], x: f64, image: (f64, f64)) -> f64 {
    zoom(state, OP_DRAG_CHANGED, [x, 0.0, 0.0, 0.0], image);
    decode(state).pan_offset.width
}

#[test]
fn adopting_a_drag_held_at_the_pan_limit_does_not_jump_on_the_next_frame() {
    let placeholder = (2048.0, 1365.0);
    let original = (6000.0, 4000.0);
    let mut state = [0.0; STATE_LEN];
    zoom(
        &mut state,
        OP_DOUBLE_TAP,
        [500.0, 375.0, 0.0, 0.0],
        placeholder,
    );
    assert_eq!(
        drag(&mut state, 900.0, placeholder),
        524.0,
        "held at the edge"
    );
    zoom(
        &mut state,
        OP_ADOPT_IMAGE,
        [placeholder.0, placeholder.1, 500.0, 375.0],
        original,
    );
    let adopted = decode(&state).pan_offset.width;
    assert!((drag(&mut state, 900.0, original) - adopted).abs() < 1e-9);
    assert!((drag(&mut state, 901.0, original) - (adopted + 1.0)).abs() < 1e-9);
}

#[test]
fn a_viewport_change_mid_drag_continues_from_the_clamped_pan() {
    let image = (4000.0, 3000.0);
    let mut state = [0.0; STATE_LEN];
    zoom(&mut state, OP_DOUBLE_TAP, [500.0, 375.0, 0.0, 0.0], image);
    assert_eq!(drag(&mut state, 1400.0, image), 1400.0);
    // SAFETY: `state` is a live, exclusively borrowed STATE_LEN array.
    unsafe {
        maple_android_canvas_zoom(
            state.as_mut_ptr(),
            OP_RECLAMP,
            0.0,
            0.0,
            0.0,
            0.0,
            2000.0,
            750.0,
            image.0,
            image.1,
        );
    }
    let clamped = decode(&state).pan_offset.width;
    assert_eq!(clamped, 1000.0, "the wider viewport tightens the limit");
    assert_eq!(drag(&mut state, 1390.0, image), clamped - 10.0, "no jump");
}

#[test]
fn a_viewport_change_mid_pinch_at_fill_continues_from_the_frame_on_screen() {
    let image = (2000.0, 1000.0);
    let mut state = [0.0; STATE_LEN];
    zoom(&mut state, OP_ADVANCE_STOP, [0.0; 4], image);
    zoom(
        &mut state,
        OP_PINCH_CHANGED,
        [1.0, 500.0, 375.0, 0.0],
        image,
    );
    // SAFETY: `state` is a live, exclusively borrowed STATE_LEN array.
    unsafe {
        maple_android_canvas_zoom(
            state.as_mut_ptr(),
            OP_RECLAMP,
            0.0,
            0.0,
            0.0,
            0.0,
            1000.0,
            1000.0,
            image.0,
            image.1,
        );
    }
    let shown = decode(&state).pixel_scale;
    assert_eq!(shown, 0.75, "the old fill stays until the release");
    // SAFETY: as above.
    unsafe {
        maple_android_canvas_zoom(
            state.as_mut_ptr(),
            OP_PINCH_CHANGED,
            1.1,
            500.0,
            500.0,
            0.0,
            1000.0,
            1000.0,
            image.0,
            image.1,
        );
    }
    assert!((decode(&state).pixel_scale - shown * 1.1).abs() < 1e-9);
}

#[test]
fn adopting_after_the_post_pinch_pause_absorbed_movement_does_not_jump() {
    let placeholder = (2048.0, 1365.0);
    let original = (6000.0, 4000.0);
    let mut state = [0.0; STATE_LEN];
    zoom(
        &mut state,
        OP_DOUBLE_TAP,
        [500.0, 375.0, 0.0, 0.0],
        placeholder,
    );
    zoom(
        &mut state,
        OP_REBASE_DRAG,
        [60.0, 0.0, 0.0, 0.0],
        placeholder,
    );
    zoom(
        &mut state,
        OP_ADOPT_IMAGE,
        [placeholder.0, placeholder.1, 500.0, 375.0],
        original,
    );
    let adopted = decode(&state).pan_offset.width;
    assert!((drag(&mut state, 70.0, original) - (adopted + 10.0)).abs() < 1e-9);
}

#[test]
fn the_drag_translation_clears_when_the_drag_ends() {
    let image = (4000.0, 3000.0);
    let mut state = [0.0; STATE_LEN];
    zoom(&mut state, OP_DOUBLE_TAP, [500.0, 375.0, 0.0, 0.0], image);
    drag(&mut state, 30.0, image);
    zoom(&mut state, OP_DRAG_CHANGED, [30.0, -20.0, 0.0, 0.0], image);
    assert_eq!(
        decode(&state).drag_last_translation,
        Some(Size::new(30.0, -20.0)),
        "the last cumulative translation"
    );
    zoom(&mut state, OP_DRAG_ENDED, [0.0; 4], image);
    assert_eq!(decode(&state).drag_last_translation, None);
}
