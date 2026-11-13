use super::*;

const VIEWPORT: (f64, f64) = (1000.0, 750.0);

pub(super) fn zoom(
    state: &mut [f64; STATE_LEN],
    op: u32,
    args: [f64; 4],
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
            VIEWPORT.0,
            VIEWPORT.1,
            image.0,
            image.1,
        )
    }
}

pub(super) fn read(state: &[f64; STATE_LEN], which: u32, image: (f64, f64)) -> f64 {
    // SAFETY: `state` is a live STATE_LEN array.
    unsafe {
        maple_android_canvas_zoom_query(
            state.as_ptr(),
            which,
            VIEWPORT.0,
            VIEWPORT.1,
            image.0,
            image.1,
        )
    }
}

#[test]
fn fit_is_the_all_zero_state_kotlin_resets_to() {
    assert_eq!(encode(&CanvasZoomModel::default()), [0.0; MODEL_SLOTS]);
    assert_eq!(decode(&[0.0; STATE_LEN]), CanvasZoomModel::default());
}

#[test]
fn encode_round_trips_every_field() {
    let model = CanvasZoomModel {
        pixel_scale: 1.5,
        pan_offset: Size::new(-3.0, 4.0),
        base_pan: Size::new(5.0, -6.0),
        drag_translation_base: Some(Size::new(7.0, 8.0)),
        pinch_start_scale: Some(0.25),
        pinch_start_pan: Size::new(9.0, 10.0),
        pinch_start_centroid: Point::new(11.0, 12.0),
        pinch_last_centroid: Point::new(13.0, 14.0),
        pinch_start_magnification: 1.25,
        pinch_last_magnification: 1.75,
        drag_last_translation: Some(Size::new(15.0, -16.0)),
        fills_viewport: true,
    };
    assert_eq!(decode(&encode(&model)), model);
    let empty_options = CanvasZoomModel {
        drag_translation_base: None,
        pinch_start_scale: None,
        drag_last_translation: None,
        ..model
    };
    assert_eq!(decode(&encode(&empty_options)), empty_options);
}

#[test]
fn transitions_write_the_shared_model_result_back() {
    let image = (4000.0, 3000.0);
    let context = Geometry {
        viewport: Size::new(VIEWPORT.0, VIEWPORT.1),
        image: Size::new(image.0, image.1),
    }
    .context();
    let mut state = [0.0; STATE_LEN];
    assert_eq!(
        zoom(&mut state, OP_DOUBLE_TAP, [750.0, 375.0, 0.0, 0.0], image),
        1
    );
    let expected = CanvasZoomModel::default().double_tap(
        Point::new(750.0, 375.0),
        DoubleTapBehavior::ToggleFitAnd100,
        &context,
    );
    assert_eq!(decode(&state), expected);
    assert_eq!(read(&state, QUERY_EFFECTIVE_SCALE, image), 1.0);
    assert_eq!(read(&state, QUERY_FIT_SCALE, image), 0.25);
    assert_eq!(read(&state, QUERY_NEXT_STOP, image), 0.0, "100% → fit");

    assert_eq!(
        zoom(
            &mut state,
            OP_DRAG_CHANGED,
            [9000.0, -6000.0, 0.0, 0.0],
            image
        ),
        1
    );
    assert_eq!(
        decode(&state).pan_offset,
        Size::new(1500.0, -1125.0),
        "drag clamps at the image edge"
    );
    assert_eq!(zoom(&mut state, OP_DRAG_ENDED, [0.0; 4], image), 1);
    assert_eq!(decode(&state).base_pan, Size::new(1500.0, -1125.0));
}

#[test]
fn drag_at_fit_is_not_consumed() {
    let mut state = [0.0; STATE_LEN];
    let image = (4000.0, 3000.0);
    assert_eq!(
        zoom(&mut state, OP_DRAG_CHANGED, [50.0, 40.0, 0.0, 0.0], image),
        0
    );
    let model = decode(&state);
    assert_eq!((model.pixel_scale, model.pan_offset), (0.0, Size::ZERO));
    assert_eq!(zoom(&mut state, OP_DRAG_ENDED, [0.0; 4], image), 0);
    assert_eq!(state[..GEOMETRY_SLOT], [0.0; GEOMETRY_SLOT]);
}

#[test]
fn pinch_derives_from_cumulative_magnification_and_settles_on_release() {
    let image = (2000.0, 1000.0);
    let mut state = [0.0; STATE_LEN];
    zoom(
        &mut state,
        OP_PINCH_CHANGED,
        [1.0, 500.0, 375.0, 0.0],
        image,
    );
    assert_eq!(
        decode(&state).pixel_scale,
        0.0,
        "the capture frame changes nothing"
    );
    zoom(
        &mut state,
        OP_PINCH_CHANGED,
        [2.0, 500.0, 375.0, 0.0],
        image,
    );
    assert_eq!(decode(&state).pixel_scale, 1.0);
    zoom(
        &mut state,
        OP_PINCH_CHANGED,
        [2.0, 500.0, 375.0, 0.0],
        image,
    );
    assert_eq!(
        decode(&state).pixel_scale,
        1.0,
        "magnification does not compound"
    );
    zoom(&mut state, OP_PINCH_ENDED, [1.03, 0.0, 0.0, 0.0], image);
    assert_eq!(
        state[..GEOMETRY_SLOT],
        [0.0; GEOMETRY_SLOT],
        "within 4% of fit settles on fit"
    );

    zoom(
        &mut state,
        OP_PINCH_CHANGED,
        [1.0, 500.0, 375.0, 0.0],
        image,
    );
    zoom(
        &mut state,
        OP_PINCH_CHANGED,
        [0.01, 500.0, 375.0, 0.0],
        image,
    );
    assert_eq!(decode(&state).pixel_scale, 0.25, "the floor is half of fit");
    zoom(&mut state, OP_PINCH_ENDED, [0.01, 0.0, 0.0, 0.0], image);
    assert_eq!(
        state[..GEOMETRY_SLOT],
        [0.0; GEOMETRY_SLOT],
        "a release below fit returns to fit"
    );
}

#[test]
fn badge_cycles_fit_fill_and_100_percent() {
    let image = (2000.0, 1000.0);
    let mut state = [0.0; STATE_LEN];
    assert_eq!(read(&state, QUERY_NEXT_STOP, image), 1.0);
    zoom(&mut state, OP_ADVANCE_STOP, [0.0; 4], image);
    assert!(decode(&state).fills_viewport);
    assert_eq!(read(&state, QUERY_EFFECTIVE_SCALE, image), 0.75);
    assert_eq!(read(&state, QUERY_NEXT_STOP, image), 2.0);
    zoom(&mut state, OP_ADVANCE_STOP, [0.0; 4], image);
    assert_eq!(decode(&state).pixel_scale, 1.0);
    zoom(&mut state, OP_ADVANCE_STOP, [0.0; 4], image);
    assert_eq!(state[..GEOMETRY_SLOT], [0.0; GEOMETRY_SLOT]);
}

#[test]
fn null_state_and_unknown_ops_are_rejected_without_writing() {
    // SAFETY: a null state is the documented rejection case.
    let null = unsafe {
        maple_android_canvas_zoom(
            std::ptr::null_mut(),
            OP_RECLAMP,
            0.0,
            0.0,
            0.0,
            0.0,
            1.0,
            1.0,
            1.0,
            1.0,
        )
    };
    assert_eq!(null, REJECTED);
    // SAFETY: as above.
    let query = unsafe {
        maple_android_canvas_zoom_query(std::ptr::null(), QUERY_FIT_SCALE, 1.0, 1.0, 1.0, 1.0)
    };
    assert!(query.is_nan());
    let mut state = [0.0; STATE_LEN];
    state[0] = 2.0;
    let before = state;
    assert_eq!(zoom(&mut state, 99, [0.0; 4], (4000.0, 3000.0)), REJECTED);
    assert_eq!(state, before);
    assert!(read(&state, 99, (4000.0, 3000.0)).is_nan());
}

#[test]
fn non_finite_geometry_degrades_instead_of_panicking() {
    let mut state = [0.0; STATE_LEN];
    let nan = (f64::NAN, f64::INFINITY);
    assert_eq!(
        zoom(&mut state, OP_DOUBLE_TAP, [f64::NAN, 0.0, 0.0, 0.0], nan),
        1
    );
    assert!(read(&state, QUERY_FIT_SCALE, nan).is_finite());
}

#[test]
fn the_exported_state_length_is_the_layout_length() {
    assert_eq!(maple_android_canvas_zoom_state_len(), STATE_LEN);
}
