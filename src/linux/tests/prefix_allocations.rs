//! Allocation qualification of the production borrowed prefix detector (#4317).
use raw_core::{
    gpu_host::prefix::{prefix_matches, stripped_prefix_model},
    types::{adjustment::AutoExposureMode, AdjustmentModel, ToneCurve},
};
use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
};

thread_local! {
    static ACTIVE: Cell<bool> = const { Cell::new(false) };
    static ALLOCATIONS: Cell<usize> = const { Cell::new(0) };
}
struct Counting;
fn count() {
    let _ = ACTIVE.try_with(|active| {
        if active.get() {
            let _ = ALLOCATIONS.try_with(|count| count.set(count.get() + 1));
        }
    });
}
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        count();
        System.alloc(layout)
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout);
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        count();
        System.realloc(ptr, layout, size)
    }
}
#[global_allocator]
static ALLOCATOR: Counting = Counting;

#[test]
fn borrowed_prefix_detection_allocates_nothing_with_owned_curves_and_metadata() {
    let curve = ToneCurve {
        points: vec![(0.0, 0.0), (0.5, 0.6), (1.0, 1.0)],
    };
    let mut model = AdjustmentModel {
        tone_curve_luma: curve.clone(),
        tone_curve_red: curve.clone(),
        tone_curve_green: curve.clone(),
        tone_curve_blue: curve.clone(),
        display_tone_curve_luma: curve.clone(),
        display_tone_curve_red: curve.clone(),
        display_tone_curve_green: curve.clone(),
        display_tone_curve_blue: curve,
        lens_profile: "lcp1:retained-metadata".repeat(64),
        ..Default::default()
    };
    let cached = stripped_prefix_model(&model, AutoExposureMode::Off);
    ALLOCATIONS.with(|count| count.set(0));
    ACTIVE.with(|active| active.set(true));
    for tick in 0..1000 {
        model.exposure = tick as f32 / 100.0;
        assert!(prefix_matches(&model, &cached, AutoExposureMode::Off));
    }
    ACTIVE.with(|active| active.set(false));
    assert_eq!(ALLOCATIONS.with(Cell::get), 0);
}
