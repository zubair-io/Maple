//! Full stitch that can start from a preview's solved alignment (#4578).
//!
//! [`stitch_reusing`] fingerprints the inputs and geometry options; when an
//! offered [`SolvedAlignment`] carries the same fingerprint, decode-to-proxy,
//! feature extraction, matching, graph verification and strategy selection
//! are skipped and the tail starts straight from the stored graph. Otherwise
//! (or with nothing offered) stages 0–2 run exactly as [`super::stitch`]
//! always has. Either way the tail is the same function over the same
//! state, so the pixels match a fresh stitch with the same options.

use std::path::PathBuf;

use super::alignment::{usable, AlignmentKey, AlignmentReuse, SolvedAlignment};
use super::rotation_tail::rotation_tail;
use super::tile_stitch::{tile_tail, TileEarlyState};
use super::types::{StitchError, StitchOptions, StitchSuccess};

pub struct AlignedStitch {
    pub success: StitchSuccess,
    /// The alignment the tail ran from — the offered one when reused, the
    /// freshly solved one otherwise. Persist it to re-stitch later with
    /// different composite-only options without re-matching.
    pub alignment: SolvedAlignment,
    pub reuse: AlignmentReuse,
}

/// [`super::stitch`], starting from `offered` when its fingerprint matches
/// the current inputs and options. A mismatched alignment is never used —
/// the run re-solves and reports [`AlignmentReuse::Stale`] with the reason.
pub fn stitch_reusing(
    inputs: &[PathBuf],
    opts: &StitchOptions,
    offered: Option<&SolvedAlignment>,
    mut progress: impl FnMut(u32, f32),
    is_cancelled: impl Fn() -> bool,
) -> Result<AlignedStitch, StitchError> {
    if inputs.len() < 2 {
        return Err(StitchError::TooFewFrames(inputs.len()));
    }
    let key = AlignmentKey::for_run(inputs, opts)?;
    let (reusable, reuse) = usable(offered, &key);
    let (alignment, head_timings) = match reusable {
        Some(stored) => {
            (0..=2).for_each(|stage| progress(stage, 1.0));
            (stored.clone(), [0.0; 3])
        }
        None => {
            let head = super::solve_alignment(inputs, opts, key, &mut progress, &is_cancelled)?;
            (head.alignment, head.stage_timings_012)
        }
    };

    let success = match &alignment.tile_graph {
        Some(tile_graph) => StitchSuccess::Tile(tile_tail(
            TileEarlyState {
                full_dims: alignment.full_dims(),
                proxy_dims: alignment.proxy_dims(),
                graph: tile_graph.clone(),
                strategy_report: alignment.strategy_report.clone(),
                focal_seed_source: Some(alignment.focal_seed_source),
                stage_timings_012: head_timings,
                inputs,
            },
            opts,
            alignment.applied_opcodes(),
            alignment.priors(),
            &mut progress,
            &is_cancelled,
        )?),
        None => StitchSuccess::Rotation(rotation_tail(
            inputs,
            opts,
            &alignment,
            head_timings,
            &mut progress,
            &is_cancelled,
        )?),
    };

    Ok(AlignedStitch {
        success,
        alignment,
        reuse,
    })
}
