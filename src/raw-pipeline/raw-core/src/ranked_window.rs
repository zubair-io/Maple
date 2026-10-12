//! The ranked search window's ladder (#4514): how deep a free-text search ranks before it filters.
//!
//! The Self Hosted API widens a window up this ladder, and the Apple search client keys its facet
//! cache on the same steps, so both read these through `tools/codegen.sh` rather than each
//! carrying its own copy (#4545). No pixel-processing code reads them.

/// The depth a window starts at, and the in-process engine's candidate count.
pub const RANKED_WINDOW_BASE: u32 = 100;

/// The deepest a window goes. Ranking costs about the same at any depth (every match is scored
/// either way), but each hit in the window is a keyed probe, so this caps the join at 5,000.
pub const RANKED_WINDOW_MAX: u32 = 5_000;

/// How much deeper each widening asks: 100, 400, 1,600, then the cap.
pub const RANKED_WINDOW_WIDENING_FACTOR: u32 = 4;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ladder_climbs_to_the_cap() {
        let steps: Vec<u32> = std::iter::successors(Some(RANKED_WINDOW_BASE), |step| {
            (*step < RANKED_WINDOW_MAX)
                .then(|| (step * RANKED_WINDOW_WIDENING_FACTOR).min(RANKED_WINDOW_MAX))
        })
        .collect();
        assert_eq!(steps, [100, 400, 1_600, 5_000]);
    }
}
