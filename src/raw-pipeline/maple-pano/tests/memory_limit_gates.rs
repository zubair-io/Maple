//! #5835 — the stitch's memory limit, end to end on real frames: a ring of
//! LinearRaw DNGs written by `pano-gen-fixture` into a temp dir and stitched
//! with the classical matcher, so no ONNX Runtime, models or fixtures are
//! involved and it runs on every CI runner:
//!
//! ```text
//! cargo test -p maple-pano --no-default-features \
//!     --features classical-features --test memory_limit_gates
//! ```

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::process::Command;

use maple_pano::composite::CanvasSink;
use maple_pano::ingest::PlanarImage;
use maple_pano::stitch::{stitch, FeatureEngine, StitchError, StitchOptions};
use maple_pano::PanoError;
use raw_core::pano_memory::{PanoMemoryProfile, PanoStitchLoad};

const FRAMES: u32 = 3;
const FRAME_WIDTH: u32 = 640;
const FRAME_HEIGHT: u32 = 480;

const LOAD: PanoStitchLoad = PanoStitchLoad {
    frame_count: FRAMES as u64,
    largest_frame_px: (FRAME_WIDTH * FRAME_HEIGHT) as u64,
    ml_matcher: false,
    profile: PanoMemoryProfile::Server,
};

fn generate_ring(dir: &Path) -> Vec<PathBuf> {
    let status = Command::new(env!("CARGO_BIN_EXE_pano-gen-fixture"))
        .arg("--out-dir")
        .arg(dir)
        .args(["--cameras", &FRAMES.to_string()])
        .args(["--width", &FRAME_WIDTH.to_string()])
        .args(["--height", &FRAME_HEIGHT.to_string()])
        .args(["--source-width", "2048"])
        .status()
        .expect("ran pano-gen-fixture");
    assert!(status.success(), "pano-gen-fixture failed: {status}");
    (0..FRAMES)
        .map(|i| dir.join(format!("frame_{i:04}.dng")))
        .collect()
}

#[derive(Default)]
struct Recorder {
    canvas: Option<(u32, u32)>,
    rows: u32,
}

impl CanvasSink for Recorder {
    fn begin(&mut self, width: u32, height: u32) -> Result<(), PanoError> {
        self.canvas = Some((width, height));
        Ok(())
    }

    fn rows(&mut self, strip: &PlanarImage) -> Result<(), PanoError> {
        self.rows += strip.height();
        Ok(())
    }
}

struct Run {
    outcome: Result<(u32, u32), StitchError>,
    stages: Vec<u32>,
    sink: Recorder,
}

fn run(inputs: &[PathBuf], memory_limit_bytes: Option<u64>) -> Run {
    let opts = StitchOptions {
        feature_engine: FeatureEngine::Classical,
        memory_limit_bytes,
        ..StitchOptions::default()
    };
    let stages = RefCell::new(Vec::new());
    let mut sink = Recorder::default();
    let outcome = stitch(
        inputs,
        &opts,
        &mut sink,
        |stage, _| stages.borrow_mut().push(stage),
        || false,
    )
    .map(|success| success.canvas_size());
    Run {
        outcome,
        stages: stages.into_inner(),
        sink,
    }
}

fn refusal(run: &Run) -> (u64, u64) {
    match &run.outcome {
        Err(StitchError::InsufficientMemory { needed, limit }) => (*needed, *limit),
        Err(other) => panic!("expected InsufficientMemory, got {other}"),
        Ok(canvas) => panic!("expected InsufficientMemory, stitched {canvas:?}"),
    }
}

#[test]
fn a_limit_under_the_head_refuses_before_any_frame_is_decoded() {
    let dir = tempfile::tempdir().expect("tempdir");
    let inputs = generate_ring(dir.path());
    let head = LOAD.head_bytes();

    let refused = run(&inputs, Some(head - 1));

    assert_eq!(refusal(&refused), (head, head - 1));
    assert!(
        refused.stages.is_empty(),
        "stages ran: {:?}",
        refused.stages
    );
    assert_eq!(refused.sink.canvas, None);
}

#[test]
fn a_limit_under_the_composite_refuses_once_the_canvas_is_solved_and_composites_nothing() {
    let dir = tempfile::tempdir().expect("tempdir");
    let inputs = generate_ring(dir.path());

    let unlimited = run(&inputs, None);
    let (width, height) = match unlimited.outcome {
        Ok(canvas) => canvas,
        Err(e) => panic!("the unlimited stitch failed: {e}"),
    };
    assert_eq!(unlimited.sink.canvas, Some((width, height)));
    assert_eq!(unlimited.sink.rows, height);

    let composite = LOAD.composite_bytes(u64::from(width));
    assert!(
        composite > LOAD.head_bytes(),
        "the canvas must cost more than the head for this gate to reach the second check"
    );

    let refused = run(&inputs, Some(composite - 1));
    assert_eq!(refusal(&refused), (composite, composite - 1));
    assert!(
        refused.stages.contains(&4),
        "the solve never ran: {:?}",
        refused.stages
    );
    assert_eq!(refused.sink.canvas, None);
    assert_eq!(refused.sink.rows, 0);

    let admitted = run(&inputs, Some(composite));
    assert_eq!(admitted.outcome.ok(), Some((width, height)));
    assert_eq!(admitted.sink.rows, height);
}
