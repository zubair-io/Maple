//! Test-only host allocation accounting; GPU pool counters cannot detect a
//! per-frame memcpy of the 49³ Auto Profile lattice. Counts only this test
//! thread's >=64 KiB allocations, independent of other concurrent GPU tests.
use super::*;
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

thread_local! {
    static ENABLED: Cell<bool> = const { Cell::new(false) };
    static LARGE: Cell<usize> = const { Cell::new(0) };
    static ALL: Cell<usize> = const { Cell::new(0) };
}

struct CountingAllocator;

fn record(size: usize) {
    if ENABLED.try_with(Cell::get).unwrap_or(false) {
        let _ = ALL.try_with(|count| count.set(count.get() + 1));
        if size >= 64 * 1024 {
            let _ = LARGE.try_with(|count| count.set(count.get() + 1));
        }
    }
}

unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record(layout.size());
        System.alloc(layout)
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        System.dealloc(pointer, layout);
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        record(layout.size());
        System.alloc_zeroed(layout)
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        record(size);
        System.realloc(pointer, layout, size)
    }
}

#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

#[test]
fn sorted_curve_capacity_checks_do_not_allocate() {
    let duplicates = vec![(0.5, 0.6); 100];
    let oversized: Vec<_> = (0..40).map(|i| (i as f32 / 39.0, 0.5)).collect();
    ALL.with(|count| count.set(0));
    large_allocations(|| {
        assert!(crate::point_curve_fits_gpu(&duplicates));
        assert!(!crate::point_curve_fits_gpu(&oversized));
    });
    assert_eq!(ALL.with(Cell::get), 0);
}

pub(crate) fn large_allocations(operation: impl FnOnce()) -> usize {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            ENABLED.with(|enabled| enabled.set(false));
        }
    }
    LARGE.with(|count| count.set(0));
    ENABLED.with(|enabled| enabled.set(true));
    let reset = Reset;
    operation();
    drop(reset);
    LARGE.with(Cell::get)
}

#[test]
fn live_chain_never_clones_large_immutable_lattices() {
    let probe = large_allocations(|| {
        let buffer = vec![1u8; 128 * 1024];
        std::hint::black_box(buffer);
    });
    assert!(
        probe > 0,
        "allocation instrumentation must observe real allocations"
    );
    let case = neutral_case();
    let mut inputs = case.gpu_inputs();
    inputs.residual_lut_size = 49;
    inputs.residual_lut_data = raw_core::view::auto_profile::lut::ColorLut::identity(49)
        .data
        .into();
    inputs.film_lut_size = 33;
    inputs.film_lut_data = raw_core::view::auto_profile::lut::ColorLut::identity(33)
        .data
        .into();
    inputs.film_lut_key = 1;
    inputs.film_strength = 50.0;
    for frame in 0..40 {
        inputs.tone[0] = frame as f32 / 10.0;
        assert_eq!(
            large_allocations(|| {
                let passes = build_live_chain(&inputs, AirlightSource::OnGpu);
                std::hint::black_box(passes);
            }),
            0,
            "frame {frame} copied a per-image LUT"
        );
    }
}

#[test]
fn immediate_pass_construction_does_not_allocate_pass_boxes_or_lists() {
    struct Sink(usize);
    impl<'a> crate::live_chain::LivePassSink<'a> for Sink {
        fn push<T: crate::Pass + 'a>(&mut self, pass: T) {
            std::hint::black_box(&pass);
            self.0 += 1;
        }
    }
    let case = neutral_case();
    let mut inputs = case.gpu_inputs();
    inputs.tone[0] = 1.0;
    inputs.vibrance = 25.0;
    inputs.saturation = 10.0;
    inputs.clarity = 15.0;
    inputs.texture = 20.0;
    inputs.dehaze = 10.0;
    inputs.sharpen_amount = 40.0;
    inputs.nr_luminance = 20.0;
    inputs.nr_color = 25.0;
    inputs.noise_profile = vec![0.001, 0.0001, 0.002, 0.0002, 0.003, 0.0003];
    inputs.iso = 1600;
    let knots = vec![(0.0, 0.0), (0.4, 0.5), (1.0, 1.0)];
    inputs.tone_curves.luma = knots.clone();
    inputs.tone_curves.red = knots.clone();
    inputs.tone_curves.green = knots.clone();
    inputs.tone_curves.blue = knots.clone();
    inputs.display_tone_curves.master = knots.clone();
    inputs.display_tone_curves.red = knots.clone();
    inputs.display_tone_curves.green = knots.clone();
    inputs.display_tone_curves.blue = knots;
    let boxed = build_live_chain(&inputs, AirlightSource::OnGpu);
    let mut sink = Sink(0);
    ALL.with(|count| count.set(0));
    large_allocations(|| {
        crate::live_chain::visit_live_chain(&inputs, AirlightSource::OnGpu, &mut sink);
    });
    assert_eq!(
        sink.0,
        boxed.len(),
        "same gates must construct the same passes"
    );
    assert!(sink.0 > 8, "allocation probe must cover engaged stages");
    assert_eq!(ALL.with(Cell::get), 0);
    ALL.with(|count| count.set(0));
    large_allocations(|| {
        std::hint::black_box(build_live_chain(&inputs, AirlightSource::OnGpu));
    });
    assert!(
        ALL.with(Cell::get) > 0,
        "probe must observe the old boxed path"
    );
}
