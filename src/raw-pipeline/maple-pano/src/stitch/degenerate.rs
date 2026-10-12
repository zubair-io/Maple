//! Rotation-path degeneracy guard, split from `stitch/mod.rs` for the
//! file-size budget.
//!
//! A *connected* near-parallel / translational set forced through the
//! rotation path produces a BA solution whose spherical projection spans a
//! huge angular extent — the natural (unclamped) canvas balloons to tens or
//! hundreds of GB. The max_canvas_px cap only bites *inside* composite(),
//! after that giant buffer (and the decoded frames) are already allocated —
//! which is how a nadir set ballooned to ~317 GB (#1267). We fail fast here,
//! before any allocation, comparing the natural canvas pixel count to the cap.
//!
//! NOTE this is a *backstop*. A fully translational set whose frames don't
//! overlap rotationally (e.g. the pano_00 nadir set) disconnects in the
//! match graph and is already rejected earlier as TooFewSurvivors; `auto`
//! routes such sets to tile (#1271). This guard catches the remaining case:
//! frames that DO connect but whose rotation BA is degenerate enough to blow
//! up the canvas.
//!
//! Threshold = `DEGENERATE_CANVAS_RATIO`, a small multiple of the cap
//! (#1269: "a sane ceiling, a small multiple of max_canvas_px"). It is
//! single-sourced in `crate::canvas` so this guard and its unit tests can't
//! drift; see there for the measured anchors behind the value.

use crate::camera::Camera;
use crate::canvas::{natural_canvas_pixel_ratio, CanvasOptions, DEGENERATE_CANVAS_RATIO};
use crate::strategy::{StrategyReport, StrategyRequest};

use super::types::{StitchError, StitchOptions};

pub(super) fn reject_degenerate_canvas(
    kept_cams: &[Camera],
    canvas_opts: &CanvasOptions,
    strategy_report: &StrategyReport,
    opts: &StitchOptions,
) -> Result<(), StitchError> {
    if let Some(ratio) = natural_canvas_pixel_ratio(kept_cams, canvas_opts) {
        if ratio > DEGENERATE_CANVAS_RATIO {
            // Tailor the hint to how we ended up here.
            // - Auto chose rotation: the content-based vote said rotation, but
            //   the BA geometry is still degenerate.  The frames likely share
            //   only a thin sliver of overlap or the matched region is mostly
            //   planar — suggest Tile or recapture with more overlap.
            // - User forced --strategy rotation: the set may not be a rotation
            //   pano at all; suggest Auto or Tile.
            let hint = match strategy_report.requested {
                StrategyRequest::Auto => {
                    "Auto selected Rotation, but the solved geometry is degenerate — \
                     the frames may not form a true rotation panorama, or overlap is too \
                     narrow for a reliable rotation solve. Try --strategy Tile, or \
                     recapture with more overlap between frames."
                }
                _ => "try --strategy Auto or --strategy Tile",
            };
            return Err(StitchError::DegenerateGeometry(format!(
                "natural canvas is {ratio:.0}× larger than the {mp} MP cap — \
                 the rotation geometry is likely degenerate (near-parallel or \
                 translational frames). {hint} \
                 If this is a genuinely large panorama, raise --max-canvas-px.",
                mp = opts.max_canvas_px as f64 / 1_000_000.0,
            )));
        }
    }
    Ok(())
}
