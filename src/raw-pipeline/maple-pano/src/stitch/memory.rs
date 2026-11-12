//! A stitch's memory limit (#5835): the run is refused, not attempted, when
//! the [`raw_core::pano_memory`] model puts a phase above
//! [`StitchOptions::memory_limit_bytes`], costed with the server's calibration
//! (#5891): only the server sets a limit. The head is checked from the
//! inputs' headers before any frame is decoded; the composite is checked
//! once the canvas is solved, since its cost depends on the canvas width.

use std::path::PathBuf;

use raw_core::pano_memory::{PanoMemoryProfile, PanoStitchLoad};

use super::{frames, StitchError, StitchOptions};

/// Refuse when decoding, matching and refining `inputs` would exceed the
/// limit. Reads headers only, and nothing at all without a limit.
pub(super) fn admit_head(inputs: &[PathBuf], opts: &StitchOptions) -> Result<(), StitchError> {
    let Some(limit) = opts.memory_limit_bytes else {
        return Ok(());
    };
    within(load(frames::input_dims(inputs)?, opts).head_bytes(), limit)
}

/// Refuse when compositing frames of `full_dims` onto a canvas
/// `canvas_width` pixels wide would exceed the limit.
pub(super) fn admit_composite(
    full_dims: impl IntoIterator<Item = (u32, u32)>,
    canvas_width: u32,
    opts: &StitchOptions,
) -> Result<(), StitchError> {
    let Some(limit) = opts.memory_limit_bytes else {
        return Ok(());
    };
    within(
        load(full_dims, opts).composite_bytes(u64::from(canvas_width)),
        limit,
    )
}

fn load(full_dims: impl IntoIterator<Item = (u32, u32)>, opts: &StitchOptions) -> PanoStitchLoad {
    let (frame_count, largest_frame_px) =
        full_dims
            .into_iter()
            .fold((0, 0), |(count, largest): (u64, u64), (w, h)| {
                (count + 1, largest.max(u64::from(w) * u64::from(h)))
            });
    PanoStitchLoad {
        frame_count,
        largest_frame_px,
        proxy_long_edge: u64::from(opts.proxy_long_edge),
        ml_matcher: opts.feature_engine.is_ml(),
        profile: PanoMemoryProfile::Server,
    }
}

fn within(needed: u64, limit: u64) -> Result<(), StitchError> {
    if needed > limit {
        return Err(StitchError::InsufficientMemory { needed, limit });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const PANO_01: [(u32, u32); 21] = [(5272, 3948); 21];

    fn limited(bytes: u64) -> StitchOptions {
        StitchOptions {
            memory_limit_bytes: Some(bytes),
            ..StitchOptions::default()
        }
    }

    fn composite_bytes(canvas_width: u32) -> u64 {
        load(PANO_01, &StitchOptions::default()).composite_bytes(u64::from(canvas_width))
    }

    #[test]
    fn the_composite_is_admitted_at_its_estimate_and_refused_one_byte_under() {
        let needed = composite_bytes(26_981);
        assert!(admit_composite(PANO_01, 26_981, &limited(needed)).is_ok());
        match admit_composite(PANO_01, 26_981, &limited(needed - 1)) {
            Err(StitchError::InsufficientMemory {
                needed: reported,
                limit,
            }) => {
                assert_eq!(reported, needed);
                assert_eq!(limit, needed - 1);
            }
            other => panic!("expected InsufficientMemory, got {other:?}"),
        }
    }

    #[test]
    fn a_narrower_canvas_fits_a_limit_the_full_one_does_not() {
        let opts = limited(composite_bytes(13_490));
        assert!(admit_composite(PANO_01, 13_490, &opts).is_ok());
        assert!(admit_composite(PANO_01, 26_981, &opts).is_err());
    }

    #[test]
    fn every_frame_counts_and_the_largest_sets_the_per_pixel_term() {
        let mixed = [(1_000, 1_000), (4_000, 3_000), (2_000, 1_000)];
        let mixed_load = load(mixed, &StitchOptions::default());
        assert_eq!(mixed_load.frame_count, 3);
        assert_eq!(mixed_load.largest_frame_px, 12_000_000);
    }

    #[test]
    fn a_proxy_edge_past_the_fitted_one_counts_its_retained_proxies() {
        let frames = [(4_000, 3_000); 50];
        let rgb_f32_proxies: u64 = 50 * 2_800 * 2_100 * 12;
        let opts = StitchOptions {
            proxy_long_edge: 2_800,
            ..limited(3_000_000_000)
        };
        let loaded = load(frames, &opts);
        assert!(loaded.head_bytes() > rgb_f32_proxies);
        assert!(loaded.composite_bytes(0) > rgb_f32_proxies);
        assert!(matches!(
            within(loaded.head_bytes(), 3_000_000_000),
            Err(StitchError::InsufficientMemory { .. })
        ));
    }

    #[test]
    fn no_limit_admits_without_reading_any_input() {
        let missing = [PathBuf::from("/nonexistent/a.dng")];
        assert!(admit_head(&missing, &StitchOptions::default()).is_ok());
        assert!(admit_composite(PANO_01, u32::MAX, &StitchOptions::default()).is_ok());
    }

    #[test]
    fn a_limit_reports_an_unreadable_input_instead_of_admitting_it() {
        let missing = [PathBuf::from("/nonexistent/a.dng")];
        assert!(matches!(
            admit_head(&missing, &limited(u64::MAX)),
            Err(StitchError::Decode { .. })
        ));
    }
}
