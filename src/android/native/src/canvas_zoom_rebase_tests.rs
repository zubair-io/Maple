//! The rebase rule (`canvas_zoom_live.rs`) as a property: after any event
//! that is not finger motion, the gesture's next frame with identical finger
//! input changes nothing on screen. Each event runs against every kind of
//! live gesture.

use super::*;
use raw_core::canvas::held_pinch_scale;

const VIEWPORT: (f64, f64) = (1000.0, 750.0);
const IMAGE: (f64, f64) = (4000.0, 3000.0);
const PLACEHOLDER: (f64, f64) = (2000.0, 1500.0);

#[derive(Clone, Copy, Debug, PartialEq)]
struct Layout {
    viewport: (f64, f64),
    image: (f64, f64),
}

const START: Layout = Layout {
    viewport: VIEWPORT,
    image: IMAGE,
};

/// The live gesture's latest frame, as Kotlin would send it again.
#[derive(Clone, Copy, Debug)]
enum Frame {
    Pinch {
        magnification: f64,
        centroid: (f64, f64),
    },
    Drag {
        translation: (f64, f64),
    },
}

fn send(state: &mut [f64; STATE_LEN], op: u32, args: [f64; 4], layout: Layout) -> i32 {
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
            layout.viewport.0,
            layout.viewport.1,
            layout.image.0,
            layout.image.1,
        )
    }
}

fn send_frame(state: &mut [f64; STATE_LEN], frame: Frame, layout: Layout) {
    match frame {
        Frame::Pinch {
            magnification,
            centroid: (x, y),
        } => send(state, OP_PINCH_CHANGED, [magnification, x, y, 0.0], layout),
        Frame::Drag {
            translation: (x, y),
        } => send(state, OP_DRAG_CHANGED, [x, y, 0.0, 0.0], layout),
    };
}

/// What the canvas draws: the effective scale and the pan.
fn visible(state: &[f64; STATE_LEN], layout: Layout) -> (f64, Size) {
    let geometry = Geometry::new(
        layout.viewport.0,
        layout.viewport.1,
        layout.image.0,
        layout.image.1,
    );
    let model = decode(state);
    (
        geometry.context().effective_scale(model.pixel_scale),
        model.pan_offset,
    )
}

fn assert_same_view(actual: (f64, Size), expected: (f64, Size), label: &str) {
    let close = |a: f64, b: f64| (a - b).abs() <= 1e-9 * a.abs().max(b.abs()).max(1.0);
    assert!(
        close(actual.0, expected.0)
            && close(actual.1.width, expected.1.width)
            && close(actual.1.height, expected.1.height),
        "{label}: {actual:?} != {expected:?}"
    );
}

/// A gesture in progress on `image`: the state and its latest frame.
fn live_gesture(name: &str, image: (f64, f64)) -> ([f64; STATE_LEN], Frame) {
    let layout = Layout { image, ..START };
    let mut state = [0.0; STATE_LEN];
    let frames = |state: &mut [f64; STATE_LEN], sequence: &[Frame]| {
        sequence
            .iter()
            .for_each(|&frame| send_frame(state, frame, layout));
        *sequence.last().expect("a gesture has a frame")
    };
    let pinch = |magnification, centroid| Frame::Pinch {
        magnification,
        centroid,
    };
    let drag = |x, y| Frame::Drag {
        translation: (x, y),
    };
    let at_actual_size = |state: &mut [f64; STATE_LEN]| {
        send(state, OP_DOUBLE_TAP, [500.0, 375.0, 0.0, 0.0], layout);
    };
    let frame = match name {
        "pinch at 100%" => {
            at_actual_size(&mut state);
            frames(
                &mut state,
                &[pinch(1.0, (500.0, 375.0)), pinch(2.0, (500.0, 375.0))],
            )
        }
        "pinch off-centre" => {
            at_actual_size(&mut state);
            frames(
                &mut state,
                &[pinch(1.0, (300.0, 200.0)), pinch(1.5, (340.0, 220.0))],
            )
        }
        "pinch at the cap" => {
            at_actual_size(&mut state);
            frames(
                &mut state,
                &[pinch(1.0, (400.0, 300.0)), pinch(50.0, (400.0, 300.0))],
            )
        }
        "pinch at the floor" => frames(
            &mut state,
            &[pinch(1.0, (500.0, 375.0)), pinch(0.01, (500.0, 375.0))],
        ),
        "pinch captured at 100%" => {
            at_actual_size(&mut state);
            frames(&mut state, &[pinch(1.0, (400.0, 300.0))])
        }
        "pinch below fit off-centre" => frames(
            &mut state,
            &[pinch(1.0, (300.0, 200.0)), pinch(0.7, (260.0, 190.0))],
        ),
        "free pinch just above fit" => frames(
            &mut state,
            &[pinch(1.0, (500.0, 375.0)), pinch(1.1, (520.0, 380.0))],
        ),
        "free drag" => {
            at_actual_size(&mut state);
            frames(&mut state, &[drag(100.0, 50.0), drag(300.0, 100.0)])
        }
        "drag at the limit" => {
            at_actual_size(&mut state);
            frames(&mut state, &[drag(100.0, 0.0), drag(9000.0, -9000.0)])
        }
        "drag rebased after a pinch" => {
            at_actual_size(&mut state);
            send(&mut state, OP_REBASE_DRAG, [50.0, 0.0, 0.0, 0.0], layout);
            frames(&mut state, &[drag(350.0, 20.0)])
        }
        _ => unreachable!("unknown gesture {name}"),
    };
    (state, frame)
}

const GESTURES: [&str; 10] = [
    "pinch at 100%",
    "pinch captured at 100%",
    "pinch off-centre",
    "pinch at the cap",
    "pinch at the floor",
    "pinch below fit off-centre",
    "free pinch just above fit",
    "free drag",
    "drag at the limit",
    "drag rebased after a pinch",
];

/// Besides plain resizes: a viewport whose larger floor lifts a pinch held at
/// the old floor, and one whose fit moves within snapping range of a free
/// pinch scale.
const LAYOUT_CHANGES: [Layout; 6] = [
    Layout {
        viewport: (2400.0, 1800.0),
        image: IMAGE,
    },
    Layout {
        viewport: (1080.0, 810.0),
        image: IMAGE,
    },
    Layout {
        viewport: (1200.0, 750.0),
        image: IMAGE,
    },
    Layout {
        viewport: (800.0, 600.0),
        image: IMAGE,
    },
    Layout {
        viewport: (750.0, 1000.0),
        image: IMAGE,
    },
    Layout {
        viewport: VIEWPORT,
        image: (3000.0, 4000.0),
    },
];

/// The property: after `event` leaves `state` showing some view under
/// `layout`, repeating `frame` there shows the same view.
fn assert_identical_frame_changes_nothing(
    mut state: [f64; STATE_LEN],
    frame: Frame,
    layout: Layout,
    label: &str,
) {
    let after_event = visible(&state, layout);
    send_frame(&mut state, frame, layout);
    assert_same_view(visible(&state, layout), after_event, label);
}

#[test]
fn a_reclamp_for_new_geometry_rebases_every_live_gesture() {
    for name in GESTURES {
        for layout in LAYOUT_CHANGES {
            let (mut state, frame) = live_gesture(name, IMAGE);
            send(&mut state, OP_RECLAMP, [0.0; 4], layout);
            let label = format!("{name}, reclamped for {layout:?}");
            assert_identical_frame_changes_nothing(state, frame, layout, &label);
        }
    }
}

/// Review on #5722: a new viewport mid-pinch re-resolved the zoom at rest
/// first, so a pinch below fit away from the centre snapped back to it. The
/// frame on screen stays, held only to the pinch's floor and cap there.
#[test]
fn new_geometry_mid_pinch_keeps_the_frame_on_screen() {
    for name in GESTURES
        .into_iter()
        .filter(|name| name.starts_with("pinch"))
    {
        for layout in LAYOUT_CHANGES {
            let (mut state, _) = live_gesture(name, IMAGE);
            let (scale, pan) = visible(&state, START);
            send(&mut state, OP_RECLAMP, [0.0; 4], layout);
            let context = Geometry::new(
                layout.viewport.0,
                layout.viewport.1,
                layout.image.0,
                layout.image.1,
            )
            .context();
            let held = held_pinch_scale(scale, context.fit_scale(), context.fill_scale());
            let label = format!("{name}, reclamped for {layout:?}");
            assert_same_view(visible(&state, layout), (held, pan), &label);
        }
    }
}

#[test]
fn a_frame_arriving_under_new_geometry_rebases_first() {
    for name in GESTURES {
        for layout in LAYOUT_CHANGES {
            let (state, frame) = live_gesture(name, IMAGE);
            let mut reclamped = state;
            send(&mut reclamped, OP_RECLAMP, [0.0; 4], layout);
            let mut direct = state;
            send_frame(&mut direct, frame, layout);
            let label = format!("{name}, first frame under {layout:?}");
            assert_same_view(
                visible(&direct, layout),
                visible(&reclamped, layout),
                &label,
            );
            assert_identical_frame_changes_nothing(direct, frame, layout, &label);
        }
    }
}

#[test]
fn adopting_the_original_rebases_every_live_gesture() {
    for name in GESTURES {
        let (mut state, frame) = live_gesture(name, PLACEHOLDER);
        send(
            &mut state,
            OP_ADOPT_IMAGE,
            [PLACEHOLDER.0, PLACEHOLDER.1, 500.0, 375.0],
            START,
        );
        let label = format!("{name}, original adopted");
        assert_identical_frame_changes_nothing(state, frame, START, &label);
    }
}

#[test]
fn reframing_the_image_rebases_every_live_gesture() {
    let cropped = Layout {
        image: (3200.0, 2400.0),
        ..START
    };
    for name in GESTURES {
        let (mut state, frame) = live_gesture(name, IMAGE);
        send(
            &mut state,
            OP_REFRAME_IMAGE,
            [400.0, 300.0, cropped.image.0, cropped.image.1],
            cropped,
        );
        let label = format!("{name}, image reframed");
        assert_identical_frame_changes_nothing(state, frame, cropped, &label);
    }
}

#[test]
fn a_finger_set_change_rebases_every_live_pinch_about_the_new_centroid() {
    for name in GESTURES
        .into_iter()
        .filter(|name| name.starts_with("pinch"))
    {
        let (mut state, frame) = live_gesture(name, IMAGE);
        let Frame::Pinch { magnification, .. } = frame else {
            unreachable!("{name} is a pinch");
        };
        let centroid = (620.0, 410.0);
        send(
            &mut state,
            OP_REBASE_PINCH,
            [centroid.0, centroid.1, 0.0, 0.0],
            START,
        );
        let label = format!("{name}, fingers changed");
        assert_same_view(
            visible(&state, START),
            visible(&live_gesture(name, IMAGE).0, START),
            &label,
        );
        let regrouped = Frame::Pinch {
            magnification,
            centroid,
        };
        assert_identical_frame_changes_nothing(state, regrouped, START, &label);
    }
}

#[test]
fn rebasing_a_pinch_with_no_pinch_in_progress_changes_nothing() {
    let (mut state, _) = live_gesture("free drag", IMAGE);
    let before = state;
    send(&mut state, OP_REBASE_PINCH, [620.0, 410.0, 0.0, 0.0], START);
    assert_eq!(state, before);
}

/// Codex on #5722: widening the viewport mid-pinch left the reclamped pan
/// unchanged, skipped the re-capture, and the next frame panned by 100.
#[test]
fn widening_mid_pinch_with_the_pan_unclamped_does_not_pan() {
    let (mut state, frame) = live_gesture("pinch at 100%", IMAGE);
    let wider = Layout {
        viewport: (1200.0, 750.0),
        ..START
    };
    send(&mut state, OP_RECLAMP, [0.0; 4], wider);
    assert_eq!(decode(&state).pan_offset, Size::ZERO);
    send_frame(&mut state, frame, wider);
    assert_eq!(decode(&state).pan_offset, Size::ZERO);
}

/// Codex on #5722: fingers at 300 and 700, a third lands at 800, and all
/// three spread 2× about x = 600. The pinch pivots on the three-finger
/// centroid, so the image point under it stays put.
#[test]
fn a_third_finger_moves_the_pinch_pivot_to_the_true_centroid() {
    let mut state = [0.0; STATE_LEN];
    send(
        &mut state,
        OP_PINCH_CHANGED,
        [1.0, 500.0, 375.0, 0.0],
        START,
    );
    send(&mut state, OP_REBASE_PINCH, [600.0, 375.0, 0.0, 0.0], START);
    send(
        &mut state,
        OP_PINCH_CHANGED,
        [2.0, 600.0, 375.0, 0.0],
        START,
    );
    assert_eq!(decode(&state).pan_offset, Size::new(-100.0, 0.0));
}

#[test]
fn a_query_under_new_geometry_reads_the_rebased_zoom() {
    let panorama = Layout {
        image: (2000.0, 1000.0),
        ..START
    };
    let mut state = [0.0; STATE_LEN];
    send(&mut state, OP_ADVANCE_STOP, [0.0; 4], panorama);
    assert!(decode(&state).fills_viewport);
    // SAFETY: `state` is a live STATE_LEN array.
    let scale = unsafe {
        maple_android_canvas_zoom_query(
            state.as_ptr(),
            QUERY_EFFECTIVE_SCALE,
            1000.0,
            900.0,
            panorama.image.0,
            panorama.image.1,
        )
    };
    assert_eq!(scale, 0.9, "fill re-resolves for the taller viewport");
}
