//! Count host allocations on the calling test thread only (GPU drivers excluded).
use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
};
thread_local! { static COUNT: Cell<Option<usize>> = const { Cell::new(None) }; }
struct Counter;
#[global_allocator]
static ALLOCATOR: Counter = Counter;
unsafe impl GlobalAlloc for Counter {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let _ = COUNT.try_with(|c| c.set(c.get().map(|n| n + 1)));
        System.alloc(layout)
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let _ = COUNT.try_with(|c| c.set(c.get().map(|n| n + 1)));
        System.alloc_zeroed(layout)
    }
    unsafe fn realloc(&self, p: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        let _ = COUNT.try_with(|c| c.set(c.get().map(|n| n + 1)));
        System.realloc(p, layout, size)
    }
    unsafe fn dealloc(&self, p: *mut u8, layout: Layout) {
        System.dealloc(p, layout);
    }
}
pub fn count(f: impl FnOnce()) -> usize {
    COUNT.with(|c| c.set(Some(0)));
    f();
    COUNT.with(|c| c.replace(None).unwrap())
}
