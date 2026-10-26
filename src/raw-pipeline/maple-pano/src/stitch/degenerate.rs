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
//!
//! The ratio is taken against the larger of the requested cap and the
//! default one (#5454): a caller asking for a smaller *output* (a phone
//! fitting its memory) has not made the geometry any more degenerate, and
//! the composite shrinks the canvas to that cap uniformly anyway.

use crate::camera::Camera;
use crate::canvas::{natural_canvas_pixel_ratio, CanvasOptions, DEGENERATE_CANVAS_RATIO};
use crate::strategy::{StrategyReport, StrategyRequest};

use super::types::{StitchError, StitchOptions, DEFAULT_MAX_CANVAS_PX};

pub(super) fn reject_degenerate_canvas(
    kept_cams: &[Camera],
    canvas_opts: &CanvasOptions,
    strategy_report: &StrategyReport,
    opts: &StitchOptions,
) -> Result<(), StitchError> {
    let guard_cap_px = opts.max_canvas_px.max(DEFAULT_MAX_CANVAS_PX);
    let guard_opts = guarded_canvas_opts(canvas_opts, opts.max_canvas_px, guard_cap_px);
    if let Some(ratio) = natural_canvas_pixel_ratio(kept_cams, &guard_opts) {
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
                mp = guard_cap_px as f64 / 1_000_000.0,
            )));
        }
    }
    Ok(())
}

/// `canvas_opts` with its pixel cap raised from `requested_cap_px` to
/// `guard_cap_px` in the same proportion — `canvas_opts` may be in proxy
/// pixels (the preview), where the cap is pre-divided by the frame scale.
fn guarded_canvas_opts(
    canvas_opts: &CanvasOptions,
    requested_cap_px: usize,
    guard_cap_px: usize,
) -> CanvasOptions {
    let raise = guard_cap_px as f64 / requested_cap_px.max(1) as f64;
    CanvasOptions {
        max_pixels: (canvas_opts.max_pixels as f64 * raise).round() as usize,
        ..canvas_opts.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts_with_cap(max_pixels: usize) -> CanvasOptions {
        CanvasOptions {
            max_pixels,
            ..Default::default()
        }
    }

    #[test]
    fn a_smaller_output_cap_is_guarded_at_the_default() {
        let guarded = guarded_canvas_opts(
            &opts_with_cap(16_000_000),
            16_000_000,
            DEFAULT_MAX_CANVAS_PX,
        );
        assert_eq!(guarded.max_pixels, DEFAULT_MAX_CANVAS_PX);
    }

    #[test]
    fn a_proxy_plane_cap_is_raised_in_proportion() {
        let guarded =
            guarded_canvas_opts(&opts_with_cap(1_000_000), 16_000_000, DEFAULT_MAX_CANVAS_PX);
        assert_eq!(guarded.max_pixels, 16_000_000);
    }

    #[test]
    fn a_larger_requested_cap_is_kept() {
        let guarded =
            guarded_canvas_opts(&opts_with_cap(1_000_000_000), 1_000_000_000, 1_000_000_000);
        assert_eq!(guarded.max_pixels, 1_000_000_000);
    }
}
