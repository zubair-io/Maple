//! The peak-memory model of a panorama stitch (#5454, #5555): what one costs, by phase.
//!
//! maple-pano refuses a stitch over its memory limit with these (#5835), and the Apple merge
//! sheet sizes the output with the same numbers through `tools/codegen.sh`, so neither carries
//! its own copy. No pixel-processing code reads them.
//!
//! A stitch peaks in one of two phases. The head (decode, matching, refinement) works on
//! full-resolution frames whatever the output size: a per-frame term (features, matches,
//! per-frame solve state) plus one for the largest frame (the banded decode and the refinement
//! windows). The composite still holds the per-frame state, plus a smaller term for the largest
//! frame (its source taps) and a term proportional to canvas width, because it streams
//! fixed-height strips whose buffers are output rows.
//!
//! Calibrated after banded decode and refinement and tap-only composite reads (#5552–#5566):
//! pano_00 (3 × 100.7 MP, tile, 12315 px wide) on an iPad adds 1263 MiB in the head and 593 MiB
//! in the composite; `maple-cli` on a Mac measures pano_00's composite at up to 1.2 GiB and
//! pano_01 (21 × 20.8 MP, rotation, 26981 px wide) at up to 1.8 GiB for the head and 2.8 GiB for
//! the composite. The constants are fitted to those five figures and round up, so each
//! overstates its measurement; the Mac's allocator keeps more than the iPad's, so the column
//! term is the Mac's. Every input frame counts, dropped or not.

/// Features, matches and per-frame solve state, held through both phases.
pub const PANO_BYTES_PER_FRAME: u64 = 80 << 20;

/// The banded decode and the refinement windows of the largest frame.
pub const PANO_HEAD_BYTES_PER_LARGEST_FRAME_PIXEL: u64 = 12;

/// The source rows of the largest frame that one composite strip taps.
pub const PANO_COMPOSITE_BYTES_PER_LARGEST_FRAME_PIXEL: u64 = 5;

/// The composite's strip buffers, which are output rows.
pub const PANO_COMPOSITE_BYTES_PER_CANVAS_COLUMN: u64 = 49_350;

/// ONNX Runtime with ALIKED and LightGlue loaded, on top of either phase. A two-frame stitch
/// on macOS CPU ONNX Runtime peaked at 4.65 GiB once the arena and memory pattern were off
/// (#1275), nearly all of it the runtime and the two models' weights; rounded up. The classical
/// matcher has no such floor, and iOS runs the models through CoreML, which this does not model.
pub const PANO_ML_RUNTIME_BYTES: u64 = 5 << 30;

/// The frames a stitch works on, as far as its memory goes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PanoStitchLoad {
    pub frame_count: u64,
    pub largest_frame_px: u64,
    pub ml_matcher: bool,
}

impl PanoStitchLoad {
    /// Peak of decode, matching and refinement.
    pub fn head_bytes(&self) -> u64 {
        self.held_bytes().saturating_add(
            self.largest_frame_px
                .saturating_mul(PANO_HEAD_BYTES_PER_LARGEST_FRAME_PIXEL),
        )
    }

    /// Peak of the composite onto a canvas `canvas_width` pixels wide.
    pub fn composite_bytes(&self, canvas_width: u64) -> u64 {
        self.held_bytes()
            .saturating_add(
                self.largest_frame_px
                    .saturating_mul(PANO_COMPOSITE_BYTES_PER_LARGEST_FRAME_PIXEL),
            )
            .saturating_add(canvas_width.saturating_mul(PANO_COMPOSITE_BYTES_PER_CANVAS_COLUMN))
    }

    fn held_bytes(&self) -> u64 {
        let runtime = if self.ml_matcher {
            PANO_ML_RUNTIME_BYTES
        } else {
            0
        };
        self.frame_count
            .saturating_mul(PANO_BYTES_PER_FRAME)
            .saturating_add(runtime)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GIB: f64 = (1u64 << 30) as f64;

    const PANO_01: PanoStitchLoad = PanoStitchLoad {
        frame_count: 21,
        largest_frame_px: 5272 * 3948,
        ml_matcher: false,
    };

    #[test]
    fn each_phase_overstates_the_pano_01_measurement_it_was_fitted_to() {
        let head = PANO_01.head_bytes() as f64 / GIB;
        let composite = PANO_01.composite_bytes(26_981) as f64 / GIB;
        assert!((1.8..2.0).contains(&head), "head {head:.2} GiB");
        assert!(
            (2.8..3.1).contains(&composite),
            "composite {composite:.2} GiB"
        );
    }

    #[test]
    fn a_narrower_canvas_lowers_only_the_composite() {
        assert!(PANO_01.composite_bytes(13_490) < PANO_01.composite_bytes(26_981));
        assert_eq!(
            PANO_01.composite_bytes(26_981) - PANO_01.composite_bytes(13_490),
            (26_981 - 13_490) * PANO_COMPOSITE_BYTES_PER_CANVAS_COLUMN
        );
    }

    #[test]
    fn the_ml_matcher_adds_its_runtime_to_both_phases() {
        let ml = PanoStitchLoad {
            ml_matcher: true,
            ..PANO_01
        };
        assert_eq!(
            ml.head_bytes() - PANO_01.head_bytes(),
            PANO_ML_RUNTIME_BYTES
        );
        assert_eq!(
            ml.composite_bytes(26_981) - PANO_01.composite_bytes(26_981),
            PANO_ML_RUNTIME_BYTES
        );
    }

    #[test]
    fn an_absurd_request_saturates_instead_of_wrapping() {
        let huge = PanoStitchLoad {
            frame_count: u64::MAX,
            largest_frame_px: u64::MAX,
            ml_matcher: true,
        };
        assert_eq!(huge.head_bytes(), u64::MAX);
        assert_eq!(huge.composite_bytes(u64::MAX), u64::MAX);
    }
}
