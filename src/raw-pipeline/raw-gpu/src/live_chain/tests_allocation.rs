//! Test-only host allocation accounting; GPU pool counters cannot detect a
//! per-frame memcpy of the 49³ Auto Profile lattice. Counts only this test
//! thread's >=64 KiB allocations, independent of other concurrent GPU tests.
use super::*;
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

thread_local! {
    static ENABLED: Cell<bool> = const { Cell::new(false) };
    static LARGE: Cell<usize> = const { Cell::new(0) };
}

struct CountingAllocator;

fn record(size: usize) {
    if size >= 64 * 1024 && ENABLED.try_with(Cell::get).unwrap_or(false) {
        let _ = LARGE.try_with(|count| count.set(count.get() + 1));
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
