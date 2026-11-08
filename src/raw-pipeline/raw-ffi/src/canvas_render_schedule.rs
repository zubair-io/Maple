//! Two-phase render scheduling rules over FFI (#5714). The host keeps a
//! `MapleCanvasRenderSchedule` value, passes it through each transition and
//! keeps its own timers and tasks; Rust answers which generation is current,
//! whether a refine may be scheduled and which refine route runs. Flags are
//! `u8` (nonzero = true).

use crate::canvas_math::{MapleCanvasRect, MapleCanvasSize};
use raw_core::canvas::{self, RefineContext, RenderSchedule};

/// The scheduler's generation counter; all-zero is a fresh scheduler.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MapleCanvasRenderSchedule {
    pub generation: u64,
}

/// The state a refine pass reads to pick its route; see
/// `raw_core::canvas::RefineContext`.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MapleCanvasRefineContext {
    pub crop_applied: u8,
    pub is_raw: u8,
    pub has_source_file: u8,
    pub pixel_scale: f64,
    pub visible_rect: MapleCanvasRect,
    pub image_size: MapleCanvasSize,
}

impl From<MapleCanvasRenderSchedule> for RenderSchedule {
    fn from(schedule: MapleCanvasRenderSchedule) -> Self {
        RenderSchedule::new(schedule.generation)
    }
}

impl From<RenderSchedule> for MapleCanvasRenderSchedule {
    fn from(schedule: RenderSchedule) -> Self {
        Self {
            generation: schedule.generation(),
        }
    }
}

/// Milliseconds between the last schedule and the refine pass.
#[no_mangle]
pub extern "C" fn maple_canvas_refine_debounce_ms() -> u64 {
    crate::error::catch_panic(
        "maple_canvas_refine_debounce_ms",
        canvas::REFINE_DEBOUNCE_MS,
        || canvas::REFINE_DEBOUNCE_MS,
    )
}

/// A fast schedule: the returned generation is the new current one.
#[no_mangle]
pub extern "C" fn maple_canvas_render_schedule_render(
    schedule: MapleCanvasRenderSchedule,
) -> MapleCanvasRenderSchedule {
    crate::error::catch_panic("maple_canvas_render_schedule_render", schedule, || {
        RenderSchedule::from(schedule)
            .after_render_scheduled()
            .into()
    })
}

/// Asset switch or teardown: everything in flight becomes stale.
#[no_mangle]
pub extern "C" fn maple_canvas_render_schedule_cancel_all(
    schedule: MapleCanvasRenderSchedule,
) -> MapleCanvasRenderSchedule {
    crate::error::catch_panic("maple_canvas_render_schedule_cancel_all", schedule, || {
        RenderSchedule::from(schedule).after_cancel_all().into()
    })
}

/// 1 when a refine may be scheduled; `has_expected_generation` = 0 means
/// the refine carries no expected generation and is always admitted.
#[no_mangle]
pub extern "C" fn maple_canvas_render_schedule_admits_refine(
    schedule: MapleCanvasRenderSchedule,
    has_expected_generation: u8,
    expected_generation: u64,
) -> u8 {
    crate::error::catch_panic("maple_canvas_render_schedule_admits_refine", 0, || {
        let expected = (has_expected_generation != 0).then_some(expected_generation);
        u8::from(RenderSchedule::from(schedule).admits_refine(expected))
    })
}

/// 1 when work started at `generation` may still publish.
#[no_mangle]
pub extern "C" fn maple_canvas_render_schedule_is_current(
    schedule: MapleCanvasRenderSchedule,
    generation: u64,
) -> u8 {
    crate::error::catch_panic("maple_canvas_render_schedule_is_current", 0, || {
        u8::from(RenderSchedule::from(schedule).is_current(generation))
    })
}

/// 1 when the refine should try the native-detail patch first.
#[no_mangle]
pub extern "C" fn maple_canvas_refine_tries_native_detail(context: MapleCanvasRefineContext) -> u8 {
    crate::error::catch_panic("maple_canvas_refine_tries_native_detail", 0, || {
        u8::from(canvas::refine_tries_native_detail(RefineContext {
            crop_applied: context.crop_applied != 0,
            is_raw: context.is_raw != 0,
            has_source_file: context.has_source_file != 0,
            pixel_scale: context.pixel_scale,
            visible_rect: context.visible_rect.into(),
            image_size: context.image_size.into(),
        }))
    })
}

/// 1 when the whole-image refine would render no larger than the fast pass
/// (within a pixel per axis). Each `has_*` flag marks its target as known.
#[no_mangle]
pub extern "C" fn maple_canvas_refine_matches_fast_target(
    has_fast_target: u8,
    fast_target: MapleCanvasSize,
    has_refined_target: u8,
    refined_target: MapleCanvasSize,
) -> u8 {
    crate::error::catch_panic("maple_canvas_refine_matches_fast_target", 0, || {
        u8::from(canvas::refine_matches_fast_target(
            (has_fast_target != 0).then(|| fast_target.into()),
            (has_refined_target != 0).then(|| refined_target.into()),
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schedule_transitions_round_trip_the_generation() {
        let first = maple_canvas_render_schedule_render(MapleCanvasRenderSchedule::default());
        assert_eq!(first.generation, 1);
        assert_eq!(maple_canvas_render_schedule_is_current(first, 1), 1);
        let cancelled = maple_canvas_render_schedule_cancel_all(first);
        assert_eq!(maple_canvas_render_schedule_is_current(cancelled, 1), 0);
        assert_eq!(
            maple_canvas_render_schedule_admits_refine(cancelled, 1, 1),
            0
        );
        assert_eq!(
            maple_canvas_render_schedule_admits_refine(cancelled, 1, 2),
            1
        );
        assert_eq!(
            maple_canvas_render_schedule_admits_refine(cancelled, 0, 99),
            1
        );
        assert_eq!(maple_canvas_refine_debounce_ms(), 150);
    }

    #[test]
    fn refine_route_flags_match_the_core() {
        let context = MapleCanvasRefineContext {
            crop_applied: 0,
            is_raw: 1,
            has_source_file: 1,
            pixel_scale: 1.0,
            visible_rect: MapleCanvasRect {
                x: 0.0,
                y: 0.0,
                width: 800.0,
                height: 600.0,
            },
            image_size: MapleCanvasSize {
                width: 6000.0,
                height: 4000.0,
            },
        };
        assert_eq!(maple_canvas_refine_tries_native_detail(context), 1);
        assert_eq!(
            maple_canvas_refine_tries_native_detail(MapleCanvasRefineContext {
                crop_applied: 2,
                ..context
            }),
            0
        );
        let fast = MapleCanvasSize {
            width: 1000.0,
            height: 800.0,
        };
        assert_eq!(maple_canvas_refine_matches_fast_target(1, fast, 1, fast), 1);
        assert_eq!(maple_canvas_refine_matches_fast_target(0, fast, 1, fast), 0);
    }
}
