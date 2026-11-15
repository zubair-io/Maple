use super::tests::{read, zoom};
use super::*;

const IMAGE: (f64, f64) = (4000.0, 3000.0);

fn context() -> CanvasZoomContext {
    Geometry::new(1000.0, 750.0, IMAGE.0, IMAGE.1).context()
}

fn scale(state: &[f64; STATE_LEN]) -> f64 {
    read(state, QUERY_EFFECTIVE_SCALE, IMAGE)
}

#[test]
fn keyboard_commands_write_the_shared_model_result_back() {
    let context = context();
    let mut state = [0.0; STATE_LEN];
    zoom(&mut state, OP_DOUBLE_TAP, [900.0, 700.0, 0.0, 0.0], IMAGE);
    let tapped = decode(&state);
    for (op, args, expected) in [
        (OP_ZOOM_TO_FIT, [0.0; 4], tapped.reset_to_fit(&context)),
        (
            OP_ZOOM_TO_SCALE,
            [1.0, 0.0, 0.0, 0.0],
            tapped.zoom_to_scale(1.0, &context),
        ),
        (OP_STEP_ZOOM_IN, [0.0; 4], tapped.step_zoom_in(&context)),
        (OP_STEP_ZOOM_OUT, [0.0; 4], tapped.step_zoom_out(&context)),
    ] {
        let mut slots = state;
        assert_eq!(zoom(&mut slots, op, args, IMAGE), 1, "op {op}");
        assert_eq!(decode(&slots), expected, "op {op}");
    }
}

#[test]
fn fit_and_actual_size_recentre_from_any_zoom() {
    let mut state = [0.0; STATE_LEN];
    zoom(&mut state, OP_DOUBLE_TAP, [900.0, 700.0, 0.0, 0.0], IMAGE);
    zoom(&mut state, OP_STEP_ZOOM_IN, [0.0; 4], IMAGE);
    assert_ne!(decode(&state).pan_offset, Size::ZERO);

    zoom(&mut state, OP_ZOOM_TO_SCALE, [1.0, 0.0, 0.0, 0.0], IMAGE);
    let actual = decode(&state);
    assert_eq!(
        (actual.pixel_scale, actual.pan_offset, actual.fills_viewport),
        (1.0, Size::ZERO, false)
    );

    zoom(&mut state, OP_ZOOM_TO_FIT, [0.0; 4], IMAGE);
    assert_eq!(state[..GEOMETRY_SLOT], [0.0; GEOMETRY_SLOT]);
}

#[test]
fn steps_run_from_the_floor_to_the_cap_and_stop_once_at_fit() {
    let mut state = [0.0; STATE_LEN];
    zoom(&mut state, OP_STEP_ZOOM_IN, [0.0; 4], IMAGE);
    assert!((scale(&state) - 0.3125).abs() < 1e-12, "fit × 1.25");
    zoom(&mut state, OP_STEP_ZOOM_OUT, [0.0; 4], IMAGE);
    assert_eq!(decode(&state).pixel_scale, 0.0, "back onto fit");

    zoom(&mut state, OP_STEP_ZOOM_OUT, [0.0; 4], IMAGE);
    assert!((scale(&state) - 0.2).abs() < 1e-12, "below fit");
    for _ in 0..4 {
        zoom(&mut state, OP_STEP_ZOOM_OUT, [0.0; 4], IMAGE);
    }
    assert_eq!(scale(&state), 0.125, "the floor is half of fit");
    zoom(&mut state, OP_STEP_ZOOM_IN, [0.0; 4], IMAGE);
    zoom(&mut state, OP_STEP_ZOOM_IN, [0.0; 4], IMAGE);
    zoom(&mut state, OP_STEP_ZOOM_IN, [0.0; 4], IMAGE);
    assert_eq!(
        decode(&state).pixel_scale,
        0.0,
        "zooming in from below stops at fit"
    );

    for _ in 0..40 {
        zoom(&mut state, OP_STEP_ZOOM_IN, [0.0; 4], IMAGE);
    }
    assert_eq!(scale(&state), 8.0, "the cap");
    let capped = state;
    zoom(&mut state, OP_STEP_ZOOM_IN, [0.0; 4], IMAGE);
    assert_eq!(state, capped, "a step at the cap changes nothing");
}

#[test]
fn a_command_mid_pinch_is_where_the_pinch_continues_from() {
    let mut state = [0.0; STATE_LEN];
    zoom(
        &mut state,
        OP_PINCH_CHANGED,
        [1.0, 500.0, 375.0, 0.0],
        IMAGE,
    );
    zoom(
        &mut state,
        OP_PINCH_CHANGED,
        [3.0, 500.0, 375.0, 0.0],
        IMAGE,
    );
    zoom(&mut state, OP_ZOOM_TO_SCALE, [1.0, 0.0, 0.0, 0.0], IMAGE);
    assert_eq!(decode(&state).pixel_scale, 1.0);
    zoom(
        &mut state,
        OP_PINCH_CHANGED,
        [3.0, 500.0, 375.0, 0.0],
        IMAGE,
    );
    assert_eq!(
        decode(&state).pixel_scale,
        1.0,
        "the same finger input holds the commanded zoom"
    );
    zoom(&mut state, OP_ZOOM_TO_FIT, [0.0; 4], IMAGE);
    zoom(
        &mut state,
        OP_PINCH_CHANGED,
        [3.0, 500.0, 375.0, 0.0],
        IMAGE,
    );
    assert_eq!(scale(&state), 0.25, "fit holds until the fingers move");
}
