//! Two-phase render scheduling rules: the decisions behind the fast phase
//! (every tick, immediately), the debounced refine phase, and
//! generation-counter staleness. Timers, tasks and threads stay with each
//! platform; these functions answer "which generation is current", "may this
//! refine be scheduled" and "which refine should run".
//!
//! Lifecycle: every fast schedule cancels the previous fast and refine work
//! and advances the generation. A refine waits `REFINE_DEBOUNCE_MS` after the
//! last schedule, is cancelled by any newer schedule, and never advances the
//! generation, so a pan or resize refine does not invalidate the latest fast
//! publish. Work publishes only while its generation is still current.

use super::geometry::{Rect, Size};
use super::native_detail::native_detail_should_render;

/// Delay between the last schedule and the refine pass. During a continuous
/// drag every tick cancels the pending refine, so many ticks collapse into
/// one full-resolution pass once the user pauses.
pub const REFINE_DEBOUNCE_MS: u64 = 150;

/// The scheduler's generation counter. The counter wraps rather than
/// overflowing; only equality is ever compared.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct RenderSchedule {
    generation: u64,
}

impl RenderSchedule {
    #[must_use]
    pub const fn new(generation: u64) -> Self {
        Self { generation }
    }

    /// The generation work must still match before it publishes.
    #[must_use]
    pub const fn generation(self) -> u64 {
        self.generation
    }

    /// A fast schedule: the host cancels the in-flight fast and refine work
    /// and runs the new fast pass with the returned generation.
    #[must_use]
    pub const fn after_render_scheduled(self) -> Self {
        Self::new(self.generation.wrapping_add(1))
    }

    /// Asset switch or teardown: the host cancels everything, and anything
    /// still in flight becomes stale.
    #[must_use]
    pub const fn after_cancel_all(self) -> Self {
        Self::new(self.generation.wrapping_add(1))
    }

    /// Whether a refine may replace the pending one. A refine chained from a
    /// fast pass carries that pass's generation; once a newer pass exists the
    /// stale tail is refused before it can cancel the newer refine (#3363).
    /// A refine with no expected generation (pan, zoom, resize) is always
    /// admitted.
    #[must_use]
    pub fn admits_refine(self, expected_generation: Option<u64>) -> bool {
        expected_generation.is_none_or(|expected| expected == self.generation)
    }

    /// Whether work started at `generation` may still publish.
    #[must_use]
    pub const fn is_current(self, generation: u64) -> bool {
        generation == self.generation
    }
}

/// The state a refine pass reads to pick its route.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct RefineContext {
    /// A non-identity crop applies with the crop tool closed. The native
    /// patch addresses full-frame geometry while the canvas then works in
    /// cropped coordinates, so only the whole-image refine is crop-aware.
    pub crop_applied: bool,
    pub is_raw: bool,
    /// The RAW has a file the native-detail tile entry can open.
    pub has_source_file: bool,
    /// Real pixels per image pixel, `0` = fit.
    pub pixel_scale: f64,
    /// Visible region in oriented source pixels.
    pub visible_rect: Rect,
    /// Oriented source size; zero until known.
    pub image_size: Size,
}

/// Whether the refine should try the native-detail patch before the
/// whole-image refine. When it fails the whole-image refine still runs.
#[must_use]
pub fn refine_tries_native_detail(context: RefineContext) -> bool {
    !context.crop_applied
        && context.is_raw
        && context.has_source_file
        && native_detail_should_render(
            context.pixel_scale,
            context.visible_rect,
            context.image_size,
        )
}

/// Whether the whole-image refine would render no larger than the fast pass
/// already did (within one pixel per axis), so it can be skipped. False when
/// either target is unknown.
#[must_use]
pub fn refine_matches_fast_target(fast_target: Option<Size>, refined_target: Option<Size>) -> bool {
    match (fast_target, refined_target) {
        (Some(fast), Some(refined)) => {
            refined.width <= fast.width + 1.0 && refined.height <= fast.height + 1.0
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_schedule_advances_the_generation_and_stales_older_work() {
        let first = RenderSchedule::default().after_render_scheduled();
        assert_eq!(first.generation(), 1);
        let second = first.after_render_scheduled();
        assert!(!second.is_current(first.generation()));
        assert!(second.is_current(second.generation()));
    }

    #[test]
    fn cancel_all_stales_everything_in_flight() {
        let schedule = RenderSchedule::new(7);
        let cancelled = schedule.after_cancel_all();
        assert!(!cancelled.is_current(7));
        assert_eq!(cancelled.generation(), 8);
    }

    #[test]
    fn generation_wraps_instead_of_overflowing() {
        let wrapped = RenderSchedule::new(u64::MAX).after_render_scheduled();
        assert_eq!(wrapped.generation(), 0);
        assert!(wrapped.is_current(0));
    }

    #[test]
    fn stale_fast_tail_cannot_schedule_a_refine() {
        let schedule = RenderSchedule::new(3);
        assert!(schedule.admits_refine(Some(3)));
        assert!(!schedule.admits_refine(Some(2)));
        assert!(schedule.admits_refine(None));
    }

    fn native_context() -> RefineContext {
        RefineContext {
            crop_applied: false,
            is_raw: true,
            has_source_file: true,
            pixel_scale: 1.0,
            visible_rect: Rect::new(100.0, 100.0, 800.0, 600.0),
            image_size: Size::new(6000.0, 4000.0),
        }
    }

    #[test]
    fn refine_tries_native_detail_only_for_uncropped_raw_files_at_one_to_one() {
        assert!(refine_tries_native_detail(native_context()));
        let rejected = [
            RefineContext {
                crop_applied: true,
                ..native_context()
            },
            RefineContext {
                is_raw: false,
                ..native_context()
            },
            RefineContext {
                has_source_file: false,
                ..native_context()
            },
            RefineContext {
                pixel_scale: 0.5,
                ..native_context()
            },
            RefineContext {
                visible_rect: Rect::new(0.0, 0.0, 6000.0, 4000.0),
                ..native_context()
            },
        ];
        for context in rejected {
            assert!(!refine_tries_native_detail(context), "{context:?}");
        }
    }

    #[test]
    fn refine_is_skipped_only_when_no_larger_than_the_fast_target() {
        let fast = Some(Size::new(1000.0, 800.0));
        assert!(refine_matches_fast_target(
            fast,
            Some(Size::new(1001.0, 801.0))
        ));
        assert!(!refine_matches_fast_target(
            fast,
            Some(Size::new(1002.0, 800.0))
        ));
        assert!(!refine_matches_fast_target(
            fast,
            Some(Size::new(1000.0, 802.0))
        ));
        assert!(!refine_matches_fast_target(None, Some(Size::new(1.0, 1.0))));
        assert!(!refine_matches_fast_target(fast, None));
        assert!(!refine_matches_fast_target(
            fast,
            Some(Size::new(f64::NAN, 1.0))
        ));
    }
}
