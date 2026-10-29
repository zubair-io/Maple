//! User seam constraints (#4520) at the stitch boundary: callers name
//! frames by input index, but bundle adjustment can drop frames, so the
//! composite sees a compacted list. This module rejects requests the
//! rotation tail cannot honour before any work runs, and renumbers the
//! surviving constraints into composite order.

use crate::error::PanoError;
use crate::seam::{SeamConstraint, SeamConstraintError, SeamStrategy};
use crate::strategy::StrategyRequest;

use super::types::{StitchError, StitchOptions};

pub(super) fn validate(opts: &StitchOptions, n_inputs: usize) -> Result<(), StitchError> {
    if opts.seam_constraints.is_empty() {
        return Ok(());
    }
    if opts.seam_strategy != SeamStrategy::GraphCut || opts.strategy == StrategyRequest::Tile {
        return Err(SeamConstraintError::RequiresGraphCut.into());
    }
    opts.seam_constraints
        .iter()
        .find(|c| c.frame() >= n_inputs)
        .map_or(Ok(()), |c| {
            Err(SeamConstraintError::UnknownFrame {
                frame: c.frame(),
                frames: n_inputs,
            }
            .into())
        })
}

/// The tile tail has no graph-cut seam, so an `Auto` run that lands there
/// cannot honour constraints.
pub(super) fn reject_on_tile(opts: &StitchOptions) -> Result<(), StitchError> {
    if opts.seam_constraints.is_empty() {
        Ok(())
    } else {
        Err(SeamConstraintError::RequiresGraphCut.into())
    }
}

/// Renumber constraints from input order into composite order. An exclude
/// on a dropped frame already holds; an include on one cannot.
pub(super) fn for_kept_frames(
    constraints: &[SeamConstraint],
    kept_inputs: &[usize],
) -> Result<Vec<SeamConstraint>, StitchError> {
    constraints
        .iter()
        .filter_map(|c| {
            let kept = kept_inputs.iter().position(|&i| i == c.frame());
            match (kept, c) {
                (Some(k), _) => Some(Ok(c.with_frame(k))),
                (None, SeamConstraint::ForceExclude(..)) => None,
                (None, SeamConstraint::ForceInclude(f, _)) => Some(Err(
                    SeamConstraintError::IncludeDroppedFrame { frame: *f }.into(),
                )),
            }
        })
        .collect()
}

pub(super) fn composite_error(e: PanoError) -> StitchError {
    match e {
        PanoError::SeamConstraint(c) => StitchError::SeamConstraint(c),
        PanoError::Cancelled => StitchError::Cancelled,
        other => StitchError::Composite(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::seam::CanvasRect;

    const R: CanvasRect = CanvasRect {
        x: 0,
        y: 0,
        width: 4,
        height: 4,
    };

    fn opts(constraints: Vec<SeamConstraint>, seam_strategy: SeamStrategy) -> StitchOptions {
        StitchOptions {
            seam_constraints: constraints,
            seam_strategy,
            ..StitchOptions::default()
        }
    }

    #[test]
    fn constraints_need_graph_cut_and_known_frames() {
        let inc = vec![SeamConstraint::ForceInclude(2, R)];
        assert!(validate(&opts(vec![], SeamStrategy::Voronoi), 3).is_ok());
        assert!(matches!(
            validate(&opts(inc.clone(), SeamStrategy::Voronoi), 3),
            Err(StitchError::SeamConstraint(
                SeamConstraintError::RequiresGraphCut
            ))
        ));
        assert!(validate(&opts(inc.clone(), SeamStrategy::GraphCut), 3).is_ok());
        assert!(matches!(
            validate(&opts(inc, SeamStrategy::GraphCut), 2),
            Err(StitchError::SeamConstraint(
                SeamConstraintError::UnknownFrame {
                    frame: 2,
                    frames: 2
                }
            ))
        ));
    }

    #[test]
    fn constraints_follow_frames_through_drops() {
        let kept = [0, 2, 3];
        let renumbered = for_kept_frames(
            &[
                SeamConstraint::ForceInclude(3, R),
                SeamConstraint::ForceExclude(1, R),
                SeamConstraint::ForceExclude(2, R),
            ],
            &kept,
        )
        .expect("satisfiable");
        assert_eq!(
            renumbered,
            vec![
                SeamConstraint::ForceInclude(2, R),
                SeamConstraint::ForceExclude(1, R)
            ]
        );
        assert!(matches!(
            for_kept_frames(&[SeamConstraint::ForceInclude(1, R)], &kept),
            Err(StitchError::SeamConstraint(
                SeamConstraintError::IncludeDroppedFrame { frame: 1 }
            ))
        ));
    }
}
